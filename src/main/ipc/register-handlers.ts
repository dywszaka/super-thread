import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { z } from "zod";
import {
  addProjectSchema,
  addRemoteDeviceSchema,
  browseDirectorySchema,
  channels,
  documentLinkSchema,
  createSessionSchema,
  saveTerminalPresetSchema,
  deleteTerminalPresetSchema,
  createWorkThreadSchema,
  createWorkspaceSchema,
  workspaceLinkInputSchema,
  reorderSessionsSchema,
  renameSessionSchema,
  setWorkThreadPrioritySchema,
  saveWorkThreadDocumentSchema,
  setupProjectSchema,
  updateProjectSchema,
  updateRemoteDeviceSchema
} from "../../shared/contract";
import type { WorkspaceService } from "../application/workspace-service";
import { vscodeWorkspaceUrl } from "../runtime/vscode-workspace";

const sessionIdSchema = z.string().min(1);

export function registerIpcHandlers(service: WorkspaceService, finishDocumentClose: (window: BrowserWindow) => void): void {
  ipcMain.handle(channels.openDocumentLink, (_event, url) => shell.openExternal(documentLinkSchema.parse(url)));
  ipcMain.on(channels.finishDocumentClose, (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) finishDocumentClose(owner);
  });
  ipcMain.handle(channels.snapshot, () => service.snapshot());
  ipcMain.handle(channels.selectDirectory, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(channels.browseDirectory, (_event, input) => service.browseDirectory(browseDirectorySchema.parse(input)));
  ipcMain.handle(channels.addDevice, (_event, input) => service.addDevice(addRemoteDeviceSchema.parse(input)));
  ipcMain.handle(channels.updateDevice, (_event, input) => service.updateDevice(updateRemoteDeviceSchema.parse(input)));
  ipcMain.handle(channels.deleteDevice, (_event, id) => service.deleteDevice(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.pingDevices, () => service.pingDevices());
  ipcMain.handle(channels.addProject, (_event, input) => service.addProject(addProjectSchema.parse(input)));
  ipcMain.handle(channels.updateProject, (_event, input) => service.updateProject(updateProjectSchema.parse(input)));
  ipcMain.handle(channels.deleteProject, (_event, id) => service.deleteProject(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.setupProject, (_event, input) => service.setupProject(setupProjectSchema.parse(input)));
  ipcMain.handle(channels.createWorkThread, (_event, input) => service.createWorkThread(createWorkThreadSchema.parse(input)));
  ipcMain.handle(channels.saveWorkThreadDocument, (_event, input) => service.saveWorkThreadDocument(saveWorkThreadDocumentSchema.parse(input)));
  ipcMain.handle(channels.setWorkThreadPriority, (_event, input) => service.setWorkThreadPriority(setWorkThreadPrioritySchema.parse(input)));
  ipcMain.handle(channels.archiveWorkThread, (_event, id) => service.archiveWorkThread(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.restoreWorkThread, (_event, id) => service.restoreWorkThread(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.deleteWorkThread, (_event, id) => service.deleteWorkThread(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.createWorkspace, (_event, input) => service.createWorkspace(createWorkspaceSchema.parse(input)));
  ipcMain.handle(channels.listWorkspaceLinkCandidates, (_event, input) => service.listWorkspaceLinkCandidates(workspaceLinkInputSchema.parse(input)));
  ipcMain.handle(channels.deleteWorkspace, (_event, workspaceId, force) => service.deleteWorkspace(sessionIdSchema.parse(workspaceId), Boolean(force)));
  ipcMain.handle(channels.openWorkspaceInVSCode, async (_event, workspaceId) => {
    const url = vscodeWorkspaceUrl(service.snapshot(), sessionIdSchema.parse(workspaceId));
    await shell.openExternal(url);
  });
  ipcMain.handle(channels.openWorkspaceTmuxInIterm, (_event, workspaceId) => service.openWorkspaceTmuxInIterm(sessionIdSchema.parse(workspaceId)));
  ipcMain.handle(channels.createSession, (_event, input) => service.createSession(createSessionSchema.parse(input)));
  ipcMain.handle(channels.saveTerminalPreset, (_event, input) => service.saveTerminalPreset(saveTerminalPresetSchema.parse(input)));
  ipcMain.handle(channels.deleteTerminalPreset, (_event, input) => service.deleteTerminalPreset(deleteTerminalPresetSchema.parse(input)));
  ipcMain.on(channels.setFocusMode, (event, enabled) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    owner?.setWindowButtonPosition({ x: 16, y: z.boolean().parse(enabled) ? 13 : 18 });
  });
  ipcMain.handle(channels.resumeSession, (_event, id) => service.resumeSession(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.reorderSessions, (_event, input) => service.reorderSessions(reorderSessionsSchema.parse(input)));
  ipcMain.handle(channels.markSessionViewed, (_event, id) => service.markSessionViewed(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.attachSession, (_event, id) => service.attachSession(sessionIdSchema.parse(id)));
  ipcMain.on(channels.writeSession, (_event, id, data) => service.writeSession(sessionIdSchema.parse(id), z.string().parse(data)));
  ipcMain.on(channels.resizeSession, (_event, id, cols, rows) => service.resizeSession(sessionIdSchema.parse(id), z.number().int().min(2).parse(cols), z.number().int().min(1).parse(rows)));
  ipcMain.handle(channels.killSession, (_event, id, force) => service.killSession(sessionIdSchema.parse(id), Boolean(force)));
  ipcMain.handle(channels.renameSession, (_event, input) => service.renameSession(renameSessionSchema.parse(input)));
}
