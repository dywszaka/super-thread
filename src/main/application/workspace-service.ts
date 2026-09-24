import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AddProjectInput,
  AddRemoteDeviceInput,
  AppSnapshot,
  BrowseDirectoryInput,
  CreateSessionResult,
  CreateSessionInput,
  CreateWorkThreadInput,
  CreateWorkspaceInput,
  Device,
  DeviceConnection,
  DirectoryListing,
  Project,
  ReorderSessionsInput,
  RenameSessionInput,
  Session,
  SessionActivityStatus,
  SessionKind,
  SetupProjectInput,
  TerminalReplay,
  UpdateProjectInput,
  UpdateRemoteDeviceInput,
  WorkThread,
  Workspace
} from "../../shared/domain";
import { JsonStore } from "../persistence/json-store";
import { DeviceCommandRunner, type CommandRunner } from "../runtime/command-runner";
import { DirectoryRuntime } from "../runtime/directory-runtime";
import { GitRuntime, type RepositoryInfo } from "../runtime/git-runtime";
import { SshTunnelSupervisor } from "../runtime/ssh-tunnel-supervisor";
import { legacyTmuxClientSessionName, TerminalRuntime, tmuxTarget, tmuxWindowLookupCommand, type TerminalActivityEvent, type TerminalCodexConversationEvent, type TerminalExitEvent } from "../runtime/terminal-runtime";
import { interactiveLoginShellCommand, quoteShellArgument } from "../runtime/login-shell";

const id = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 8)}`;
const now = (): string => new Date().toISOString();
const canonicalRemote = (remote: string): string => remote.trim().replace(/\.git$/, "").replace(/^ssh:\/\//, "").toLowerCase();
const canonicalName = (name: string): string => name.trim().toLowerCase();
const unsafeProjectName = (name: string): string | null => {
  const trimmed = name.trim();
  if (!trimmed) return "Project name is required";
  if (trimmed.length > 80) return "Project name must be 80 characters or fewer";
  if (trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) return "Project name cannot contain path separators or reserved directory names";
  return null;
};
const repositoryNameFromUrl = (repositoryUrl: string): string => repositoryUrl.trim().split(/[/:]/).at(-1)?.replace(/\.git$/, "") || "repository";

export function tmuxSessionBaseName(workspaceName: string): string {
  return workspaceName.trim().replace(/[.:]/g, "-") || "workspace";
}

export function nextTmuxSessionName(baseName: string, occupied: Iterable<string>): string {
  const names = new Set(occupied);
  if (!names.has(baseName)) return baseName;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseName}-${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
}

export interface WorkspaceGitRuntime {
  inspect(repositoryPath: string): Promise<RepositoryInfo>;
  clone(repositoryUrl: string, parentDirectory: string): Promise<RepositoryInfo>;
  createWorktree(checkoutPath: string, projectName: string, workspaceName: string, baseBranch: string): Promise<{ path: string; branch: string }>;
  inspectWorkspaceDeleteRisk(checkoutPath: string, workspacePath: string, branch: string, baseBranch: string): Promise<WorkspaceDeleteRisk>;
  deleteWorktree(checkoutPath: string, workspacePath: string, branch: string, force: boolean): Promise<void>;
}

export interface WorkspaceDeleteRisk {
  hasUncommittedChanges: boolean;
  hasUntrackedFiles: boolean;
  unmergedCommitCount: number;
}

export interface WorkspaceDirectoryRuntime {
  list(path?: string): Promise<DirectoryListing>;
}

export interface DeviceTunnelRuntime {
  sync(connections: DeviceConnection[]): void;
  reconnectAll(): void;
  stop(): void;
}

type GitRuntimeFactory = (device: Device, connection: DeviceConnection) => WorkspaceGitRuntime;
type DirectoryRuntimeFactory = (device: Device, connection: DeviceConnection) => WorkspaceDirectoryRuntime;
type CommandRunnerFactory = (connection: DeviceConnection) => CommandRunner;

export class WorkspaceService extends EventEmitter {
  private readonly pendingSessionCreations = new Map<string, Promise<CreateSessionResult>>();
  private readonly closingSessionIds = new Set<string>();
  private readonly autoRestoredCodexSessionIds = new Set<string>();

  constructor(
    private readonly store: JsonStore,
    private readonly terminals = new TerminalRuntime(),
    private readonly gitRuntimeFactory: GitRuntimeFactory = (device, connection) => new GitRuntime(device, connection),
    private readonly directoryRuntimeFactory: DirectoryRuntimeFactory = (device, connection) => new DirectoryRuntime(device, connection),
    private readonly tunnels: DeviceTunnelRuntime = new SshTunnelSupervisor(),
    private readonly commandRunnerFactory: CommandRunnerFactory = (connection) => new DeviceCommandRunner(connection)
  ) {
    super();
    terminals.on("output", (event) => this.emit("terminal-output", event));
    terminals.on("activity", (event: TerminalActivityEvent) => void this.markSessionActivity(event));
    terminals.on("codex-conversation", (event: TerminalCodexConversationEvent) => void this.recordCodexConversation(event));
    terminals.on("exit", (event: TerminalExitEvent) => void this.markSessionExited(event.sessionId, event.exitCode));
  }

  async initialize(): Promise<void> {
    await this.store.load();
    await this.store.update((draft) => {
      const local = draft.devices.find((device) => device.type === "local");
      if (!local) {
        const deviceId = "dev_local";
        draft.devices.push({ id: deviceId, name: hostname(), type: "local", status: "online", createdAt: now() });
        draft.connections.push({ deviceId, transport: "local", config: {} });
      } else {
        local.status = "online";
      }
      for (const session of draft.sessions) {
        session.kind ??= "shell";
        session.order ??= draft.sessions.filter((item) => item.workspaceId === session.workspaceId).indexOf(session);
        if (session.status === "running") session.activityStatus ??= "idle";
        if (session.status === "running" && !this.terminals.has(session.id)) {
          session.pid = undefined;
          session.exitReason = "runtime-stopped";
        }
      }
    });
    this.tunnels.sync(this.snapshot().connections);
    await this.restoreInterruptedSessions();
  }

  snapshot(): AppSnapshot { return this.store.snapshot(); }

  async addDevice(input: AddRemoteDeviceInput): Promise<void> {
    const deviceId = id("dev");
    await this.store.update((draft) => {
      draft.devices.push({ id: deviceId, name: input.name, type: "remote", status: "unknown", createdAt: now() });
      draft.connections.push({
        deviceId,
        transport: "ssh",
        config: {
          host: input.host,
          user: input.user,
          port: input.port,
          ...(input.tunnels?.length ? { tunnels: input.tunnels } : {})
        }
      });
    });
    this.tunnels.sync(this.snapshot().connections);
    await this.pingDevices();
  }

  async updateDevice(input: UpdateRemoteDeviceInput): Promise<void> {
    const snapshot = this.snapshot();
    const device = this.device(snapshot, input.id);
    if (device.type === "local") throw new Error("The local device is managed by SuperThread");
    const currentConnection = this.connection(snapshot, input.id);
    const tunnelConfig = input.tunnels ?? currentConnection.config.tunnels;
    await this.store.update((draft) => {
      const item = draft.devices.find((candidate) => candidate.id === input.id);
      const connection = draft.connections.find((candidate) => candidate.deviceId === input.id);
      if (item) Object.assign(item, { name: input.name, status: "unknown" });
      if (connection) Object.assign(connection, {
        transport: "ssh",
        config: {
          host: input.host,
          user: input.user,
          port: input.port,
          ...(tunnelConfig !== undefined ? { tunnels: tunnelConfig } : {})
        }
      });
    });
    this.tunnels.sync(this.snapshot().connections);
    this.changed();
  }

  async deleteDevice(deviceId: string): Promise<void> {
    const snapshot = this.snapshot();
    const device = this.device(snapshot, deviceId);
    if (device.type === "local") throw new Error("The local device cannot be deleted");
    if (snapshot.checkouts.some((checkout) => checkout.deviceId === deviceId) || snapshot.workspaces.some((workspace) => workspace.deviceId === deviceId)) {
      throw new Error("Remove this device’s project checkouts and workspaces before deleting it");
    }
    await this.store.update((draft) => {
      draft.connections = draft.connections.filter((connection) => connection.deviceId !== deviceId);
      draft.devices = draft.devices.filter((item) => item.id !== deviceId);
    });
    this.tunnels.sync(this.snapshot().connections);
    this.changed();
  }

  async pingDevices(): Promise<AppSnapshot> {
    const snapshot = this.snapshot();
    const statuses = await Promise.all(snapshot.devices.map(async (device) => {
      if (device.type === "local") return [device.id, "online"] as const;
      const connection = this.connection(snapshot, device.id);
      try {
        await new DeviceCommandRunner(connection).run("true", [], { timeoutMs: 8_000 });
        return [device.id, "online"] as const;
      } catch { return [device.id, "offline"] as const; }
    }));
    const statusMap = new Map(statuses);
    const result = await this.store.update((draft) => {
      for (const device of draft.devices) device.status = statusMap.get(device.id) ?? "unknown";
    });
    this.changed();
    return result;
  }

  async browseDirectory(input: BrowseDirectoryInput): Promise<DirectoryListing> {
    const snapshot = this.snapshot();
    const device = this.device(snapshot, input.deviceId);
    try {
      return await this.directory(snapshot, device).list(input.path);
    } catch (error) {
      throw new Error(`Unable to list directories on ${device.name}: ${this.message(error)}`);
    }
  }

  async addProject(input: AddProjectInput): Promise<void> {
    const snapshot = this.snapshot();
    const requestedName = input.projectName?.trim();
    if (input.mode === "import") {
      const device = this.device(snapshot, input.deviceId);
      const info = await this.git(snapshot, device).inspect(input.path);
      await this.recordProjectAndCheckout(info, device.id, requestedName);
      return;
    }
    const device = this.localDevice(snapshot);
    const existing = snapshot.projects.find((project) => canonicalRemote(project.repositoryUrl) === canonicalRemote(input.repositoryUrl));
    if (existing && snapshot.checkouts.some((item) => item.projectId === existing.id && item.deviceId === device.id)) {
      throw new Error(`${existing.name} is already imported on this device`);
    }
    if (!existing) this.assertProjectNameAvailable(snapshot, requestedName || repositoryNameFromUrl(input.repositoryUrl));
    const info = await this.git(snapshot, device).clone(input.repositoryUrl, input.parentDirectory);
    await this.recordProjectAndCheckout(info, device.id, requestedName);
  }

  async updateProject(input: UpdateProjectInput): Promise<void> {
    const snapshot = this.snapshot();
    const project = this.project(snapshot, input.id);
    const name = input.name.trim();
    const unsafe = unsafeProjectName(name);
    if (unsafe) throw new Error(unsafe);
    if (snapshot.projects.some((item) => item.id !== project.id && canonicalName(item.name) === canonicalName(name))) {
      throw new Error(`A project named ${name} already exists`);
    }
    await this.store.update((draft) => {
      const item = draft.projects.find((candidate) => candidate.id === project.id);
      if (item) Object.assign(item, { name, updatedAt: now() });
    });
    this.changed();
  }

  async deleteProject(projectId: string): Promise<void> {
    const snapshot = this.snapshot();
    this.project(snapshot, projectId);
    if (snapshot.workspaces.some((workspace) => workspace.projectId === projectId)) {
      throw new Error("Remove this project’s workspaces before deleting it");
    }
    await this.store.update((draft) => {
      draft.checkouts = draft.checkouts.filter((checkout) => checkout.projectId !== projectId);
      draft.projects = draft.projects.filter((project) => project.id !== projectId);
    });
    this.changed();
  }

  async setupProject(input: SetupProjectInput): Promise<void> {
    const snapshot = this.snapshot();
    const project = this.project(snapshot, input.projectId);
    const device = this.device(snapshot, input.deviceId);
    if (snapshot.checkouts.some((item) => item.projectId === project.id && item.deviceId === device.id)) {
      throw new Error(`${project.name} is already set up on ${device.name}`);
    }
    if (input.mode === "clone" && device.type !== "local") {
      throw new Error("Clone is only available on the local device. Import an existing repository on remote devices.");
    }
    const runtime = this.git(snapshot, device);
    const info = input.mode === "import"
      ? await runtime.inspect(input.path)
      : await runtime.clone(project.repositoryUrl, input.parentDirectory);
    if (canonicalRemote(info.remote) !== canonicalRemote(project.repositoryUrl)) {
      throw new Error("The selected repository does not match this project’s origin remote");
    }
    await this.store.update((draft) => {
      draft.checkouts.push({ id: id("checkout"), projectId: project.id, deviceId: device.id, path: info.root, createdAt: now() });
    });
    this.changed();
  }

  async createWorkThread(input: CreateWorkThreadInput): Promise<void> {
    const name = input.name.trim();
    const snapshot = this.snapshot();
    if (snapshot.workThreads.some((item) => canonicalName(item.name) === canonicalName(name))) {
      throw new Error(`A work thread named ${name} already exists`);
    }
    const timestamp = now();
    await this.store.update((draft) => {
      draft.workThreads.push({
        id: id("thread"),
        name,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp
      });
    });
    this.changed();
  }

  async archiveWorkThread(workThreadId: string): Promise<void> {
    const workThread = this.workThread(this.snapshot(), workThreadId);
    if (workThread.status === "archived") return;
    const timestamp = now();
    await this.store.update((draft) => {
      const item = draft.workThreads.find((candidate) => candidate.id === workThreadId);
      if (item) Object.assign(item, { status: "archived", archivedAt: timestamp, updatedAt: timestamp });
    });
    this.changed();
  }

  async restoreWorkThread(workThreadId: string): Promise<void> {
    const workThread = this.workThread(this.snapshot(), workThreadId);
    if (workThread.status === "active") return;
    await this.store.update((draft) => {
      const item = draft.workThreads.find((candidate) => candidate.id === workThreadId);
      if (item) {
        item.status = "active";
        item.updatedAt = now();
        item.archivedAt = undefined;
      }
    });
    this.changed();
  }

  async deleteWorkThread(workThreadId: string): Promise<void> {
    const snapshot = this.snapshot();
    this.workThread(snapshot, workThreadId);
    if (snapshot.workspaces.some((workspace) => workspace.workThreadId === workThreadId)) {
      throw new Error("Remove every workspace from this work thread before deleting it");
    }
    await this.store.update((draft) => {
      draft.workThreads = draft.workThreads.filter((item) => item.id !== workThreadId);
    });
    this.changed();
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<void> {
    const snapshot = this.snapshot();
    const workThread = this.workThread(snapshot, input.workThreadId);
    if (workThread.status !== "active") throw new Error("Work thread is archived. Restore it before adding a workspace.");
    const device = this.device(snapshot, input.deviceId);
    const project = this.project(snapshot, input.projectId);
    this.assertProjectNameUsableForWorkspace(snapshot, project);
    const checkout = snapshot.checkouts.find((item) => item.projectId === input.projectId && item.deviceId === input.deviceId);
    if (!checkout) throw new Error("Project is not set up on the selected device");
    if (snapshot.workspaces.some((item) => item.deviceId === input.deviceId && item.name === input.name)) {
      throw new Error(`A workspace named ${input.name} already exists on ${device.name}`);
    }
    const workspaceId = id("ws");
    const timestamp = now();
    const pending: Workspace = {
      id: workspaceId, name: input.name, workThreadId: workThread.id, projectId: input.projectId, deviceId: input.deviceId,
      checkoutId: checkout.id, path: "", branch: `work/${input.name}`, baseBranch: input.baseBranch,
      status: "creating", createdAt: timestamp, updatedAt: timestamp
    };
    await this.store.update((draft) => {
      draft.workspaces.push(pending);
      const thread = draft.workThreads.find((item) => item.id === workThread.id);
      if (thread) thread.updatedAt = timestamp;
    });
    this.changed();
    const runtime = this.git(snapshot, device);
    let created: { path: string; branch: string };
    try {
      created = await runtime.createWorktree(checkout.path, project.name, input.name, input.baseBranch);
    } catch (error) {
      await this.removeWorkspaceMetadata(workspaceId, workThread.id);
      throw error;
    }
    try {
      await this.store.update((draft) => {
        const workspace = draft.workspaces.find((item) => item.id === workspaceId);
        if (workspace) Object.assign(workspace, created, { status: "ready", updatedAt: now(), error: undefined });
      });
      await this.createSession({ workspaceId, name: "Terminal 1" });
    } catch (error) {
      try {
        await runtime.deleteWorktree(checkout.path, created.path, created.branch, true);
        await this.removeWorkspaceMetadata(workspaceId, workThread.id);
      } catch (rollbackError) {
        await this.store.update((draft) => {
          const workspace = draft.workspaces.find((item) => item.id === workspaceId);
          if (workspace) Object.assign(workspace, created, {
            status: "error",
            error: `${this.message(error)}. Automatic worktree rollback failed: ${this.message(rollbackError)}`,
            updatedAt: now()
          });
        });
        this.changed();
      }
      throw error;
    }
  }

  async deleteWorkspace(workspaceId: string, force = false): Promise<void> {
    const snapshot = this.snapshot();
    const workspace = this.workspace(snapshot, workspaceId);
    if (workspace.status === "error" && !workspace.path) {
      for (const session of snapshot.sessions.filter((item) => item.workspaceId === workspaceId && item.status === "running")) {
        this.terminals.kill(session.id);
      }
      await this.removeWorkspaceMetadata(workspaceId, workspace.workThreadId);
      return;
    }
    const checkout = snapshot.checkouts.find((item) => item.id === workspace.checkoutId);
    if (!checkout) throw new Error("Base checkout no longer exists");
    const device = this.device(snapshot, workspace.deviceId);
    const runtime = this.git(snapshot, device);
    const risk = await runtime.inspectWorkspaceDeleteRisk(checkout.path, workspace.path, workspace.branch, workspace.baseBranch);
    if (!force) {
      const messages = this.workspaceDeleteRisks(risk);
      if (messages.length) {
        throw new Error(`Workspace delete blocked: ${messages.join("; ")}. Confirm force delete to remove the worktree and branch.`);
      }
    }
    for (const session of snapshot.sessions.filter((item) => item.workspaceId === workspaceId && item.status === "running")) {
      this.terminals.kill(session.id);
    }
    await runtime.deleteWorktree(checkout.path, workspace.path, workspace.branch, force);
    await this.store.update((draft) => {
      draft.sessions = draft.sessions.filter((item) => item.workspaceId !== workspaceId);
      draft.workspaces = draft.workspaces.filter((item) => item.id !== workspaceId);
      const thread = draft.workThreads.find((item) => item.id === workspace.workThreadId);
      if (thread) thread.updatedAt = now();
    });
    this.changed();
  }

  private async removeWorkspaceMetadata(workspaceId: string, workThreadId: string): Promise<void> {
    await this.store.update((draft) => {
      draft.sessions = draft.sessions.filter((item) => item.workspaceId !== workspaceId);
      draft.workspaces = draft.workspaces.filter((item) => item.id !== workspaceId);
      const thread = draft.workThreads.find((item) => item.id === workThreadId);
      if (thread) thread.updatedAt = now();
    });
    this.changed();
  }

  createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const key = `${input.workspaceId}:${input.kind ?? "shell"}:${input.name?.trim() ?? ""}`;
    const pending = this.pendingSessionCreations.get(key);
    if (pending) return pending;
    const creation = this.createSessionOnce(input).finally(() => {
      if (this.pendingSessionCreations.get(key) === creation) this.pendingSessionCreations.delete(key);
    });
    this.pendingSessionCreations.set(key, creation);
    return creation;
  }

  private async createSessionOnce(input: CreateSessionInput): Promise<CreateSessionResult> {
    const snapshot = this.snapshot();
    const workspace = this.workspace(snapshot, input.workspaceId);
    if (workspace.status !== "ready") throw new Error("Workspace is not ready");
    const device = this.device(snapshot, workspace.deviceId);
    const connection = this.connection(snapshot, device.id);
    const count = snapshot.sessions.filter((item) => item.workspaceId === workspace.id).length;
    const requestedKind = input.kind ?? "shell";
    const { kind, warning } = await this.resolveSessionKind(snapshot, workspace, device, requestedKind);
    const tmuxSessionName = kind === "tmux"
      ? await this.resolveTmuxSessionName(snapshot, workspace, device)
      : undefined;
    const timestamp = now();
    const sessionId = id("session");
    const session: Session = {
      id: sessionId,
      workspaceId: workspace.id,
      name: input.name || this.defaultSessionName(kind, count + 1),
      status: "running",
      kind,
      order: this.nextSessionOrder(snapshot, workspace.id),
      shell: this.sessionShellLabel(kind, device),
      cwd: workspace.path,
      activityStatus: "idle",
      ...(kind === "tmux" ? {
        tmuxSessionName,
        tmuxWindowKey: sessionId
      } : {}),
      ...(warning ? { fallbackMessage: warning } : {}),
      createdAt: timestamp
    };
    const pid = this.terminals.create(session, workspace, device, connection);
    let created: Session | undefined;
    await this.store.update((draft) => {
      created = { ...session, pid };
      draft.sessions.push(created);
      if (tmuxSessionName) {
        const currentWorkspace = draft.workspaces.find((item) => item.id === workspace.id);
        if (currentWorkspace) currentWorkspace.tmuxSessionName = tmuxSessionName;
      }
    });
    this.changed();
    return { session: created ?? { ...session, pid }, warning };
  }

  async resumeSession(sessionId: string): Promise<void> {
    const snapshot = this.snapshot();
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("Terminal session not found");
    if (session.status !== "exited" && session.status !== "restore-failed") throw new Error("Only an exited or failed terminal session can be resumed");
    if (this.terminals.has(session.id)) throw new Error("Terminal session is already running");
    const workspace = this.workspace(snapshot, session.workspaceId);
    if (workspace.status !== "ready") throw new Error("Workspace is not ready");
    const device = this.device(snapshot, workspace.deviceId);
    const connection = this.connection(snapshot, device.id);
    const restored = {
      ...session,
      cwd: session.cwd || workspace.path,
      activityStatus: (session.resultUnread ? "waiting-input" : "idle") as SessionActivityStatus
    };
    let pid: number;
    try {
      pid = this.terminals.create(restored, workspace, device, connection);
    } catch (error) {
      await this.store.update((draft) => {
        const current = draft.sessions.find((item) => item.id === sessionId);
        if (!current) throw new Error("Terminal session not found");
        Object.assign(current, {
          status: "restore-failed",
          pid: undefined,
          activityStatus: undefined,
          exitReason: "restore-failed",
          restoreError: this.message(error),
          exitedAt: now()
        });
      });
      this.changed();
      throw error;
    }
    await this.store.update((draft) => {
      const current = draft.sessions.find((item) => item.id === sessionId);
      if (!current) throw new Error("Terminal session not found");
      Object.assign(current, {
        status: "running",
        pid,
        cwd: restored.cwd,
        activityStatus: restored.activityStatus,
        restoredAt: now(),
        restoreError: undefined,
        exitReason: undefined,
        exitCode: undefined
      });
      delete current.exitedAt;
    });
    this.changed();
  }

  attachSession(id: string): TerminalReplay { return this.terminals.attach(id); }
  writeSession(id: string, data: string): void { this.terminals.write(id, data); }
  resizeSession(id: string, cols: number, rows: number): void { this.terminals.resize(id, cols, rows); }
  reconnectTunnels(): void {
    this.tunnels.reconnectAll();
    void this.restoreRecoverableCodexSessions();
  }
  runningSessionSummaries(): string[] {
    const snapshot = this.snapshot();
    return snapshot.sessions
      .filter((session) => session.status === "running" && session.activityStatus === "busy")
      .map((session) => {
        const workspace = snapshot.workspaces.find((item) => item.id === session.workspaceId);
        return `${workspace?.name ?? "Unknown workspace"} / ${session.name} (${session.kind ?? "shell"})`;
      });
  }
  shutdown(): void { this.tunnels.stop(); }
  async killSession(id: string, force = false): Promise<void> {
    const snapshot = this.snapshot();
    const session = snapshot.sessions.find((item) => item.id === id);
    if (!session) return;
    const hasOtherTmuxTerminals = snapshot.sessions.some((item) => item.id !== id && item.workspaceId === session.workspaceId && item.kind === "tmux");
    if (session.kind === "tmux" && session.status === "running" && session.activityStatus === "busy" && !force) {
      throw new Error(`This tmux terminal is running a task. Closing it will stop the task and delete its tmux ${hasOtherTmuxTerminals ? "window" : "session"}.`);
    }
    const running = this.terminals.has(id);
    this.closingSessionIds.add(id);
    try {
      if (session.kind === "tmux" && session.tmuxSessionName) await this.deleteTmuxTerminal(snapshot, session);
      await this.store.update((draft) => {
        draft.sessions = draft.sessions.filter((item) => item.id !== id);
        if (session.kind === "tmux" && !draft.sessions.some((item) => item.workspaceId === session.workspaceId && item.kind === "tmux")) {
          const workspace = draft.workspaces.find((item) => item.id === session.workspaceId);
          if (workspace) workspace.tmuxSessionName = undefined;
        }
      });
      this.changed();
      if (running) this.terminals.kill(id);
    } finally {
      this.closingSessionIds.delete(id);
    }
  }

  private async deleteTmuxTerminal(snapshot: AppSnapshot, session: Session): Promise<void> {
    const workspace = this.workspace(snapshot, session.workspaceId);
    const device = this.device(snapshot, workspace.deviceId);
    const runner = this.commandRunnerFactory(this.connection(snapshot, device.id));
    const target = session.tmuxWindowKey
      ? `"$(${tmuxWindowLookupCommand(session)})"`
      : quoteShellArgument(tmuxTarget(session));
    const workspaceSession = quoteShellArgument(session.tmuxSessionName || session.id);
    const clientSessions = [session.tmuxClientSessionName, legacyTmuxClientSessionName(session)]
      .filter((name): name is string => Boolean(name))
      .map((name) => `tmux kill-session -t ${quoteShellArgument(name)} 2>/dev/null || true`)
      .join("; ");
    const cleanupLegacyClients = clientSessions ? `${clientSessions}; ` : "";
    const command = session.tmuxWindowKey || session.tmuxWindowName
      ? `${cleanupLegacyClients}tmux kill-window -t ${target} 2>/dev/null || true`
      : `tmux kill-session -t ${workspaceSession} 2>/dev/null || true`;
    await runner.run("sh", ["-lc", interactiveLoginShellCommand(command)], { cwd: workspace.path, timeoutMs: 8_000 });
  }

  async reorderSessions(input: ReorderSessionsInput): Promise<void> {
    const snapshot = this.snapshot();
    this.workspace(snapshot, input.workspaceId);
    const expected = new Set(snapshot.sessions.filter((item) => item.workspaceId === input.workspaceId).map((item) => item.id));
    if (input.sessionIds.some((sessionId) => !expected.has(sessionId))) throw new Error("Session order contains a terminal outside this workspace");
    await this.store.update((draft) => {
      const order = new Map(input.sessionIds.map((sessionId, index) => [sessionId, index]));
      const remaining = draft.sessions.filter((item) => item.workspaceId === input.workspaceId && !order.has(item.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      for (const session of draft.sessions.filter((item) => item.workspaceId === input.workspaceId)) {
        session.order = order.get(session.id) ?? input.sessionIds.length + remaining.findIndex((item) => item.id === session.id);
      }
    });
    this.changed();
  }

  async markSessionViewed(sessionId: string): Promise<void> {
    await this.store.update((draft) => {
      const session = draft.sessions.find((item) => item.id === sessionId);
      if (session) {
        session.resultUnread = false;
        if (session.activityStatus === "waiting-input") session.activityStatus = "idle";
      }
    });
    this.changed();
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    const name = input.name.trim();
    const snapshot = this.snapshot();
    const current = snapshot.sessions.find((item) => item.id === input.id);
    if (!current) throw new Error("Terminal session not found");
    if (current.kind === "tmux") await this.renameTmuxWindow(snapshot, current, name);
    await this.store.update((draft) => {
      const session = draft.sessions.find((item) => item.id === input.id);
      if (!session) throw new Error("Terminal session not found");
      session.name = name;
    });
    this.changed();
  }

  private async renameTmuxWindow(snapshot: AppSnapshot, session: Session, name: string): Promise<void> {
    const workspace = this.workspace(snapshot, session.workspaceId);
    const device = this.device(snapshot, workspace.deviceId);
    const target = session.tmuxWindowKey
      ? `target=$(${tmuxWindowLookupCommand(session)}); test -n "$target"; tmux rename-window -t "$target" ${quoteShellArgument(name)}`
      : `tmux rename-window -t ${quoteShellArgument(tmuxTarget(session))} ${quoteShellArgument(name)}`;
    await this.commandRunnerFactory(this.connection(snapshot, device.id)).run(
      "sh",
      ["-lc", interactiveLoginShellCommand(target)],
      { cwd: workspace.path, timeoutMs: 8_000 }
    );
  }

  private async recordProjectAndCheckout(info: RepositoryInfo, deviceId: string, requestedName?: string): Promise<void> {
    const snapshot = this.snapshot();
    const existing = snapshot.projects.find((project) => canonicalRemote(project.repositoryUrl) === canonicalRemote(info.remote));
    if (existing && snapshot.checkouts.some((item) => item.projectId === existing.id && item.deviceId === deviceId)) {
      throw new Error(`${existing.name} is already imported on this device`);
    }
    const projectName = requestedName?.trim() || info.name;
    if (!existing) this.assertProjectNameAvailable(snapshot, projectName);
    await this.store.update((draft) => {
      let project: Project | undefined = draft.projects.find((item) => canonicalRemote(item.repositoryUrl) === canonicalRemote(info.remote));
      if (!project) {
        project = { id: id("proj"), name: projectName, repositoryUrl: info.remote, defaultBranch: info.defaultBranch, createdAt: now(), updatedAt: now() };
        draft.projects.push(project);
      }
      draft.checkouts.push({ id: id("checkout"), projectId: project.id, deviceId, path: info.root, createdAt: now() });
    });
    this.changed();
  }

  private assertProjectNameAvailable(snapshot: AppSnapshot, name: string): void {
    const unsafe = unsafeProjectName(name);
    if (unsafe) throw new Error(unsafe);
    if (snapshot.projects.some((project) => canonicalName(project.name) === canonicalName(name))) {
      throw new Error(`Project name conflict: A project named ${name.trim()} already exists. Enter a unique project name and retry.`);
    }
  }

  private assertProjectNameUsableForWorkspace(snapshot: AppSnapshot, project: Project): void {
    const unsafe = unsafeProjectName(project.name);
    if (unsafe) throw new Error(`Cannot create a workspace until project ${project.name} has a safe unique name: ${unsafe}`);
    if (snapshot.projects.some((item) => item.id !== project.id && canonicalName(item.name) === canonicalName(project.name))) {
      throw new Error(`Cannot create a workspace because multiple projects are named ${project.name}. Use a unique project name before creating new workspaces.`);
    }
  }

  private workspaceDeleteRisks(risk: WorkspaceDeleteRisk): string[] {
    const risks: string[] = [];
    if (risk.hasUncommittedChanges) risks.push("uncommitted changes");
    if (risk.hasUntrackedFiles) risks.push("untracked files");
    if (risk.unmergedCommitCount > 0) risks.push(`${risk.unmergedCommitCount} commit${risk.unmergedCommitCount === 1 ? "" : "s"} not merged into the base branch`);
    return risks;
  }

  private async restoreInterruptedSessions(): Promise<void> {
    const snapshot = this.snapshot();
    for (const session of snapshot.sessions.filter((item) => item.status === "running" && !this.terminals.has(item.id) && item.exitReason === "runtime-stopped")) {
      await this.restoreInterruptedSession(session.id);
    }
  }

  private async restoreRecoverableCodexSessions(): Promise<void> {
    const snapshot = this.snapshot();
    for (const session of snapshot.sessions.filter((item) => item.status === "restore-failed" && item.kind === "codex" && item.codexConversationId)) {
      try {
        await this.resumeSession(session.id);
      } catch {
        // Keep each failed Codex session isolated; users can still retry or start fresh.
      }
    }
  }

  private async restoreInterruptedSession(sessionId: string): Promise<void> {
    const snapshot = this.snapshot();
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    try {
      const workspace = this.workspace(snapshot, session.workspaceId);
      if (workspace.status !== "ready") throw new Error("Workspace is not ready");
      const device = this.device(snapshot, workspace.deviceId);
      const connection = this.connection(snapshot, device.id);
      const restored = { ...session, cwd: session.cwd || workspace.path, activityStatus: session.resultUnread ? "waiting-input" as const : "idle" as const };
      const pid = this.terminals.create(restored, workspace, device, connection);
      await this.store.update((draft) => {
        const current = draft.sessions.find((item) => item.id === sessionId);
        if (!current) return;
        Object.assign(current, {
          status: "running",
          pid,
          cwd: restored.cwd,
          activityStatus: restored.activityStatus,
          restoredAt: now(),
          restoreError: undefined,
          exitReason: undefined,
          exitCode: undefined
        });
        delete current.exitedAt;
      });
    } catch (error) {
      await this.store.update((draft) => {
        const current = draft.sessions.find((item) => item.id === sessionId);
        if (!current) return;
        Object.assign(current, {
          status: "restore-failed",
          pid: undefined,
          activityStatus: undefined,
          exitReason: "restore-failed",
          restoreError: this.message(error),
          exitedAt: now()
        });
      });
    }
    this.changed();
  }

  private async resolveSessionKind(snapshot: AppSnapshot, workspace: Workspace, device: Device, requestedKind: SessionKind): Promise<{ kind: SessionKind; warning?: string }> {
    if (requestedKind === "shell") return { kind: "shell" };
    const program = requestedKind === "codex" ? "codex" : "tmux";
    try {
      await this.commandRunnerFactory(this.connection(snapshot, device.id)).run(
        "sh",
        ["-lc", interactiveLoginShellCommand(`command -v ${program}`)],
        { cwd: workspace.path, timeoutMs: 8_000 }
      );
      return { kind: requestedKind };
    } catch {
      const warning = this.missingToolWarning(workspace.id, device, requestedKind);
      return { kind: "shell", warning };
    }
  }

  private async resolveTmuxSessionName(snapshot: AppSnapshot, workspace: Workspace, device: Device): Promise<string> {
    if (workspace.tmuxSessionName) return workspace.tmuxSessionName;
    const existingSessionName = snapshot.sessions.find((session) =>
      session.workspaceId === workspace.id && session.kind === "tmux" && session.tmuxSessionName
    )?.tmuxSessionName;
    if (existingSessionName) return existingSessionName;

    const reserved = snapshot.workspaces
      .filter((item) => item.deviceId === device.id && item.id !== workspace.id)
      .flatMap((item) => item.tmuxSessionName ? [item.tmuxSessionName] : []);
    try {
      const result = await this.commandRunnerFactory(this.connection(snapshot, device.id)).run(
        "sh",
        ["-lc", interactiveLoginShellCommand("tmux list-sessions -F '#{session_name}' 2>/dev/null || true")],
        { cwd: workspace.path, timeoutMs: 8_000 }
      );
      reserved.push(...result.stdout.split("\n").map((name) => name.trim()).filter(Boolean));
    } catch {
      // Availability was already checked. If listing races with tmux startup,
      // persisted workspace reservations still prevent app-owned collisions.
    }
    return nextTmuxSessionName(tmuxSessionBaseName(workspace.name), reserved);
  }

  private readonly tmuxMissingWarnings = new Set<string>();

  private missingToolWarning(workspaceId: string, device: Device, kind: Exclude<SessionKind, "shell">): string | undefined {
    if (kind === "tmux" && device.type === "remote") {
      if (this.tmuxMissingWarnings.has(workspaceId)) return undefined;
      this.tmuxMissingWarnings.add(workspaceId);
    }
    const tool = kind === "codex" ? "Codex CLI" : "tmux";
    return `${tool} is not available on ${device.name}; opened a normal terminal instead.`;
  }

  private defaultSessionName(kind: SessionKind, index: number): string {
    if (kind === "codex") return `Codex ${index}`;
    if (kind === "tmux") return `tmux ${index}`;
    return `Terminal ${index}`;
  }

  private sessionShellLabel(kind: SessionKind, device: Device): string {
    if (kind === "codex") return "codex";
    if (kind === "tmux") return "tmux";
    return device.type === "remote" ? "ssh" : process.env.SHELL || "/bin/zsh";
  }

  private nextSessionOrder(snapshot: AppSnapshot, workspaceId: string): number {
    const orders = snapshot.sessions.filter((item) => item.workspaceId === workspaceId).map((item) => item.order ?? 0);
    return orders.length ? Math.max(...orders) + 1 : 0;
  }

  private async markSessionActivity(event: TerminalActivityEvent): Promise<void> {
    if (this.closingSessionIds.has(event.sessionId)) return;
    await this.store.update((draft) => {
      const session = draft.sessions.find((item) => item.id === event.sessionId);
      if (session?.status !== "running") return;
      if (event.activityStatus === "busy") {
        session.activityStatus = "busy";
        session.resultUnread = false;
      } else if (event.resultReady) {
        session.resultUnread = true;
        session.activityStatus = "waiting-input";
      } else {
        session.activityStatus = session.resultUnread ? "waiting-input" : "idle";
      }
    });
    this.changed();
  }

  private async recordCodexConversation(event: TerminalCodexConversationEvent): Promise<void> {
    let recorded = false;
    await this.store.update((draft) => {
      const session = draft.sessions.find((item) => item.id === event.sessionId);
      if (session?.kind === "codex" && !session.codexConversationId) {
        session.codexConversationId = event.codexConversationId;
        recorded = true;
      }
    });
    if (recorded) this.changed();
  }

  private async markSessionExited(sessionId: string, exitCode?: number): Promise<void> {
    if (this.closingSessionIds.has(sessionId)) return;
    const sessionBeforeExit = this.snapshot().sessions.find((item) => item.id === sessionId);
    await this.store.update((draft) => {
      const session = draft.sessions.find((item) => item.id === sessionId);
      if (session) Object.assign(session, {
        status: "exited",
        exitedAt: now(),
        pid: undefined,
        activityStatus: undefined,
        exitReason: "process-exit",
        exitCode,
        resultUnread: exitCode === 0
      });
    });
    this.changed();
    if (sessionBeforeExit?.kind === "codex" && sessionBeforeExit.codexConversationId && exitCode !== 0 && !this.autoRestoredCodexSessionIds.has(sessionId)) {
      this.autoRestoredCodexSessionIds.add(sessionId);
      try {
        await this.resumeSession(sessionId);
      } catch {
        // resumeSession records restore-failed, preserving the retry/new-session UI path.
      }
    }
  }

  private git(snapshot: AppSnapshot, device: Device): WorkspaceGitRuntime { return this.gitRuntimeFactory(device, this.connection(snapshot, device.id)); }
  private directory(snapshot: AppSnapshot, device: Device): WorkspaceDirectoryRuntime {
    return this.directoryRuntimeFactory(device, this.connection(snapshot, device.id));
  }
  private localDevice(snapshot: AppSnapshot): Device {
    const value = snapshot.devices.find((item) => item.type === "local");
    if (!value) throw new Error("Local device is not available");
    return value;
  }
  private project(snapshot: AppSnapshot, projectId: string): Project {
    const value = snapshot.projects.find((item) => item.id === projectId);
    if (!value) throw new Error("Project not found");
    return value;
  }
  private device(snapshot: AppSnapshot, deviceId: string): Device {
    const value = snapshot.devices.find((item) => item.id === deviceId);
    if (!value) throw new Error("Device not found");
    return value;
  }
  private connection(snapshot: AppSnapshot, deviceId: string): DeviceConnection {
    const value = snapshot.connections.find((item) => item.deviceId === deviceId);
    if (!value) throw new Error("Device connection is not configured");
    return value;
  }
  private workThread(snapshot: AppSnapshot, workThreadId: string): WorkThread {
    const value = snapshot.workThreads.find((item) => item.id === workThreadId);
    if (!value) throw new Error("Work thread not found");
    return value;
  }
  private workspace(snapshot: AppSnapshot, workspaceId: string): Workspace {
    const value = snapshot.workspaces.find((item) => item.id === workspaceId);
    if (!value) throw new Error("Workspace not found");
    return value;
  }
  private changed(): void { this.emit("changed"); }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
