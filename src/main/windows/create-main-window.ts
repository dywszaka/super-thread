import { BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 880,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#11100f" : "#f6f5f3",
    titleBarStyle: "hidden",
    frame: false,
    trafficLightPosition: { x: 16, y: 18 },
    acceptFirstMouse: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron's sandboxed preload loader does not support this ESM bundle.
      // contextIsolation + no Node integration still keeps the renderer isolated.
      sandbox: false
    }
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else window.loadFile(join(__dirname, "../renderer/index.html"));
  return window;
}
