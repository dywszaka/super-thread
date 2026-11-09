import type { MenuItemConstructorOptions } from "electron";
import type { MenuAction } from "../../shared/contract";

export function applicationMenuTemplate(appName: string, send: (action: MenuAction) => void): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: "about" }, { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => send("settings") },
        { type: "separator" }, { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }
      ]
    },
    {
      label: "File",
      submenu: [
        { label: "New Work Thread…", accelerator: "CmdOrCtrl+N", click: () => send("new-work-thread") },
        { label: "New Workspace…", accelerator: "CmdOrCtrl+Shift+N", click: () => send("new-workspace") },
        { label: "New Terminal", accelerator: "CmdOrCtrl+T", click: () => send("new-terminal") },
        { type: "separator" },
        { label: "Add Project…", accelerator: "CmdOrCtrl+Shift+P", click: () => send("add-project") },
        { label: "Add Device…", accelerator: "CmdOrCtrl+Shift+D", click: () => send("add-device") },
        { type: "separator" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => send("close-tab") },
        { role: "close", label: "Close Window", accelerator: "CmdOrCtrl+Shift+W" }
      ]
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        { label: "Reload Tab", accelerator: "CmdOrCtrl+R", click: () => send("reload-tab") },
        { role: "reload", label: "Reload App", accelerator: "CmdOrCtrl+Shift+R" },
        { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }
      ]
    },
    { role: "windowMenu" }
  ];
}
