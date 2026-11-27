import assert from "node:assert/strict";
import test from "node:test";
import type { IPty } from "node-pty";
import { foregroundProcessIsBusy, sshTerminalArgs, TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import type { Device, DeviceConnection, Session, Workspace } from "../src/shared/domain";
import { CODEX_FRAME_PREFIX } from "../src/main/runtime/codex-recording";
import { terminalProcessArgs, terminalPrograms, TerminalPidDecoder } from "../src/main/runtime/terminal-processes";

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

test("enabled SSH terminals capture only their own metadata on the existing PTY without activity probes", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const terminal = fakePty();
  let command = "";
  let probes = 0;
  const runtime = new TerminalRuntime(async () => { probes++; return ""; }, (program, args) => {
    assert.equal(program, "ssh");
    command = (args as string[]).at(-1)!;
    return terminal.instance;
  });
  const events: unknown[] = [];
  runtime.on("codex-recording", (event) => events.push(event));
  runtime.create(session, workspace, { ...device, codexRecordingEnabled: true }, connection);
  const token = /bootstrap '([a-f0-9]{48})'/.exec(command)?.[1];
  assert.ok(token);
  assert.match(command, /^cd '\/tmp\/demo worktree' && /);
  assert.match(command, /then exec python3/);
  const metadata = { token, id: "remote-conversation", cwd: "/tmp/demo worktree", event: "UserPromptSubmit", title: "A remote session" };
  const frame = CODEX_FRAME_PREFIX + Buffer.from(JSON.stringify(metadata)).toString("base64") + "\x07";
  terminal.output("before" + frame.slice(0, 18));
  terminal.output(frame.slice(18) + "after");
  assert.deepEqual(runtime.attach(session.id), { data: "beforeafter", sequence: 2 });
  assert.deepEqual(events, [{ terminalId: session.id, id: metadata.id, cwd: metadata.cwd, event: metadata.event, title: metadata.title }]);
  t.mock.timers.tick(60_000);
  assert.equal(probes, 0);
  runtime.kill(session.id);
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

test("process inspection excludes an idle login shell, includes foreground/background/stopped jobs and ignores zombies", () => {
  const root = "123 1 Ss /bin/zsh\n";
  assert.deepEqual(terminalPrograms(root, 123), []);
  assert.deepEqual(terminalPrograms(root + "124 123 S node\n125 124 S node\n126 123 T vim\n127 123 Z sleep\n128 999 S other\n", 123), ["node", "vim"]);
  assert.deepEqual(terminalPrograms("123 1 S /usr/bin/python3\n", 123), ["python3"]);
  assert.deepEqual(terminalPrograms("123 1 S -bash\n", 123), []);
  assert.deepEqual(terminalPrograms("123 1 S (bash)\n124 123 S (sleep)\n", 123), ["sleep"]);
  assert.throws(() => terminalPrograms("malformed", 123), /not found/);
});

test("remote PID announcement is stripped across every chunk boundary and accepts only its own token", () => {
  const token = "ab".repeat(24);
  const frame = `\x1b]777;superthread-terminal;${token};456\x07`;
  for (let split = 0; split <= frame.length; split++) {
    const pids: number[] = [];
    const decoder = new TerminalPidDecoder(token, (pid) => pids.push(pid));
    assert.equal(decoder.feed("before" + frame.slice(0, split)) + decoder.feed(frame.slice(split) + "after"), "beforeafter");
    assert.deepEqual(pids, [456]);
  }
  const pids: number[] = [];
  const decoder = new TerminalPidDecoder(token, (pid) => pids.push(pid));
  decoder.feed(frame.replace(token, "cd".repeat(24)) + frame.replace("456", "-1"));
  assert.deepEqual(pids, []);
});

test("close inspections take fresh snapshots, group SSH queries by device and do not change remote activity", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const terminals = [fakePty(), fakePty()];
  let remoteProbes = 0;
  let fail = false;
  let snapshot = "456 1 Ss /bin/bash\n789 1 Ss /bin/zsh\n900 456 S node\n";
  let created = 0;
  const activities: unknown[] = [];
  const runtime = new TerminalRuntime(async () => { throw new Error("No local SSH activity checks"); }, (_program, args) => {
    const terminal = terminals[created++]!;
    const command = (args as string[]).at(-1)!;
    const token = /superthread-terminal;([a-f0-9]{48});/.exec(command)![1];
    // onData is attached after spawn returns.
    queueMicrotask(() => terminal.output(`\x1b]777;superthread-terminal;${token};${created === 1 ? 456 : 789}\x07prompt`));
    return terminal.instance;
  }, async (actual) => {
    assert.deepEqual(actual, connection);
    remoteProbes++;
    if (fail) throw new Error("SSH timed out");
    return snapshot;
  });
  runtime.on("activity", (event) => activities.push(event));
  runtime.create(session, workspace, device, connection);
  await Promise.resolve();
  runtime.create({ ...session, id: "idle" }, workspace, device, connection);
  await Promise.resolve();
  assert.deepEqual(runtime.attach(session.id), { data: "prompt", sequence: 1 });
  assert.deepEqual(await runtime.inspectPrograms(), [
    { sessionId: session.id, programs: ["node"], error: undefined },
    { sessionId: "idle", programs: [], error: undefined }
  ]);
  assert.equal(remoteProbes, 1);
  snapshot = "456 1 Ss /bin/bash\n789 1 Ss /bin/zsh\n";
  assert.deepEqual((await runtime.inspectPrograms([session.id]))[0]?.programs, []);
  assert.equal(remoteProbes, 2);
  t.mock.timers.tick(60_000);
  assert.equal(remoteProbes, 2);
  assert.deepEqual(activities, []);
  fail = true;
  assert.deepEqual((await runtime.inspectPrograms()).map((item) => [item.programs, item.error]), [[[], "SSH timed out"], [[], "SSH timed out"]]);
  assert.equal(remoteProbes, 3);
  runtime.kill(session.id);
  runtime.kill("idle");
});

test("local close inspection uses the current process tree instead of stale activity and ignores exits during a query", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const terminal = fakePty();
  let snapshot: string | Promise<string> = "123 1 Ss /bin/zsh\n124 123 S sleep\n";
  const runtime = new TerminalRuntime(async (_program, args) => {
    if (args[0] !== "-A") return "123 123";
    assert.deepEqual(args, terminalProcessArgs);
    return snapshot;
  }, () => terminal.instance);
  runtime.create(session, workspace, { ...device, type: "local" }, { ...connection, transport: "local" });
  assert.deepEqual((await runtime.inspectPrograms())[0]?.programs, ["sleep"]);
  snapshot = "123 1 Ss /bin/zsh\n";
  assert.deepEqual((await runtime.inspectPrograms())[0]?.programs, []);
  let finish!: (value: string) => void;
  snapshot = new Promise<string>((resolve) => { finish = resolve; });
  const pending = runtime.inspectPrograms();
  runtime.kill(session.id);
  finish("123 1 Ss /bin/zsh\n124 123 S sleep\n");
  assert.deepEqual(await pending, []);
});

test("failed checks and connecting SSH shells are reported as unchecked, never as running programs", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const terminal = fakePty();
  const runtime = new TerminalRuntime(async () => { throw new Error("ps unavailable"); }, () => terminal.instance);
  runtime.create(session, workspace, device, connection);
  assert.match((await runtime.inspectPrograms())[0]!.error!, /still connecting/);
  runtime.kill(session.id);
  runtime.create(session, workspace, { ...device, type: "local" }, { ...connection, transport: "local" });
  const result = (await runtime.inspectPrograms())[0]!;
  assert.deepEqual(result.programs, []);
  assert.equal(result.error, "ps unavailable");
  runtime.kill(session.id);
});
