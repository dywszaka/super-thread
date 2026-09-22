import { BrowserWindow, dialog, ipcMain } from "electron";
import { z } from "zod";
import {
  addProjectSchema,
  addRemoteDeviceSchema,
  browseDirectorySchema,
  channels,
  createSessionSchema,
  createWorkThreadSchema,
  createWorkspaceSchema,
  renameSessionSchema,
  setupProjectSchema,
  updateRemoteDeviceSchema
} from "../../shared/contract";
import type { WorkspaceService } from "../application/workspace-service";

const sessionIdSchema = z.string().min(1);

export function registerIpcHandlers(service: WorkspaceService): void {
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
  ipcMain.handle(channels.setupProject, (_event, input) => service.setupProject(setupProjectSchema.parse(input)));
  ipcMain.handle(channels.createWorkThread, (_event, input) => service.createWorkThread(createWorkThreadSchema.parse(input)));
  ipcMain.handle(channels.archiveWorkThread, (_event, id) => service.archiveWorkThread(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.restoreWorkThread, (_event, id) => service.restoreWorkThread(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.deleteWorkThread, (_event, id) => service.deleteWorkThread(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.createWorkspace, (_event, input) => service.createWorkspace(createWorkspaceSchema.parse(input)));
  ipcMain.handle(channels.deleteWorkspace, (_event, workspaceId, force) => service.deleteWorkspace(sessionIdSchema.parse(workspaceId), Boolean(force)));
  ipcMain.handle(channels.createSession, (_event, input) => service.createSession(createSessionSchema.parse(input)));
  ipcMain.handle(channels.resumeSession, (_event, id) => service.resumeSession(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.attachSession, (_event, id) => service.attachSession(sessionIdSchema.parse(id)));
  ipcMain.on(channels.writeSession, (_event, id, data) => service.writeSession(sessionIdSchema.parse(id), z.string().parse(data)));
  ipcMain.on(channels.resizeSession, (_event, id, cols, rows) => service.resizeSession(sessionIdSchema.parse(id), z.number().int().min(2).parse(cols), z.number().int().min(1).parse(rows)));
  ipcMain.handle(channels.killSession, (_event, id) => service.killSession(sessionIdSchema.parse(id)));
  ipcMain.handle(channels.renameSession, (_event, input) => service.renameSession(renameSessionSchema.parse(input)));
}
