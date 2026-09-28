import assert from "node:assert/strict";
import test from "node:test";
import type { SessionKind } from "../src/shared/domain";
import { terminalInputForKeyEvent, type TerminalKeyEvent } from "../src/renderer/src/features/workspace/terminal-keyboard";

const keyEvent = (overrides: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent => ({
  type: "keydown",
  key: "Enter",
  keyCode: 13,
  shiftKey: true,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  ...overrides
});

test("Shift+Enter sends LF to insert a newline in a Codex prompt", () => {
  assert.equal(terminalInputForKeyEvent("codex", keyEvent()), "\n");
});

test("Shift+Enter keeps the terminal default outside Codex sessions", () => {
  for (const kind of ["shell", "tmux"] satisfies SessionKind[]) {
    assert.equal(terminalInputForKeyEvent(kind, keyEvent()), undefined);
  }
});

test("ordinary Enter and modified shortcuts keep the terminal default", () => {
  assert.equal(terminalInputForKeyEvent("codex", keyEvent({ shiftKey: false })), undefined);
  assert.equal(terminalInputForKeyEvent("codex", keyEvent({ ctrlKey: true })), undefined);
  assert.equal(terminalInputForKeyEvent("codex", keyEvent({ altKey: true })), undefined);
  assert.equal(terminalInputForKeyEvent("codex", keyEvent({ metaKey: true })), undefined);
  assert.equal(terminalInputForKeyEvent("codex", keyEvent({ type: "keyup" })), undefined);
});

test("IME composition events stay on xterm's native composition path", () => {
  assert.equal(terminalInputForKeyEvent("codex", keyEvent({ key: "Process", keyCode: 229 })), undefined);
  assert.equal(terminalInputForKeyEvent("codex", keyEvent({ isComposing: true })), undefined);
});
