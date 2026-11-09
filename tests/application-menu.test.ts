import assert from "node:assert/strict";
import test from "node:test";
import type { KeyboardEvent, MenuItem, MenuItemConstructorOptions } from "electron";
import { applicationMenuTemplate } from "../src/main/menu/application-menu-template";
import type { MenuAction } from "../src/shared/contract";

function items(send: (action: MenuAction) => void): MenuItemConstructorOptions[] {
  return applicationMenuTemplate("Super Thread", send).flatMap((menu) => Array.isArray(menu.submenu) ? menu.submenu : []);
}

test("Command W/R dispatch tab actions instead of native window close/app reload", () => {
  const actions: MenuAction[] = [];
  const menu = items((action) => actions.push(action));
  for (const [key, action] of [["W", "close-tab"], ["R", "reload-tab"]] as const) {
    const matches = menu.filter((item) => item.accelerator === `CmdOrCtrl+${key}`);
    assert.equal(matches.length, 1);
    const item = matches[0]!;
    assert.equal(item.role, undefined);
    assert.ok(item.click);
    item.click({} as MenuItem, undefined, {} as KeyboardEvent);
    assert.equal(actions.at(-1), action);
  }
  assert.deepEqual(actions, ["close-tab", "reload-tab"]);
});

test("window close and application reload retain distinct explicit shortcuts", () => {
  const actions: MenuAction[] = [];
  const menu = items((action) => actions.push(action));
  assert.equal(menu.find((item) => item.role === "close")?.accelerator, "CmdOrCtrl+Shift+W");
  assert.equal(menu.find((item) => item.role === "reload")?.accelerator, "CmdOrCtrl+Shift+R");
  const accelerators = menu.flatMap((item) => item.accelerator ? [item.accelerator] : []);
  assert.equal(new Set(accelerators).size, accelerators.length);
  assert.deepEqual(actions, []);
});
