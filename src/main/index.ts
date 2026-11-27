import { BrowserRuntime } from "./runtime/browser-runtime";
import { FilePreviewRuntime, FILE_PREVIEW_SCHEME } from "./runtime/file-preview-runtime";
import { app, BrowserWindow, dialog, net, powerMonitor, protocol, safeStorage } from "electron";
import { GitHostingStore } from "./persistence/git-hosting-store";
import { GitHostingService } from "./application/git-hosting-service";
import { join } from "node:path";
import { applicationUserDataPath } from "./application-paths";
import { WorkspaceService } from "./application/workspace-service";
import { registerIpcHandlers } from "./ipc/register-handlers";
import { createApplicationMenu } from "./menu/create-application-menu";
import { JsonStore } from "./persistence/json-store";
import { createMainWindow } from "./windows/create-main-window";
import { channels } from "../shared/contract";
import { DeviceCodexRecordingInstaller } from "./runtime/codex-recording";
import { terminalCloseOptions } from "./application/terminal-close-confirmation";

let mainWindow: BrowserWindow | null = null;
protocol.registerSchemesAsPrivileged([{ scheme: FILE_PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// Keep development and packaged builds on the same persistent application data.
app.setPath("userData", applicationUserDataPath(app.getPath("appData")));
app.setName("Super Thread");

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock.setIcon(join(process.resourcesPath, "icon.png"));
  }

  const hosting = new GitHostingService(new GitHostingStore(join(app.getPath("userData"), "git-hosting.json"), safeStorage), (url, init) => net.fetch(url, init));
  const service = new WorkspaceService(new JsonStore(join(app.getPath("userData"), "workspace-runtime.json")), undefined, undefined, undefined, undefined, undefined, undefined, new DeviceCodexRecordingInstaller(), hosting);
  await service.initialize();
  const browsers = new BrowserRuntime(service);
  const previews = new FilePreviewRuntime(service);
  let quitRequested = false;
  registerIpcHandlers(service, (owner) => {
    if (quitRequested) app.quit();
    else owner.close();
  }, browsers, previews);
  powerMonitor.on("resume", () => service.reconnectTunnels());
  app.once("will-quit", () => service.shutdown());
  let quitConfirmed = false;
  let quitChecking = false;
  app.on("before-quit", (event) => {
    if (quitConfirmed) { quitRequested = true; return; }
    event.preventDefault();
    if (quitChecking) return;
    quitRequested = false;
    quitChecking = true;
    void (async () => {
      const options = terminalCloseOptions(await service.inspectTerminalPrograms(), "quit");
      if (options) {
        const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
        const result = await (owner && !owner.isDestroyed() ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
        if (result.response !== 0) return;
      }
      quitConfirmed = true;
      app.quit();
    })().catch((error) => {
      dialog.showErrorBox("Could not check terminal activity", String(error));
    }).finally(() => {
      quitChecking = false;
    });
  });

  const openWindow = (): BrowserWindow => {
    mainWindow = createMainWindow();
    browsers.attach(mainWindow);
    previews.attach(mainWindow);
    service.setWindowOpen(true);
    mainWindow.on("closed", () => {
      mainWindow = null;
      service.setWindowOpen(false);
    });
    return mainWindow;
  };

  service.on("changed", () => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channels.dataChanged)));
  service.on("git-hosting-changed", () => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channels.gitHostingChanged)));
  service.on("workspace-merge-request-changed", (operation) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channels.workspaceMergeRequestChanged, operation)));
  service.on("work-thread-creation-changed", (state) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channels.workThreadCreationChanged, state)));
  service.on("tunnels-changed", () => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channels.tunnelsChanged)));
  service.on("terminal-output", (event) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channels.terminalOutput, event)));
  createApplicationMenu(() => mainWindow);
  openWindow();

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) openWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
