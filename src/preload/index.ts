import { contextBridge, ipcRenderer } from "electron";
import { channels, type DesktopBridge, type MenuAction } from "../shared/contract";
import type { TerminalOutput } from "../shared/domain";

const bridge: DesktopBridge = {
  platform: process.platform,
  snapshot: () => ipcRenderer.invoke(channels.snapshot),
  selectDirectory: () => ipcRenderer.invoke(channels.selectDirectory),
  browseDirectory: (input) => ipcRenderer.invoke(channels.browseDirectory, input),
  addDevice: (input) => ipcRenderer.invoke(channels.addDevice, input),
  updateDevice: (input) => ipcRenderer.invoke(channels.updateDevice, input),
  deleteDevice: (id) => ipcRenderer.invoke(channels.deleteDevice, id),
  pingDevices: () => ipcRenderer.invoke(channels.pingDevices),
  addProject: (input) => ipcRenderer.invoke(channels.addProject, input),
  setupProject: (input) => ipcRenderer.invoke(channels.setupProject, input),
  createWorkThread: (input) => ipcRenderer.invoke(channels.createWorkThread, input),
  archiveWorkThread: (id) => ipcRenderer.invoke(channels.archiveWorkThread, id),
  restoreWorkThread: (id) => ipcRenderer.invoke(channels.restoreWorkThread, id),
  deleteWorkThread: (id) => ipcRenderer.invoke(channels.deleteWorkThread, id),
  createWorkspace: (input) => ipcRenderer.invoke(channels.createWorkspace, input),
  deleteWorkspace: (id, force) => ipcRenderer.invoke(channels.deleteWorkspace, id, force),
  openWorkspaceInVSCode: (id) => ipcRenderer.invoke(channels.openWorkspaceInVSCode, id),
  createSession: (input) => ipcRenderer.invoke(channels.createSession, input),
  resumeSession: (id) => ipcRenderer.invoke(channels.resumeSession, id),
  attachSession: (id) => ipcRenderer.invoke(channels.attachSession, id),
  writeSession: (id, data) => ipcRenderer.send(channels.writeSession, id, data),
  resizeSession: (id, cols, rows) => ipcRenderer.send(channels.resizeSession, id, cols, rows),
  killSession: (id) => ipcRenderer.invoke(channels.killSession, id),
  renameSession: (input) => ipcRenderer.invoke(channels.renameSession, input),
  onTerminalOutput: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, output: TerminalOutput): void => listener(output);
    ipcRenderer.on(channels.terminalOutput, wrapped);
    return () => ipcRenderer.removeListener(channels.terminalOutput, wrapped);
  },
  onDataChanged: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on(channels.dataChanged, wrapped);
    return () => ipcRenderer.removeListener(channels.dataChanged, wrapped);
  },
  onMenuAction: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, action: MenuAction): void => listener(action);
    ipcRenderer.on(channels.menuAction, wrapped);
    return () => ipcRenderer.removeListener(channels.menuAction, wrapped);
  }
};

contextBridge.exposeInMainWorld("desktop", bridge);
