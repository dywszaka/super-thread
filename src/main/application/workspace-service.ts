import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AddProjectInput,
  AddRemoteDeviceInput,
  AppSnapshot,
  CreateSessionInput,
  CreateWorkThreadInput,
  CreateWorkspaceInput,
  Device,
  DeviceConnection,
  Project,
  SetupProjectInput,
  WorkThread,
  Workspace
} from "../../shared/domain";
import { JsonStore } from "../persistence/json-store";
import { DeviceCommandRunner } from "../runtime/command-runner";
import { GitRuntime, type RepositoryInfo } from "../runtime/git-runtime";
import { TerminalRuntime } from "../runtime/terminal-runtime";

const id = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 8)}`;
const now = (): string => new Date().toISOString();
const canonicalRemote = (remote: string): string => remote.trim().replace(/\.git$/, "").replace(/^ssh:\/\//, "").toLowerCase();
const canonicalName = (name: string): string => name.trim().toLowerCase();

export interface WorkspaceGitRuntime {
  inspect(repositoryPath: string): Promise<RepositoryInfo>;
  clone(repositoryUrl: string, parentDirectory: string): Promise<RepositoryInfo>;
  createWorktree(checkoutPath: string, name: string, baseBranch: string): Promise<{ path: string; branch: string }>;
  hasChanges(workspacePath: string): Promise<boolean>;
  deleteWorktree(checkoutPath: string, workspacePath: string, force: boolean): Promise<void>;
}

type GitRuntimeFactory = (device: Device, connection: DeviceConnection) => WorkspaceGitRuntime;

export class WorkspaceService extends EventEmitter {
  constructor(
    private readonly store: JsonStore,
    private readonly terminals = new TerminalRuntime(),
    private readonly gitRuntimeFactory: GitRuntimeFactory = (device, connection) => new GitRuntime(device, connection)
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
  }

  snapshot(): AppSnapshot { return this.store.snapshot(); }

  async addDevice(input: AddRemoteDeviceInput): Promise<void> {
    const deviceId = id("dev");
    await this.store.update((draft) => {
      draft.devices.push({ id: deviceId, name: input.name, type: "remote", status: "unknown", createdAt: now() });
      draft.connections.push({ deviceId, transport: "ssh", config: { host: input.host, user: input.user, port: input.port } });
    });
    await this.pingDevices();
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

  async addProject(input: AddProjectInput): Promise<void> {
    if (input.mode === "import") {
      const snapshot = this.snapshot();
      const device = snapshot.devices.find((item) => item.type === "local");
      if (!device) throw new Error("Local device is not available");
      const info = await this.git(snapshot, device).inspect(input.path);
      await this.recordProjectAndCheckout(info, device.id);
      return;
    }
    const snapshot = this.snapshot();
    const device = this.device(snapshot, input.deviceId);
    const info = await this.git(snapshot, device).clone(input.repositoryUrl, input.parentDirectory);
    await this.recordProjectAndCheckout(info, device.id);
  }

  async setupProject(input: SetupProjectInput): Promise<void> {
    const snapshot = this.snapshot();
    const project = this.project(snapshot, input.projectId);
    const device = this.device(snapshot, input.deviceId);
    if (snapshot.checkouts.some((item) => item.projectId === project.id && item.deviceId === device.id)) {
      throw new Error(`${project.name} is already set up on ${device.name}`);
    }
    const runtime = this.git(snapshot, device);
    const info = input.mode === "import"
      ? await runtime.inspect(input.path || "")
      : await runtime.clone(project.repositoryUrl, input.parentDirectory || "");
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
    try {
      const created = await this.git(snapshot, device).createWorktree(checkout.path, input.name, input.baseBranch);
      await this.store.update((draft) => {
        const workspace = draft.workspaces.find((item) => item.id === workspaceId);
        if (workspace) Object.assign(workspace, created, { status: "ready", updatedAt: now(), error: undefined });
      });
      await this.createSession({ workspaceId, name: "Terminal 1" });
    } catch (error) {
      await this.store.update((draft) => {
        const workspace = draft.workspaces.find((item) => item.id === workspaceId);
        if (workspace) Object.assign(workspace, { status: "error", error: this.message(error), updatedAt: now() });
      });
      this.changed();
      throw error;
    }
  }

  async deleteWorkspace(workspaceId: string, force = false): Promise<void> {
    const snapshot = this.snapshot();
    const workspace = this.workspace(snapshot, workspaceId);
    const checkout = snapshot.checkouts.find((item) => item.id === workspace.checkoutId);
    if (!checkout) throw new Error("Base checkout no longer exists");
    const device = this.device(snapshot, workspace.deviceId);
    const runtime = this.git(snapshot, device);
    if (!force && await runtime.hasChanges(workspace.path)) {
      throw new Error("Workspace has uncommitted changes. Force delete to remove it.");
    }
    for (const session of snapshot.sessions.filter((item) => item.workspaceId === workspaceId && item.status === "running")) {
      this.terminals.kill(session.id);
    }
    await runtime.deleteWorktree(checkout.path, workspace.path, force);
    await this.store.update((draft) => {
      draft.sessions = draft.sessions.filter((item) => item.workspaceId !== workspaceId);
      draft.workspaces = draft.workspaces.filter((item) => item.id !== workspaceId);
      const thread = draft.workThreads.find((item) => item.id === workspace.workThreadId);
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

  attachSession(id: string): void { this.terminals.attach(id); }
  writeSession(id: string, data: string): void { this.terminals.write(id, data); }
  resizeSession(id: string, cols: number, rows: number): void { this.terminals.resize(id, cols, rows); }
  async killSession(id: string): Promise<void> {
    if (this.terminals.has(id)) this.terminals.kill(id);
    else await this.markSessionExited(id);
  }

  private async recordProjectAndCheckout(info: RepositoryInfo, deviceId: string): Promise<void> {
    const snapshot = this.snapshot();
    const existing = snapshot.projects.find((project) => canonicalRemote(project.repositoryUrl) === canonicalRemote(info.remote));
    if (existing && snapshot.checkouts.some((item) => item.projectId === existing.id && item.deviceId === deviceId)) {
      throw new Error(`${existing.name} is already imported on this device`);
    }
    await this.store.update((draft) => {
      let project: Project | undefined = draft.projects.find((item) => canonicalRemote(item.repositoryUrl) === canonicalRemote(info.remote));
      if (!project) {
        project = { id: id("proj"), name: info.name, repositoryUrl: info.remote, defaultBranch: info.defaultBranch, createdAt: now(), updatedAt: now() };
        draft.projects.push(project);
      }
      draft.checkouts.push({ id: id("checkout"), projectId: project.id, deviceId, path: info.root, createdAt: now() });
    });
    this.changed();
  }

  private async markSessionExited(sessionId: string): Promise<void> {
    await this.store.update((draft) => {
      const session = draft.sessions.find((item) => item.id === sessionId);
      if (session) Object.assign(session, { status: "exited", exitedAt: now(), pid: undefined });
    });
    this.changed();
  }

  private git(snapshot: AppSnapshot, device: Device): WorkspaceGitRuntime { return this.gitRuntimeFactory(device, this.connection(snapshot, device.id)); }
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
