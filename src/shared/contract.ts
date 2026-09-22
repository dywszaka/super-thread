import { z } from "zod";
import type {
  AddProjectInput,
  AddRemoteDeviceInput,
  AppSnapshot,
  BrowseDirectoryInput,
  CreateSessionInput,
  CreateWorkThreadInput,
  CreateWorkspaceInput,
  DirectoryListing,
  RenameSessionInput,
  SetupProjectInput,
  TerminalOutput,
  UpdateRemoteDeviceInput
} from "./domain";

export const channels = {
  snapshot: "app:snapshot",
  selectDirectory: "dialog:select-directory",
  browseDirectory: "directory:browse",
  addDevice: "device:add",
  updateDevice: "device:update",
  deleteDevice: "device:delete",
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
  resumeSession: "session:resume",
  attachSession: "session:attach",
  writeSession: "session:write",
  resizeSession: "session:resize",
  killSession: "session:kill",
  renameSession: "session:rename",
  terminalOutput: "session:output",
  dataChanged: "app:data-changed",
  menuAction: "menu:action"
} as const;

export const sshTunnelSchema = z.object({
  direction: z.enum(["local-to-remote", "remote-to-local"]),
  sourcePort: z.number().int().min(1).max(65535),
  destinationHost: z.string().trim().min(1).max(255),
  destinationPort: z.number().int().min(1).max(65535)
}).strict();

export const addRemoteDeviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(255),
  user: z.string().trim().min(1).max(80),
  port: z.number().int().min(1).max(65535).optional(),
  tunnels: z.array(sshTunnelSchema).max(32).optional()
}).superRefine((input, context) => {
  const bindings = new Set<string>();
  input.tunnels?.forEach((tunnel, index) => {
    const binding = `${tunnel.direction}:${tunnel.sourcePort}`;
    if (bindings.has(binding)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Tunnel source ports must be unique within each direction",
        path: ["tunnels", index, "sourcePort"]
      });
    }
    bindings.add(binding);
  });
});

export const updateRemoteDeviceSchema = z.intersection(
  addRemoteDeviceSchema,
  z.object({ id: z.string().min(1) })
);

export const projectNameSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => value !== "." && value !== "..", "Project name cannot be . or ..")
  .refine((value) => !/[\\/]/.test(value), "Project name cannot contain path separators");

export const addProjectSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("import"), deviceId: z.string().min(1), path: z.string().trim().min(1), projectName: projectNameSchema.optional() }).strict(),
  z.object({
    mode: z.literal("clone"),
    repositoryUrl: z.string().trim().min(1),
    parentDirectory: z.string().trim().min(1),
    projectName: projectNameSchema.optional()
  }).strict()
]);

export const setupProjectSchema = z.discriminatedUnion("mode", [
  z.object({
    projectId: z.string().min(1),
    deviceId: z.string().min(1),
    mode: z.literal("import"),
    path: z.string().trim().min(1)
  }).strict(),
  z.object({
    projectId: z.string().min(1),
    deviceId: z.string().min(1),
    mode: z.literal("clone"),
    parentDirectory: z.string().trim().min(1)
  }).strict()
]);

export const browseDirectorySchema = z.object({
  deviceId: z.string().min(1),
  path: z.string().trim().optional()
}).strict();

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

export const renameSessionSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80)
}).strict();

export type MenuAction = "new-work-thread" | "new-workspace" | "add-project" | "add-device" | "new-terminal";

export interface DesktopBridge {
  platform: NodeJS.Platform;
  snapshot(): Promise<AppSnapshot>;
  selectDirectory(): Promise<string | null>;
  browseDirectory(input: BrowseDirectoryInput): Promise<DirectoryListing>;
  addDevice(input: AddRemoteDeviceInput): Promise<void>;
  updateDevice(input: UpdateRemoteDeviceInput): Promise<void>;
  deleteDevice(id: string): Promise<void>;
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
  resumeSession(id: string): Promise<void>;
  attachSession(id: string): Promise<void>;
  writeSession(id: string, data: string): void;
  resizeSession(id: string, cols: number, rows: number): void;
  killSession(id: string): Promise<void>;
  renameSession(input: RenameSessionInput): Promise<void>;
  onTerminalOutput(listener: (event: TerminalOutput) => void): () => void;
  onDataChanged(listener: () => void): () => void;
  onMenuAction(listener: (action: MenuAction) => void): () => void;
}

declare global {
  interface Window { desktop: DesktopBridge; }
}
