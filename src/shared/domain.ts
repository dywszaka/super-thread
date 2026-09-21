export type DeviceStatus = "online" | "offline" | "unknown";
export type WorkspaceStatus = "creating" | "ready" | "error";
export type SessionStatus = "running" | "exited";

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

export interface DeviceConnection {
  deviceId: string;
  transport: "local" | "ssh";
  config: { host?: string; user?: string; port?: number };
}

export interface ProjectCheckout {
  id: string;
  projectId: string;
  deviceId: string;
  path: string;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  projectId: string;
  deviceId: string;
  checkoutId: string;
  path: string;
  branch: string;
  baseBranch: string;
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
  shell: string;
  pid?: number;
  createdAt: string;
  exitedAt?: string;
}

export interface AppSnapshot {
  projects: Project[];
  devices: Device[];
  connections: DeviceConnection[];
  checkouts: ProjectCheckout[];
  workspaces: Workspace[];
  sessions: Session[];
}

export const emptySnapshot = (): AppSnapshot => ({
  projects: [],
  devices: [],
  connections: [],
  checkouts: [],
  workspaces: [],
  sessions: []
});

export interface AddRemoteDeviceInput {
  name: string;
  host: string;
  user: string;
  port?: number;
}

export type AddProjectInput =
  | { mode: "import"; path: string }
  | { mode: "clone"; repositoryUrl: string; deviceId: string; parentDirectory: string };

export interface SetupProjectInput {
  projectId: string;
  deviceId: string;
  mode: "import" | "clone";
  path?: string;
  parentDirectory?: string;
}

export interface CreateWorkspaceInput {
  projectId: string;
  deviceId: string;
  name: string;
  baseBranch: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  name?: string;
}

export interface TerminalOutput {
  sessionId: string;
  data: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
