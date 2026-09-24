export type DeviceStatus = "online" | "offline" | "unknown";
export type WorkThreadStatus = "active" | "archived";
export type WorkspaceStatus = "creating" | "ready" | "error";
export type SessionStatus = "running" | "exited" | "restore-failed";
export type SessionKind = "shell" | "codex" | "tmux";
export type SessionActivityStatus = "idle" | "busy" | "waiting-input";
export type SessionExitReason = "process-exit" | "user-closed" | "runtime-stopped" | "restore-failed";

export const CURRENT_SCHEMA_VERSION = 3;

export interface WorkThread {
  id: string;
  name: string;
  status: WorkThreadStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface Project {
  id: string;
  name: string;
  repositoryUrl: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface Device {
  id: string;
  name: string;
  type: "local" | "remote";
  status: DeviceStatus;
  createdAt: string;
}

export type SshTunnelDirection = "local-to-remote" | "remote-to-local";

export interface SshTunnelConfig {
  direction: SshTunnelDirection;
  sourcePort: number;
  destinationHost: string;
  destinationPort: number;
}

export interface DeviceConnection {
  deviceId: string;
  transport: "local" | "ssh";
  config: { host?: string; user?: string; port?: number; tunnels?: SshTunnelConfig[] };
}

export interface ProjectCheckout {
  id: string;
  projectId: string;
  deviceId: string;
  path: string;
  createdAt: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  deviceId: string;
  path: string;
  parentPath: string | null;
  entries: DirectoryEntry[];
}

export interface Workspace {
  id: string;
  name: string;
  workThreadId: string;
  projectId: string;
  deviceId: string;
  checkoutId: string;
  path: string;
  branch: string;
  baseBranch: string;
  tmuxSessionName?: string;
  status: WorkspaceStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  workspaceId: string;
  name: string;
  status: SessionStatus;
  kind?: SessionKind;
  order?: number;
  shell: string;
  pid?: number;
  cwd?: string;
  activityStatus?: SessionActivityStatus;
  exitReason?: SessionExitReason;
  exitCode?: number;
  restoreError?: string;
  tmuxSessionName?: string;
  tmuxWindowName?: string;
  codexConversationId?: string;
  codexResultUnread?: boolean;
  fallbackMessage?: string;
  restoredAt?: string;
  createdAt: string;
  exitedAt?: string;
}

export interface AppSnapshot {
  schemaVersion: number;
  workThreads: WorkThread[];
  projects: Project[];
  devices: Device[];
  connections: DeviceConnection[];
  checkouts: ProjectCheckout[];
  workspaces: Workspace[];
  sessions: Session[];
}

export const emptySnapshot = (): AppSnapshot => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  workThreads: [],
  projects: [],
  devices: [],
  connections: [],
  checkouts: [],
  workspaces: [],
  sessions: []
});

export interface CreateWorkThreadInput {
  name: string;
}

export interface AddRemoteDeviceInput {
  name: string;
  host: string;
  user: string;
  port?: number;
  tunnels?: SshTunnelConfig[];
}

export interface UpdateRemoteDeviceInput extends AddRemoteDeviceInput {
  id: string;
}

export type AddProjectInput =
  | { mode: "import"; deviceId: string; path: string; projectName?: string }
  | { mode: "clone"; repositoryUrl: string; parentDirectory: string; projectName?: string };

export type SetupProjectInput =
  | { projectId: string; deviceId: string; mode: "import"; path: string }
  | { projectId: string; deviceId: string; mode: "clone"; parentDirectory: string };

export interface UpdateProjectInput {
  id: string;
  name: string;
}

export interface BrowseDirectoryInput {
  deviceId: string;
  path?: string;
}

export interface CreateWorkspaceInput {
  workThreadId: string;
  projectId: string;
  deviceId: string;
  name: string;
  baseBranch: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  name?: string;
  kind?: SessionKind;
}

export interface RenameSessionInput {
  id: string;
  name: string;
}

export interface ReorderSessionsInput {
  workspaceId: string;
  sessionIds: string[];
}

export interface CreateSessionResult {
  session: Session;
  warning?: string;
}

export interface TerminalOutput {
  sessionId: string;
  data: string;
  sequence: number;
}

export interface TerminalReplay {
  data: string;
  sequence: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
