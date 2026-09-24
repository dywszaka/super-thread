import assert from "node:assert/strict";
import test from "node:test";
import { codexActivityFromOutput, foregroundProcessIsBusy, TerminalRuntime, tmuxActivityFromProbe, tmuxPaneIsBusy } from "../src/main/runtime/terminal-runtime";
import { interactiveLoginShellCommand, quoteShellArgument } from "../src/main/runtime/login-shell";

test("managed tools run through the user's interactive login shell", () => {
  assert.equal(quoteShellArgument("it's here"), `'it'\\''s here'`);
  assert.equal(
    interactiveLoginShellCommand("command -v codex"),
    `exec "\${SHELL:-/bin/sh}" -lic 'command -v codex'`
  );
});

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

test("tmux activity distinguishes Codex work from waiting for input", () => {
  assert.equal(tmuxActivityFromProbe("zsh\n% "), "idle");
  assert.equal(tmuxActivityFromProbe("npm\nBuilding renderer..."), "busy");
  assert.equal(tmuxActivityFromProbe("codex\nWorking (12s • esc to interrupt)"), "busy");
  assert.equal(tmuxActivityFromProbe("codex\n\n› Implement the next feature"), "waiting-input");
  assert.equal(tmuxActivityFromProbe("codex-aarch64-apple-darwin\nPermission required: allow this command?"), "waiting-input");
});

test("Codex output distinguishes working from waiting for input", () => {
  assert.equal(codexActivityFromOutput("Working (12s • esc to interrupt)"), "busy");
  assert.equal(codexActivityFromOutput("\n› Implement the next feature"), "waiting-input");
  assert.equal(codexActivityFromOutput("Permission required: allow this command?"), "waiting-input");
});
