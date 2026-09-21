import { z } from "zod";
import type {
  AddProjectInput,
  AddRemoteDeviceInput,
  AppSnapshot,
  CreateSessionInput,
  CreateWorkThreadInput,
  CreateWorkspaceInput,
  SetupProjectInput,
  TerminalOutput
} from "./domain";

export const channels = {
  snapshot: "app:snapshot",
  selectDirectory: "dialog:select-directory",
  addDevice: "device:add",
  pingDevices: "device:ping-all",
  addProject: "project:add",
  setupProject: "project:setup",
  createWorkThread: "work-thread:create",
  archiveWorkThread: "work-thread:archive",
  restoreWorkThread: "work-thread:restore",
  deleteWorkThread: "work-thread:delete",
  createWorkspace: "workspace:create",
  deleteWorkspace: "workspace:delete",
  createSession: "session:create",
  attachSession: "session:attach",
  writeSession: "session:write",
  resizeSession: "session:resize",
  killSession: "session:kill",
  terminalOutput: "session:output",
  dataChanged: "app:data-changed",
  menuAction: "menu:action"
} as const;

export const addRemoteDeviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(255),
  user: z.string().trim().min(1).max(80),
  port: z.number().int().min(1).max(65535).optional()
});

export const addProjectSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("import"), path: z.string().trim().min(1) }),
  z.object({
    mode: z.literal("clone"),
    repositoryUrl: z.string().trim().min(1),
    deviceId: z.string().min(1),
    parentDirectory: z.string().trim().min(1)
  })
]);

export const setupProjectSchema = z.object({
  projectId: z.string().min(1),
  deviceId: z.string().min(1),
  mode: z.enum(["import", "clone"]),
  path: z.string().trim().optional(),
  parentDirectory: z.string().trim().optional()
});

export const createWorkThreadSchema = z.object({
  name: z.string().trim().min(1).max(80)
});

export const createWorkspaceSchema = z.object({
  workThreadId: z.string().min(1),
  projectId: z.string().min(1),
  deviceId: z.string().min(1),
  name: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
  baseBranch: z.string().trim().min(1).max(255)
});

export const createSessionSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional()
});

export type MenuAction = "new-work-thread" | "new-workspace" | "add-project" | "add-device" | "new-terminal";

export interface DesktopBridge {
  platform: NodeJS.Platform;
  snapshot(): Promise<AppSnapshot>;
  selectDirectory(): Promise<string | null>;
  addDevice(input: AddRemoteDeviceInput): Promise<void>;
  pingDevices(): Promise<AppSnapshot>;
  addProject(input: AddProjectInput): Promise<void>;
  setupProject(input: SetupProjectInput): Promise<void>;
  createWorkThread(input: CreateWorkThreadInput): Promise<void>;
  archiveWorkThread(id: string): Promise<void>;
  restoreWorkThread(id: string): Promise<void>;
  deleteWorkThread(id: string): Promise<void>;
  createWorkspace(input: CreateWorkspaceInput): Promise<void>;
  deleteWorkspace(id: string, force?: boolean): Promise<void>;
  createSession(input: CreateSessionInput): Promise<void>;
  attachSession(id: string): Promise<void>;
  writeSession(id: string, data: string): void;
  resizeSession(id: string, cols: number, rows: number): void;
  killSession(id: string): Promise<void>;
  onTerminalOutput(listener: (event: TerminalOutput) => void): () => void;
  onDataChanged(listener: () => void): () => void;
  onMenuAction(listener: (action: MenuAction) => void): () => void;
}

declare global {
  interface Window { desktop: DesktopBridge; }
}
