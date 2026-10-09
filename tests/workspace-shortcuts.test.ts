import assert from "node:assert/strict";
import test from "node:test";
import { workspaceShortcut } from "../src/shared/workspace-shortcuts";

const input = { type: "keyDown", key: "1", meta: true, control: false, alt: false, shift: false, isAutoRepeat: false };

test("Command press/release and other keys track hint visibility", () => {
  assert.equal(workspaceShortcut({ ...input, key: "Meta", meta: false }).commandHeld, true);
  assert.equal(workspaceShortcut({ ...input, key: "Meta", type: "keyUp" }).commandHeld, false);
  assert.equal(workspaceShortcut({ ...input, key: "a" }).commandHeld, true);
  assert.equal(workspaceShortcut({ ...input, key: "a", meta: false }).commandHeld, false);
});

test("Command 1–9 addresses tabs in display order", () => {
  for (let digit = 1; digit <= 9; digit++) {
    assert.equal(workspaceShortcut({ ...input, key: String(digit) }).tabIndex, digit - 1);
  }
});

test("other shortcuts, key releases and repeats do not switch tabs", () => {
  for (const change of [{ meta: false }, { control: true }, { alt: true }, { shift: true }, { key: "0" }, { key: "a" }, { type: "keyUp" }, { isAutoRepeat: true }]) {
    assert.equal(workspaceShortcut({ ...input, ...change }).tabIndex, undefined);
  }
});
