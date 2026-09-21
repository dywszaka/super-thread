import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { channels, type MenuAction } from "../../shared/contract";

export function createApplicationMenu(getWindow: () => BrowserWindow | null): void {
  const send = (action: MenuAction): void => { getWindow()?.webContents.send(channels.menuAction, action); };
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" }, { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", enabled: false },
        { type: "separator" }, { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }
      ]
    },
    {
      label: "File",
      submenu: [
        { label: "New Workspace…", accelerator: "CmdOrCtrl+N", click: () => send("new-workspace") },
        { label: "New Terminal", accelerator: "CmdOrCtrl+T", click: () => send("new-terminal") },
        { type: "separator" },
        { label: "Add Project…", accelerator: "CmdOrCtrl+Shift+P", click: () => send("add-project") },
        { label: "Add Device…", accelerator: "CmdOrCtrl+Shift+D", click: () => send("add-device") },
        { type: "separator" }, { role: "close" }
      ]
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
