import { app, Menu, type BrowserWindow } from "electron";
import { channels, type MenuAction } from "../../shared/contract";
import { applicationMenuTemplate } from "./application-menu-template";

export function createApplicationMenu(getWindow: () => BrowserWindow | null): void {
  const send = (action: MenuAction): void => { getWindow()?.webContents.send(channels.menuAction, action); };
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(app.name, send)));
}
