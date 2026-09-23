import { app, BrowserWindow, powerMonitor } from "electron";
import { join } from "node:path";
import { WorkspaceService } from "./application/workspace-service";
import { registerIpcHandlers } from "./ipc/register-handlers";
import { createApplicationMenu } from "./menu/create-application-menu";
import { JsonStore } from "./persistence/json-store";
import { createMainWindow } from "./windows/create-main-window";
import { channels } from "../shared/contract";

let mainWindow: BrowserWindow | null = null;

// Keep existing project data when the displayed app name changes.
app.setPath("userData", join(app.getPath("appData"), process.env.ELECTRON_RENDERER_URL ? "super-thread" : "SuperThread"));
app.setName("Super Thread");

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock.setIcon(join(process.resourcesPath, "icon.png"));
  }

  const service = new WorkspaceService(new JsonStore(join(app.getPath("userData"), "workspace-runtime.json")));
  await service.initialize();
  registerIpcHandlers(service);
  powerMonitor.on("resume", () => service.reconnectTunnels());
  app.once("will-quit", () => service.shutdown());

  const openWindow = (): BrowserWindow => {
    mainWindow = createMainWindow();
    mainWindow.on("closed", () => { mainWindow = null; });
    return mainWindow;
  };

  service.on("changed", () => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channels.dataChanged)));
  service.on("terminal-output", (event) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channels.terminalOutput, event)));
  createApplicationMenu(() => mainWindow);
  openWindow();

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) openWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
