import { contextBridge, ipcRenderer } from "electron";
import { channels, type DesktopBridge, type MenuAction } from "../shared/contract";
import type { BrowserState, BrowserTab, TerminalOutput } from "../shared/domain";

const bridge: DesktopBridge = {
  createBrowser: (input) => ipcRenderer.invoke(channels.createBrowser, input),
  navigateBrowser: (input) => ipcRenderer.invoke(channels.navigateBrowser, input),
  closeBrowser: (id) => ipcRenderer.invoke(channels.closeBrowser, id),
  reorderWorkspaceTabs: (input) => ipcRenderer.invoke(channels.reorderWorkspaceTabs, input),
  browserCommand: (input) => ipcRenderer.invoke(channels.browserCommand, input),
  browserLayout: (input) => ipcRenderer.invoke(channels.browserLayout, input),
  browserStates: () => ipcRenderer.invoke(channels.browserStates),
  onBrowserStateChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: BrowserState): void => listener(state);
    ipcRenderer.on(channels.browserStateChanged, wrapped);
    return () => ipcRenderer.removeListener(channels.browserStateChanged, wrapped);
  },
  onBrowserCreated: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, tab: BrowserTab): void => listener(tab);
    ipcRenderer.on(channels.browserCreated, wrapped);
    return () => ipcRenderer.removeListener(channels.browserCreated, wrapped);
  },
  platform: process.platform,
  openDocumentLink: (url) => ipcRenderer.invoke(channels.openDocumentLink, url),
  finishDocumentClose: () => ipcRenderer.send(channels.finishDocumentClose),
  snapshot: () => ipcRenderer.invoke(channels.snapshot),
  selectDirectory: () => ipcRenderer.invoke(channels.selectDirectory),
  browseDirectory: (input) => ipcRenderer.invoke(channels.browseDirectory, input),
  addDevice: (input) => ipcRenderer.invoke(channels.addDevice, input),
  updateDevice: (input) => ipcRenderer.invoke(channels.updateDevice, input),
  deleteDevice: (id) => ipcRenderer.invoke(channels.deleteDevice, id),
  pingDevices: () => ipcRenderer.invoke(channels.pingDevices),
  addProject: (input) => ipcRenderer.invoke(channels.addProject, input),
  updateProject: (input) => ipcRenderer.invoke(channels.updateProject, input),
  deleteProject: (id) => ipcRenderer.invoke(channels.deleteProject, id),
  setupProject: (input) => ipcRenderer.invoke(channels.setupProject, input),
  createWorkThread: (input) => ipcRenderer.invoke(channels.createWorkThread, input),
  renameWorkThread: (input) => ipcRenderer.invoke(channels.renameWorkThread, input),
  saveWorkThreadDocument: (input) => ipcRenderer.invoke(channels.saveWorkThreadDocument, input),
  setWorkThreadPinned: (input) => ipcRenderer.invoke(channels.setWorkThreadPinned, input),
  archiveWorkThread: (id) => ipcRenderer.invoke(channels.archiveWorkThread, id),
  restoreWorkThread: (id) => ipcRenderer.invoke(channels.restoreWorkThread, id),
  deleteWorkThread: (id) => ipcRenderer.invoke(channels.deleteWorkThread, id),
  createWorkspace: (input) => ipcRenderer.invoke(channels.createWorkspace, input),
  listWorkspaceLinkCandidates: (input) => ipcRenderer.invoke(channels.listWorkspaceLinkCandidates, input),
  renameWorkspace: (input) => ipcRenderer.invoke(channels.renameWorkspace, input),
  deleteWorkspace: (id, force) => ipcRenderer.invoke(channels.deleteWorkspace, id, force),
  openWorkspaceInVSCode: (id) => ipcRenderer.invoke(channels.openWorkspaceInVSCode, id),
  openWorkspaceTmuxInIterm: (id) => ipcRenderer.invoke(channels.openWorkspaceTmuxInIterm, id),
  createSession: (input) => ipcRenderer.invoke(channels.createSession, input),
  saveTerminalPreset: (input) => ipcRenderer.invoke(channels.saveTerminalPreset, input),
  deleteTerminalPreset: (input) => ipcRenderer.invoke(channels.deleteTerminalPreset, input),
  setFocusMode: (enabled) => ipcRenderer.send(channels.setFocusMode, enabled),
  resumeSession: (id) => ipcRenderer.invoke(channels.resumeSession, id),
  reorderSessions: (input) => ipcRenderer.invoke(channels.reorderSessions, input),
  markSessionViewed: (id) => ipcRenderer.invoke(channels.markSessionViewed, id),
  attachSession: (id) => ipcRenderer.invoke(channels.attachSession, id),
  writeSession: (id, data) => ipcRenderer.send(channels.writeSession, id, data),
  resizeSession: (id, cols, rows) => ipcRenderer.send(channels.resizeSession, id, cols, rows),
  killSession: (id, force) => ipcRenderer.invoke(channels.killSession, id, force),
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
