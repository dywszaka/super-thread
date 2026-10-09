import type { WorkspaceShortcut } from "./workspace-shortcuts";
import { z } from "zod";
import { normalizeBrowserUrl } from "./browser-url";
import { isWorkspaceLinkPath } from "./workspace-links";
import type {
  BrowserTab, BrowserState, CreateBrowserInput, NavigateBrowserInput, ReorderWorkspaceTabsInput, BrowserLayoutInput,
  AddProjectInput,
  AddRemoteDeviceInput,
  AppSnapshot,
  BrowseDirectoryInput,
  CreateSessionInput,
  CreateSessionResult,
  CreateWorkThreadInput,
  CreateWorkspaceInput,
  WorkspaceLinkInput,
  WorkspaceLinkCandidate,
  DirectoryListing,
  SaveTerminalPresetInput,
  DeleteTerminalPresetInput,
  ReorderSessionsInput,
  RenameSessionInput,
  RenameWorkspaceInput,
  RenameWorkThreadInput,
  SetWorkThreadPinnedInput,
  SaveWorkThreadDocumentInput,
  SetupProjectInput,
  TerminalOutput,
  TerminalReplay,
  UpdateProjectInput,
  UpdateRemoteDeviceInput
} from "./domain";

export const channels = {
  workspaceShortcut: "workspace:shortcut",
  setWorkspaceShortcutCount: "workspace:shortcut-count",
  createBrowser: "browser:create",
  navigateBrowser: "browser:navigate",
  closeBrowser: "browser:close",
  browserCommand: "browser:command",
  browserLayout: "browser:layout",
  browserStates: "browser:states",
  browserStateChanged: "browser:state-changed",
  browserCreated: "browser:created",
  reorderWorkspaceTabs: "workspace:reorder-tabs",
  snapshot: "app:snapshot",
  finishDocumentClose: "window:finish-document-close",
  openDocumentLink: "document:open-link",
  selectDirectory: "dialog:select-directory",
  browseDirectory: "directory:browse",
  addDevice: "device:add",
  updateDevice: "device:update",
  deleteDevice: "device:delete",
  pingDevices: "device:ping-all",
  addProject: "project:add",
  updateProject: "project:update",
  deleteProject: "project:delete",
  setupProject: "project:setup",
  createWorkThread: "work-thread:create",
  renameWorkThread: "work-thread:rename",
  setWorkThreadPinned: "work-thread:set-pinned",
  saveWorkThreadDocument: "work-thread:save-document",
  archiveWorkThread: "work-thread:archive",
  restoreWorkThread: "work-thread:restore",
  deleteWorkThread: "work-thread:delete",
  createWorkspace: "workspace:create",
  listWorkspaceLinkCandidates: "workspace:list-link-candidates",
  renameWorkspace: "workspace:rename",
  deleteWorkspace: "workspace:delete",
  openWorkspaceInVSCode: "workspace:open-in-vscode",
  openWorkspaceTmuxInIterm: "workspace:open-tmux-in-iterm",
  createSession: "session:create",
  saveTerminalPreset: "device:save-terminal-preset",
  deleteTerminalPreset: "device:delete-terminal-preset",
  setFocusMode: "window:set-focus-mode",
  resumeSession: "session:resume",
  reorderSessions: "session:reorder",
  markSessionViewed: "session:mark-viewed",
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

export const updateProjectSchema = z.object({
  id: z.string().min(1),
  name: projectNameSchema
}).strict();

export const browseDirectorySchema = z.object({
  deviceId: z.string().min(1),
  path: z.string().trim().optional()
}).strict();

export const createWorkThreadSchema = z.object({
  name: z.string().trim().min(1).max(80)
}).strict();

export const renameWorkThreadSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80)
}).strict();

export const documentLinkSchema = z.string().url().refine((url) => {
  try { return ["http:", "https:", "mailto:"].includes(new URL(url).protocol); }
  catch { return false; }
}, "Unsupported document link");

export const MAX_WORK_THREAD_DOCUMENT_LENGTH = 2_000_000;

export const saveWorkThreadDocumentSchema = z.object({
  id: z.string().min(1),
  content: z.string().max(MAX_WORK_THREAD_DOCUMENT_LENGTH)
}).strict();

export const setWorkThreadPinnedSchema = z.object({
  id: z.string().min(1),
  pinned: z.boolean()
}).strict();

/** Workspace names become worktree directory and branch segments, so they stay path-safe. */
export const workspaceNameSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/);

const createWorkspaceBaseSchema = {
  workThreadId: z.string().min(1),
  projectId: z.string().min(1),
  deviceId: z.string().min(1),
  name: workspaceNameSchema
};

export const createWorkspaceSchema = z.discriminatedUnion("kind", [
  z.object({ ...createWorkspaceBaseSchema, kind: z.literal("main") }).strict(),
  z.object({
    ...createWorkspaceBaseSchema,
    kind: z.literal("worktree"),
    baseBranch: z.string().trim().min(1).max(255),
    linkPaths: z.array(z.string().refine(isWorkspaceLinkPath, "Invalid checkout-relative link path")).max(256)
      .refine((paths) => new Set(paths).size === paths.length, "Link paths must be unique").optional()
  }).strict()
]);

export const workspaceLinkInputSchema = z.object({
  projectId: z.string().min(1),
  deviceId: z.string().min(1)
}).strict();

export const renameWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: workspaceNameSchema
}).strict();

export const createSessionSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  kind: z.enum(["shell", "codex"]).optional(),
  terminalPresetId: z.string().min(1).optional()
}).strict().refine((input) => !input.terminalPresetId || !input.kind || input.kind === "shell", "Custom terminals must use a shell");

export const saveTerminalPresetSchema = z.object({
  deviceId: z.string().min(1),
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1).max(4096).refine((path) => !/[\u0000\r\n]/.test(path), "Invalid directory path")
}).strict();

export const deleteTerminalPresetSchema = z.object({
  deviceId: z.string().min(1),
  id: z.string().min(1)
}).strict();

export const renameSessionSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80)
}).strict();

export const reorderSessionsSchema = z.object({
  workspaceId: z.string().min(1),
  sessionIds: z.array(z.string().min(1)).min(1)
}).strict();

const browserUrlSchema = z.string().max(8192).transform((value, context) => {
  try { return normalizeBrowserUrl(value); }
  catch (error) { context.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message }); return z.NEVER; }
});
export const createBrowserSchema = z.object({ workspaceId: z.string().min(1), url: browserUrlSchema.optional() }).strict();
export const navigateBrowserSchema = z.object({ id: z.string().min(1), url: browserUrlSchema }).strict();
export const reorderWorkspaceTabsSchema = z.object({ workspaceId: z.string().min(1), tabIds: z.array(z.string().min(1)).max(4096).refine((ids) => new Set(ids).size === ids.length, "Tab IDs must be unique") }).strict();
export const browserLayoutSchema = z.object({ id: z.string().min(1).nullable(), bounds: z.object({
  x: z.number().finite().min(0).max(32768), y: z.number().finite().min(0).max(32768),
  width: z.number().finite().min(0).max(32768), height: z.number().finite().min(0).max(32768)
}).strict() }).strict();
export const browserCommandSchema = z.object({ id: z.string().min(1), command: z.enum(["back", "forward", "reload"]) }).strict();

export type MenuAction = "new-work-thread" | "new-workspace" | "add-project" | "add-device" | "new-terminal";

export interface DesktopBridge {
  setWorkspaceShortcutCount(count: number): void;
  onWorkspaceShortcut(listener: (shortcut: WorkspaceShortcut) => void): () => void;
  createBrowser(input: CreateBrowserInput): Promise<BrowserTab>;
  navigateBrowser(input: NavigateBrowserInput): Promise<void>;
  closeBrowser(id: string): Promise<void>;
  reorderWorkspaceTabs(input: ReorderWorkspaceTabsInput): Promise<void>;
  browserCommand(input: { id: string; command: "back" | "forward" | "reload" }): Promise<void>;
  browserLayout(input: BrowserLayoutInput): Promise<void>;
  browserStates(): Promise<BrowserState[]>;
  onBrowserStateChanged(listener: (state: BrowserState) => void): () => void;
  onBrowserCreated(listener: (tab: BrowserTab) => void): () => void;
  platform: NodeJS.Platform;
  snapshot(): Promise<AppSnapshot>;
  finishDocumentClose(): void;
  openDocumentLink(url: string): Promise<void>;
  selectDirectory(): Promise<string | null>;
  browseDirectory(input: BrowseDirectoryInput): Promise<DirectoryListing>;
  addDevice(input: AddRemoteDeviceInput): Promise<void>;
  updateDevice(input: UpdateRemoteDeviceInput): Promise<void>;
  deleteDevice(id: string): Promise<void>;
  pingDevices(): Promise<AppSnapshot>;
  addProject(input: AddProjectInput): Promise<void>;
  updateProject(input: UpdateProjectInput): Promise<void>;
  deleteProject(id: string): Promise<void>;
  setupProject(input: SetupProjectInput): Promise<void>;
  createWorkThread(input: CreateWorkThreadInput): Promise<void>;
  renameWorkThread(input: RenameWorkThreadInput): Promise<void>;
  saveWorkThreadDocument(input: SaveWorkThreadDocumentInput): Promise<void>;
  setWorkThreadPinned(input: SetWorkThreadPinnedInput): Promise<void>;
  archiveWorkThread(id: string): Promise<void>;
  restoreWorkThread(id: string): Promise<void>;
  deleteWorkThread(id: string): Promise<void>;
  createWorkspace(input: CreateWorkspaceInput): Promise<void>;
  listWorkspaceLinkCandidates(input: WorkspaceLinkInput): Promise<WorkspaceLinkCandidate[]>;
  renameWorkspace(input: RenameWorkspaceInput): Promise<void>;
  deleteWorkspace(id: string, force?: boolean): Promise<void>;
  openWorkspaceInVSCode(id: string): Promise<void>;
  openWorkspaceTmuxInIterm(id: string): Promise<void>;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  saveTerminalPreset(input: SaveTerminalPresetInput): Promise<void>;
  deleteTerminalPreset(input: DeleteTerminalPresetInput): Promise<void>;
  setFocusMode(enabled: boolean): void;
  resumeSession(id: string): Promise<void>;
  reorderSessions(input: ReorderSessionsInput): Promise<void>;
  markSessionViewed(id: string): Promise<void>;
  attachSession(id: string): Promise<TerminalReplay>;
  writeSession(id: string, data: string): void;
  resizeSession(id: string, cols: number, rows: number): void;
  killSession(id: string, force?: boolean): Promise<void>;
  renameSession(input: RenameSessionInput): Promise<void>;
  onTerminalOutput(listener: (event: TerminalOutput) => void): () => void;
  onDataChanged(listener: () => void): () => void;
  onMenuAction(listener: (action: MenuAction) => void): () => void;
}

declare global {
  interface Window { desktop: DesktopBridge; }
}
