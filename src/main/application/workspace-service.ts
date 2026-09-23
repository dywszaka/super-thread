import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AddProjectInput,
  AddRemoteDeviceInput,
  AppSnapshot,
  BrowseDirectoryInput,
  CreateSessionInput,
  CreateWorkThreadInput,
  CreateWorkspaceInput,
  Device,
  DeviceConnection,
  DirectoryListing,
  Project,
  RenameSessionInput,
  SetupProjectInput,
  TerminalReplay,
  UpdateRemoteDeviceInput,
  WorkThread,
  Workspace
} from "../../shared/domain";
import { JsonStore } from "../persistence/json-store";
import { DeviceCommandRunner } from "../runtime/command-runner";
import { DirectoryRuntime } from "../runtime/directory-runtime";
import { GitRuntime, type RepositoryInfo } from "../runtime/git-runtime";
import { SshTunnelSupervisor } from "../runtime/ssh-tunnel-supervisor";
import { TerminalRuntime } from "../runtime/terminal-runtime";

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

export class WorkspaceService extends EventEmitter {
  constructor(
    private readonly store: JsonStore,
    private readonly terminals = new TerminalRuntime(),
    private readonly gitRuntimeFactory: GitRuntimeFactory = (device, connection) => new GitRuntime(device, connection),
    private readonly directoryRuntimeFactory: DirectoryRuntimeFactory = (device, connection) => new DirectoryRuntime(device, connection),
    private readonly tunnels: DeviceTunnelRuntime = new SshTunnelSupervisor()
  ) {
    super();
    terminals.on("output", (event) => this.emit("terminal-output", event));
    terminals.on("exit", (sessionId: string) => void this.markSessionExited(sessionId));
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
        if (session.status === "running" && !this.terminals.has(session.id)) {
          session.status = "exited";
          session.pid = undefined;
          session.exitedAt = now();
        }
      }
    });
    this.tunnels.sync(this.snapshot().connections);
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

  async createSession(input: CreateSessionInput): Promise<void> {
    const snapshot = this.snapshot();
    const workspace = this.workspace(snapshot, input.workspaceId);
    if (workspace.status !== "ready") throw new Error("Workspace is not ready");
    const device = this.device(snapshot, workspace.deviceId);
    const connection = this.connection(snapshot, device.id);
    const count = snapshot.sessions.filter((item) => item.workspaceId === workspace.id).length;
    const session = {
      id: id("session"), workspaceId: workspace.id, name: input.name || `Terminal ${count + 1}`,
      status: "running" as const, shell: device.type === "remote" ? "ssh" : process.env.SHELL || "/bin/zsh", createdAt: now()
    };
    const pid = this.terminals.create(session, workspace, device, connection);
    await this.store.update((draft) => { draft.sessions.push({ ...session, pid }); });
    this.changed();
  }

  async resumeSession(sessionId: string): Promise<void> {
    const snapshot = this.snapshot();
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("Terminal session not found");
    if (session.status !== "exited") throw new Error("Only an exited terminal session can be resumed");
    if (this.terminals.has(session.id)) throw new Error("Terminal session is already running");
    const workspace = this.workspace(snapshot, session.workspaceId);
    if (workspace.status !== "ready") throw new Error("Workspace is not ready");
    const device = this.device(snapshot, workspace.deviceId);
    const connection = this.connection(snapshot, device.id);
    const pid = this.terminals.create(session, workspace, device, connection);
    await this.store.update((draft) => {
      const current = draft.sessions.find((item) => item.id === sessionId);
      if (!current) throw new Error("Terminal session not found");
      Object.assign(current, { status: "running", pid });
      delete current.exitedAt;
    });
    this.changed();
  }

  attachSession(id: string): TerminalReplay { return this.terminals.attach(id); }
  writeSession(id: string, data: string): void { this.terminals.write(id, data); }
  resizeSession(id: string, cols: number, rows: number): void { this.terminals.resize(id, cols, rows); }
  reconnectTunnels(): void { this.tunnels.reconnectAll(); }
  shutdown(): void { this.tunnels.stop(); }
  async killSession(id: string): Promise<void> {
    if (this.terminals.has(id)) this.terminals.kill(id);
    await this.store.update((draft) => {
      draft.sessions = draft.sessions.filter((item) => item.id !== id);
    });
    this.changed();
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    const name = input.name.trim();
    await this.store.update((draft) => {
      const session = draft.sessions.find((item) => item.id === input.id);
      if (!session) throw new Error("Terminal session not found");
      session.name = name;
    });
    this.changed();
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

  private async markSessionExited(sessionId: string): Promise<void> {
    await this.store.update((draft) => {
      const session = draft.sessions.find((item) => item.id === sessionId);
      if (session) Object.assign(session, { status: "exited", exitedAt: now(), pid: undefined });
    });
    this.changed();
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
