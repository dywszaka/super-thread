import { app, BrowserWindow, dialog, powerMonitor, type MessageBoxOptions } from "electron";
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
  let quitConfirmed = false;
  app.on("before-quit", (event) => {
    if (quitConfirmed) return;
    const running = service.runningSessionSummaries();
    if (running.length === 0) return;
    event.preventDefault();
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options: MessageBoxOptions = {
      type: "warning",
      buttons: ["Quit Super Thread", "Cancel"],
      cancelId: 1,
      defaultId: 1,
      message: "Terminal sessions are still running",
      detail: running.slice(0, 8).join("\n") + (running.length > 8 ? `\n…and ${running.length - 8} more` : "")
    };
    const prompt = owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
    void prompt.then((result) => {
      if (result.response !== 0) return;
      quitConfirmed = true;
      app.quit();
    });
  });

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
