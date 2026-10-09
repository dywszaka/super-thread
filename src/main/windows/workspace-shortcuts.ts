import type { BrowserWindow, WebContents } from "electron";
import { channels } from "../../shared/contract";
import { workspaceShortcut } from "../../shared/workspace-shortcuts";

const tabCounts = new WeakMap<BrowserWindow, number>();

export function setWorkspaceShortcutCount(window: BrowserWindow, count: number): void {
  tabCounts.set(window, count);
}

/** Native page views do not bubble keyboard events to the app renderer. */
export function attachWorkspaceShortcuts(window: BrowserWindow, contents: WebContents): void {
  contents.on("before-input-event", (event, input) => {
    if (window.isDestroyed()) return;
    const shortcut = workspaceShortcut(input);
    if (shortcut.tabIndex !== undefined) {
      if (shortcut.tabIndex < (tabCounts.get(window) ?? 0)) {
        event.preventDefault();
        window.webContents.focus();
      }
      else shortcut.tabIndex = undefined;
    }
    window.webContents.send(channels.workspaceShortcut, shortcut);
  });
}
