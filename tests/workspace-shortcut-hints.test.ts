import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceShortcutHints } from "../src/renderer/src/features/workspace/workspace-shortcut-hints";

test("hints appear only after holding Command for three seconds, without restarting on repeated input", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = false;
  const hints = new WorkspaceShortcutHints((value) => { visible = value; });
  hints.update({ commandHeld: true });
  t.mock.timers.tick(2_000);
  hints.update({ commandHeld: true });
  t.mock.timers.tick(999);
  assert.equal(visible, false);
  t.mock.timers.tick(1);
  assert.equal(visible, true);
  hints.update({ commandHeld: false });
  assert.equal(visible, false);
});

test("quick Command presses cancel pending hints and each new hold starts a full delay", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = false;
  const hints = new WorkspaceShortcutHints((value) => { visible = value; });
  hints.update({ commandHeld: true });
  t.mock.timers.tick(2_999);
  hints.update({ commandHeld: false });
  t.mock.timers.tick(5_000);
  assert.equal(visible, false);
  hints.update({ commandHeld: true });
  t.mock.timers.tick(2_999);
  assert.equal(visible, false);
  t.mock.timers.tick(1);
  assert.equal(visible, true);
});

test("number switching clears both pending and visible hints even if native focus loses Command release", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const holdDuration of [0, 1_500, 3_000]) {
    let visible = false;
    const hints = new WorkspaceShortcutHints((value) => { visible = value; });
    hints.update({ commandHeld: true });
    t.mock.timers.tick(holdDuration);
    hints.update({ commandHeld: true, tabIndex: 1 });
    assert.equal(visible, false);
    // Key repeats or number-key release can still report Command as held.
    hints.update({ commandHeld: true });
    t.mock.timers.tick(5_000);
    assert.equal(visible, false);
    hints.update({ commandHeld: false });
    hints.update({ commandHeld: true });
    t.mock.timers.tick(3_000);
    assert.equal(visible, true);
    hints.clear();
  }
});

test("blur, dialog, workspace switch and unmount cleanup cancel pending or visible hints", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const holdDuration of [1_500, 3_000]) {
    let visible = false;
    const hints = new WorkspaceShortcutHints((value) => { visible = value; });
    hints.update({ commandHeld: true });
    t.mock.timers.tick(holdDuration);
    hints.clear();
    assert.equal(visible, false);
    t.mock.timers.tick(5_000);
    assert.equal(visible, false);
    hints.update({ commandHeld: true });
    t.mock.timers.tick(3_000);
    assert.equal(visible, true);
    hints.clear();
  }
});
