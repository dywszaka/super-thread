import assert from "node:assert/strict";
import test from "node:test";
import { codexActivityFromOutput, foregroundProcessIsBusy, TerminalRuntime, tmuxPaneIsBusy } from "../src/main/runtime/terminal-runtime";

test("attach returns a sequenced replay without emitting it as live output", () => {
  const runtime = new TerminalRuntime();
  const internal = runtime as unknown as {
    sessions: Map<string, { pty: unknown; buffer: string; sequence: number }>;
  };
  internal.sessions.set("session-1", { pty: {}, buffer: "historic output", sequence: 7 });
  let emitted = false;
  runtime.on("output", () => { emitted = true; });

  assert.deepEqual(runtime.attach("session-1"), { data: "historic output", sequence: 7 });
  assert.equal(emitted, false);
});

test("attach returns an empty baseline for a missing runtime session", () => {
  const runtime = new TerminalRuntime();
  assert.deepEqual(runtime.attach("missing"), { data: "", sequence: 0 });
});

test("foreground process groups distinguish an idle shell from an occupying command", () => {
  assert.equal(foregroundProcessIsBusy(" 123 123\n"), false);
  assert.equal(foregroundProcessIsBusy(" 123 456\n"), true);
  assert.equal(foregroundProcessIsBusy(""), false);
});

test("tmux pane commands distinguish a shell prompt from an occupying command", () => {
  assert.equal(tmuxPaneIsBusy("zsh\n"), false);
  assert.equal(tmuxPaneIsBusy("/bin/bash\n"), false);
  assert.equal(tmuxPaneIsBusy("npm\n"), true);
});

test("Codex output distinguishes working from waiting for input", () => {
  assert.equal(codexActivityFromOutput("Working (12s • esc to interrupt)"), "busy");
  assert.equal(codexActivityFromOutput("\n› Implement the next feature"), "waiting-input");
  assert.equal(codexActivityFromOutput("Permission required: allow this command?"), "waiting-input");
});
