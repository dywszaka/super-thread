import assert from "node:assert/strict";
import test from "node:test";
import { codexActivityFromOutput, foregroundProcessIsBusy, TerminalRuntime, tmuxActivityFromProbe, tmuxAttachCommand, tmuxClientSessionName, tmuxPaneIsBusy, tmuxTarget } from "../src/main/runtime/terminal-runtime";
import { interactiveLoginShellCommand, quoteShellArgument } from "../src/main/runtime/login-shell";
import type { Session } from "../src/shared/domain";

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
  assert.equal(
    tmuxActivityFromProbe("node\n› sleep 30\nWorking (2s • esc to interrupt)\nRan sleep 30\nAsk Codex to do anything"),
    "waiting-input"
  );
  assert.equal(
    tmuxActivityFromProbe("node\n› inspect the code\nAsk Codex to do anything\nWorking (2s • esc to interrupt)"),
    "busy"
  );
  assert.equal(tmuxActivityFromProbe("node\nDevelopment server listening on port 3000"), "busy");
});

test("tmux tabs attach distinct windows in one workspace session", () => {
  const first: Session = {
    id: "session-1", workspaceId: "workspace-1", name: "tmux 1", status: "running", kind: "tmux", shell: "tmux",
    tmuxSessionName: "superthread-workspace-1", tmuxWindowName: "session-1", createdAt: "now"
  };
  const second: Session = { ...first, id: "session-2", name: "tmux 2", tmuxWindowName: "session-2" };

  assert.equal(tmuxTarget(first), "superthread-workspace-1:session-1");
  assert.equal(tmuxTarget(second), "superthread-workspace-1:session-2");
  assert.equal(tmuxClientSessionName(second), "superthread-client-session-2");
  const command = tmuxAttachCommand(second, "/tmp/demo worktree");
  assert.match(command, /tmux has-session -t 'superthread-workspace-1'/);
  assert.match(command, /tmux new-window .* -n 'session-2' -c '\/tmp\/demo worktree'/);
  assert.match(command, /tmux new-session -d -t 'superthread-workspace-1' -s 'superthread-client-session-2'/);
  assert.match(command, /tmux select-window -t 'superthread-client-session-2:session-2'/);
  assert.match(command, /tmux attach-session -t 'superthread-client-session-2'/);
});

test("legacy tmux tabs retain their original attach behavior", () => {
  const session: Session = {
    id: "session-1", workspaceId: "workspace-1", name: "tmux 1", status: "running", kind: "tmux", shell: "tmux",
    tmuxSessionName: "legacy-session", createdAt: "now"
  };
  assert.equal(tmuxAttachCommand(session, "/tmp/demo"), "tmux new-session -A -s 'legacy-session'");
});

test("Codex output distinguishes working from waiting for input", () => {
  assert.equal(codexActivityFromOutput("Working (12s • esc to interrupt)"), "busy");
  assert.equal(codexActivityFromOutput("\n› Implement the next feature"), "waiting-input");
  assert.equal(codexActivityFromOutput("Permission required: allow this command?"), "waiting-input");
  assert.equal(codexActivityFromOutput("› old request\nWorking (12s • esc to interrupt)"), "busy");
  assert.equal(codexActivityFromOutput("Working (12s • esc to interrupt)\nAsk Codex to do anything"), "waiting-input");
});
