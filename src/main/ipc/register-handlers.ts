import type { BrowserRuntime } from "../runtime/browser-runtime";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { z } from "zod";
import {
  createBrowserSchema, navigateBrowserSchema, reorderWorkspaceTabsSchema, browserLayoutSchema, browserCommandSchema,
  addProjectSchema,
  addRemoteDeviceSchema,
  browseDirectorySchema,
  channels,
  documentLinkSchema,
  createSessionSchema,
  saveTerminalPresetSchema,
  deleteTerminalPresetSchema,
  createWorkThreadSchema,
  renameWorkThreadSchema,
  createWorkspaceSchema,
  workspaceLinkInputSchema,
  reorderSessionsSchema,
  renameSessionSchema,
  renameWorkspaceSchema,
  setWorkThreadPinnedSchema,
  saveWorkThreadDocumentSchema,
  setupProjectSchema,
  updateProjectSchema,
  updateRemoteDeviceSchema
} from "../../shared/contract";
import type { WorkspaceService } from "../application/workspace-service";
import { vscodeWorkspaceUrl } from "../runtime/vscode-workspace";

const sessionIdSchema = z.string().min(1);

export function registerIpcHandlers(service: WorkspaceService, finishDocumentClose: (window: BrowserWindow) => void, browsers: BrowserRuntime): void {
  const handle = (channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) throw new Error("Untrusted IPC sender");
      return listener(event, ...args);
    });
  };
  const on = (channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void): void => {
    ipcMain.on(channel, (event, ...args) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return;
      listener(event, ...args);
    });
  };
  handle(channels.createBrowser, (_event, input) => service.createBrowser(createBrowserSchema.parse(input)));
  handle(channels.navigateBrowser, (_event, input) => { const parsed = navigateBrowserSchema.parse(input); return browsers.navigate(parsed.id, parsed.url); });
  handle(channels.closeBrowser, (_event, id) => service.closeBrowser(sessionIdSchema.parse(id)));
  handle(channels.reorderWorkspaceTabs, (_event, input) => service.reorderWorkspaceTabs(reorderWorkspaceTabsSchema.parse(input)));
  handle(channels.browserLayout, (_event, input) => browsers.setLayout(browserLayoutSchema.parse(input)));
  handle(channels.browserStates, () => browsers.states());
  handle(channels.browserCommand, (_event, input) => { const parsed = browserCommandSchema.parse(input); browsers.command(parsed.id, parsed.command); });
  handle(channels.openDocumentLink, (_event, url) => shell.openExternal(documentLinkSchema.parse(url)));
  on(channels.finishDocumentClose, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) finishDocumentClose(owner);
  });
  handle(channels.snapshot, () => service.snapshot());
  handle(channels.selectDirectory, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(channels.browseDirectory, (_event, input) => service.browseDirectory(browseDirectorySchema.parse(input)));
  handle(channels.addDevice, (_event, input) => service.addDevice(addRemoteDeviceSchema.parse(input)));
  handle(channels.updateDevice, (_event, input) => service.updateDevice(updateRemoteDeviceSchema.parse(input)));
  handle(channels.deleteDevice, (_event, id) => service.deleteDevice(sessionIdSchema.parse(id)));
  handle(channels.pingDevices, () => service.pingDevices());
  handle(channels.addProject, (_event, input) => service.addProject(addProjectSchema.parse(input)));
  handle(channels.updateProject, (_event, input) => service.updateProject(updateProjectSchema.parse(input)));
  handle(channels.deleteProject, (_event, id) => service.deleteProject(sessionIdSchema.parse(id)));
  handle(channels.setupProject, (_event, input) => service.setupProject(setupProjectSchema.parse(input)));
  handle(channels.createWorkThread, (_event, input) => service.createWorkThread(createWorkThreadSchema.parse(input)));
  handle(channels.renameWorkThread, (_event, input) => service.renameWorkThread(renameWorkThreadSchema.parse(input)));
  handle(channels.saveWorkThreadDocument, (_event, input) => service.saveWorkThreadDocument(saveWorkThreadDocumentSchema.parse(input)));
  handle(channels.setWorkThreadPinned, (_event, input) => service.setWorkThreadPinned(setWorkThreadPinnedSchema.parse(input)));
  handle(channels.archiveWorkThread, (_event, id) => service.archiveWorkThread(sessionIdSchema.parse(id)));
  handle(channels.restoreWorkThread, (_event, id) => service.restoreWorkThread(sessionIdSchema.parse(id)));
  handle(channels.deleteWorkThread, (_event, id) => service.deleteWorkThread(sessionIdSchema.parse(id)));
  handle(channels.createWorkspace, (_event, input) => service.createWorkspace(createWorkspaceSchema.parse(input)));
  handle(channels.listWorkspaceLinkCandidates, (_event, input) => service.listWorkspaceLinkCandidates(workspaceLinkInputSchema.parse(input)));
  handle(channels.renameWorkspace, (_event, input) => service.renameWorkspace(renameWorkspaceSchema.parse(input)));
  handle(channels.deleteWorkspace, (_event, workspaceId, force) => service.deleteWorkspace(sessionIdSchema.parse(workspaceId), Boolean(force)));
  handle(channels.openWorkspaceInVSCode, async (_event, workspaceId) => {
    const url = vscodeWorkspaceUrl(service.snapshot(), sessionIdSchema.parse(workspaceId));
    await shell.openExternal(url);
  });
  handle(channels.openWorkspaceTmuxInIterm, (_event, workspaceId) => service.openWorkspaceTmuxInIterm(sessionIdSchema.parse(workspaceId)));
  handle(channels.createSession, (_event, input) => service.createSession(createSessionSchema.parse(input)));
  handle(channels.saveTerminalPreset, (_event, input) => service.saveTerminalPreset(saveTerminalPresetSchema.parse(input)));
  handle(channels.deleteTerminalPreset, (_event, input) => service.deleteTerminalPreset(deleteTerminalPresetSchema.parse(input)));
  on(channels.setFocusMode, (event, enabled) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    owner?.setWindowButtonPosition({ x: 16, y: z.boolean().parse(enabled) ? 13 : 18 });
  });
  handle(channels.resumeSession, (_event, id) => service.resumeSession(sessionIdSchema.parse(id)));
  handle(channels.reorderSessions, (_event, input) => service.reorderSessions(reorderSessionsSchema.parse(input)));
  handle(channels.markSessionViewed, (_event, id) => service.markSessionViewed(sessionIdSchema.parse(id)));
  handle(channels.attachSession, (_event, id) => service.attachSession(sessionIdSchema.parse(id)));
  on(channels.writeSession, (_event, id, data) => service.writeSession(sessionIdSchema.parse(id), z.string().parse(data)));
  on(channels.resizeSession, (_event, id, cols, rows) => service.resizeSession(sessionIdSchema.parse(id), z.number().int().min(2).parse(cols), z.number().int().min(1).parse(rows)));
  handle(channels.killSession, (_event, id, force) => service.killSession(sessionIdSchema.parse(id), Boolean(force)));
  handle(channels.renameSession, (_event, input) => service.renameSession(renameSessionSchema.parse(input)));
}
