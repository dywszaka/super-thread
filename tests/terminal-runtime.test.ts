import assert from "node:assert/strict";
import test from "node:test";
import type { IPty } from "node-pty";
import { foregroundProcessIsBusy, sshTerminalArgs, TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import type { Device, DeviceConnection, Session, Workspace } from "../src/shared/domain";

const session: Session = { id: "terminal", workspaceId: "workspace", name: "Terminal", status: "running", kind: "shell", shell: "ssh", createdAt: "now" };
const device: Device = { id: "remote", name: "Remote", type: "remote", status: "online", createdAt: "now" };
const connection: DeviceConnection = { deviceId: device.id, transport: "ssh", config: { host: "never-connected.invalid", user: "builder", port: 2222 } };
const workspace = { id: "workspace", path: "/tmp/demo worktree" } as Workspace;

function fakePty() {
  let onData: (data: string) => void = () => {};
  let onExit: (event: { exitCode: number }) => void = () => {};
  const input: string[] = [];
  const sizes: number[][] = [];
  const instance = {
    pid: 123, onData: (callback: typeof onData) => { onData = callback; },
    onExit: (callback: typeof onExit) => { onExit = callback; },
    write: (data: string) => { input.push(data); },
    resize: (cols: number, rows: number) => { sizes.push([cols, rows]); },
    kill: () => onExit({ exitCode: 0 })
  } as unknown as IPty;
  return { instance, input, sizes, output: (data: string) => onData(data) };
}

test("remote terminals use one SSH PTY and never schedule background probes", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const terminal = fakePty();
  const spawns: Array<{ program: string; args: string[] | string }> = [];
  let probes = 0;
  const runtime = new TerminalRuntime(async () => { probes++; return ""; }, (program, args) => {
    spawns.push({ program, args: args! });
    return terminal.instance;
  });
  runtime.create(session, workspace, device, connection);
  terminal.output("prompt ready\r\n");
  assert.deepEqual(runtime.attach(session.id), { data: "prompt ready\r\n", sequence: 1 });
  // Reattaching after a renderer/window disconnect must not create another PTY.
  runtime.attach(session.id);
  runtime.write(session.id, "echo hi\r");
  runtime.resize(session.id, 120, 40);
  t.mock.timers.tick(86_400_000);
  assert.equal(probes, 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]?.program, "ssh");
  assert.doesNotMatch(String(spawns[0]?.args), /-lic|superthread-pid|codex|tmux/);
  assert.deepEqual(terminal.input, ["echo hi\r"]);
  assert.deepEqual(terminal.sizes, [[120, 40]]);
  assert.equal(runtime.has(session.id), true);
  runtime.kill(session.id);
  assert.equal(runtime.has(session.id), false);
});

test("runtime refuses removed managed kinds before spawning", () => {
  let spawns = 0;
  const runtime = new TerminalRuntime(undefined, () => { spawns++; return fakePty().instance; });
  for (const kind of ["tmux", "codex"]) {
    assert.throws(() => runtime.create({ ...session, kind } as unknown as Session, workspace, device, connection), /Only shell/);
  }
  assert.equal(spawns, 0);
});

test("local activity sampling emits command completion and ignores a late result after exit", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const terminal = fakePty();
  let output = "123 456";
  let pending: ((value: string) => void) | undefined;
  const runtime = new TerminalRuntime(async (program) => {
    assert.equal(program, "ps");
    if (output === "pending") return new Promise<string>((resolve) => { pending = resolve; });
    return output;
  }, () => terminal.instance);
  const events: unknown[] = [];
  runtime.on("activity", (event) => events.push(event));
  runtime.create(session, workspace, { ...device, type: "local" }, { ...connection, transport: "local", config: {} });
  await Promise.resolve();
  output = "123 123";
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(events, [
    { sessionId: session.id, activityStatus: "busy", resultReady: false },
    { sessionId: session.id, activityStatus: "idle", resultReady: true }
  ]);
  output = "pending";
  t.mock.timers.tick(1000);
  runtime.kill(session.id);
  pending?.("123 456");
  await Promise.resolve();
  assert.equal(events.length, 2);
});

test("attach returns an empty baseline for a missing session", () => {
  assert.deepEqual(new TerminalRuntime().attach("missing"), { data: "", sequence: 0 });
});

test("foreground process groups distinguish an idle shell from an occupying command", () => {
  assert.equal(foregroundProcessIsBusy("123 123"), false);
  assert.equal(foregroundProcessIsBusy("123 456"), true);
  assert.equal(foregroundProcessIsBusy(""), false);
});

test("remote terminals and iTerm retain SSH connection timeout and keepalives", () => {
  assert.deepEqual(sshTerminalArgs(connection, "run remote shell"), [
    "-t", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3",
    "-p", "2222", "builder@never-connected.invalid", "run remote shell"
  ]);
});
