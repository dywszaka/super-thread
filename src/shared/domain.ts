export type DeviceStatus = "online" | "offline" | "unknown";
export type WorkThreadStatus = "active" | "archived";
export type WorkspaceStatus = "creating" | "ready" | "error";
export type WorkspaceKind = "main" | "worktree";
export type SessionStatus = "running" | "exited" | "restore-failed";
export type ManagedSessionKind = "shell" | "codex";
/** tmux is retained only to migrate snapshots created by older releases. */
export type SessionKind = ManagedSessionKind | "tmux";
export type SessionActivityStatus = "idle" | "busy" | "waiting-input";
export type SessionExitReason = "process-exit" | "user-closed" | "runtime-stopped" | "restore-failed";

export const CURRENT_SCHEMA_VERSION = 11;

export interface WorkThread {
  id: string;
  name: string;
  status: WorkThreadStatus;
  pinned: boolean;
  sidebarOrder?: number;
  document?: string;
  documentUpdatedAt?: string;
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
  terminalPresets?: TerminalPreset[];
}

/** Reusable shell launch configuration owned by a device. */
export interface TerminalPreset {
  id: string;
  name: string;
  path: string;
}

export interface SaveTerminalPresetInput {
  deviceId: string;
  id?: string;
  name: string;
  path: string;
}

export interface DeleteTerminalPresetInput {
  deviceId: string;
  id: string;
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
  /** Missing only in snapshots created before schema version 6; treated as worktree. */
  kind?: WorkspaceKind;
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
  /** Legacy grouped-client metadata kept only for cleanup compatibility. */
  tmuxClientSessionName?: string;
  tmuxWindowKey?: string;
  tmuxWindowName?: string;
  codexConversationId?: string;
  resultUnread?: boolean;
  /** Legacy field retained only for persisted-data migration. */
  codexResultUnread?: boolean;
  fallbackMessage?: string;
  restoredAt?: string;
  createdAt: string;
  exitedAt?: string;
}

export interface BrowserTab {
  id: string;
  workspaceId: string;
  url: string;
  title: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserState {
  id: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export interface CreateBrowserInput { workspaceId: string; url?: string; }
export interface NavigateBrowserInput { id: string; url: string; }
export interface ReorderWorkspaceTabsInput { workspaceId: string; tabIds: string[]; }
export interface BrowserLayoutInput {
  id: string | null;
  bounds: { x: number; y: number; width: number; height: number };
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
  browserTabs: BrowserTab[];
}

export const emptySnapshot = (): AppSnapshot => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  workThreads: [],
  projects: [],
  devices: [],
  connections: [],
  checkouts: [],
  workspaces: [],
  browserTabs: [],
  sessions: []
});

export interface CreateWorkThreadInput {
  name: string;
}

export interface RenameWorkThreadInput {
  id: string;
  name: string;
}

export interface SaveWorkThreadDocumentInput {
  id: string;
  content: string;
}

export interface ReorderWorkThreadsInput {
  id: string;
  targetId: string;
  placement: "before" | "after";
}

export interface SetWorkThreadPinnedInput {
  id: string;
  pinned: boolean;
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

interface CreateWorkspaceBaseInput {
  workThreadId: string;
  projectId: string;
  deviceId: string;
  name: string;
}

export type CreateWorkspaceInput =
  | (CreateWorkspaceBaseInput & { kind: "main" })
  | (CreateWorkspaceBaseInput & { kind: "worktree"; baseBranch: string; linkPaths?: string[] });

export interface WorkspaceLinkInput { projectId: string; deviceId: string; }
export interface WorkspaceLinkCandidate { path: string; kind: "file" | "directory"; }

/** Renames a workspace for display only; path, branch, and tmux session identity stay unchanged. */
export interface RenameWorkspaceInput {
  id: string;
  name: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  name?: string;
  kind?: ManagedSessionKind;
  terminalPresetId?: string;
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
