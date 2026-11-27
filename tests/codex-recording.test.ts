import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODEX_FRAME_PREFIX, CodexRecordingDecoder, codexRecordingCommand, type CodexRecordingEvent } from "../src/main/runtime/codex-recording";
import { codexRecordingScript } from "../src/main/runtime/codex-recording-script";
import { JsonStore } from "../src/main/persistence/json-store";
import { WorkspaceService } from "../src/main/application/workspace-service";
import type { TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/domain";
import { quoteShellArgument } from "../src/main/runtime/login-shell";

const exec = promisify(execFile);
const token = "ab".repeat(24);
const event = { id: "conversation-1", cwd: "/repo", event: "SessionStart" as const };
const frame = (data: unknown): string => `${CODEX_FRAME_PREFIX}${Buffer.from(JSON.stringify(data)).toString("base64")}\x07`;

test("OSC decoder survives every split boundary and preserves ordinary terminal controls", () => {
  const message = `before\x1b]0;title\x07${frame({ ...event, token })}after中文`;
  for (let split = 0; split <= message.length; split++) {
    const events: unknown[] = [];
    const decoder = new CodexRecordingDecoder(token, (data) => events.push(data));
    assert.equal(decoder.feed(message.slice(0, split)) + decoder.feed(message.slice(split)), "before\x1b]0;title\x07after中文");
    assert.deepEqual(events, [event]);
  }
});

test("OSC decoder rejects foreign tokens and malformed/oversized metadata", () => {
  const events: unknown[] = [];
  const decoder = new CodexRecordingDecoder(token, (data) => events.push(data));
  assert.equal(decoder.feed(frame({ ...event, token: "cd".repeat(24) }) + `${CODEX_FRAME_PREFIX}not base64\x07normal`), "normal");
  assert.equal(decoder.feed(`${CODEX_FRAME_PREFIX}${"x".repeat(20_000)}`), "");
  assert.equal(decoder.feed("rest\x07after"), "rest\x07after");
  assert.equal(decoder.feed(frame({ ...event, token, injected: true })), "");
  assert.deepEqual(events, []);
});

test("collector installation preserves user hooks and handles quoted paths idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-codex-install-"));
  const home = join(directory, "home with 'quotes");
  const codexHome = join(directory, "custom codex");
  await mkdir(codexHome, { recursive: true });
  await mkdir(home, { recursive: true });
  const existing = { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo existing" }] }], Stop: [] }, description: "User config" };
  const hooksPath = join(codexHome, "hooks.json");
  await writeFile(hooksPath, JSON.stringify(existing));
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  await exec("sh", ["-c", codexRecordingCommand("install")], { env });
  const installed = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.deepEqual(installed.hooks.SessionStart[0], existing.hooks.SessionStart[0]);
  assert.deepEqual(installed.hooks.Stop, []);
  assert.equal(installed.hooks.SessionStart.length, 2);
  assert.equal(installed.hooks.UserPromptSubmit.length, 1);
  assert.equal(await readFile(join(home, ".superthread/integrations/codex/collector.py"), "utf8"), codexRecordingScript);
  await exec("sh", ["-c", codexRecordingCommand("install")], { env });
  assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")), installed);
  assert.deepEqual(JSON.parse(await readFile(`${hooksPath}.superthread-backup`, "utf8")), existing);
  await writeFile(hooksPath, "invalid JSON");
  await assert.rejects(exec("sh", ["-c", codexRecordingCommand("install")], { env }));
  assert.equal(await readFile(hooksPath, "utf8"), "invalid JSON");
});

test("unsupported CLIs keep their original arguments; explicit isolated launches still record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-codex-launch-"));
  const bin = join(directory, "bin");
  const helper = join(directory, "collector.py");
  await mkdir(bin);
  await writeFile(helper, codexRecordingScript);
  await writeFile(join(bin, "codex"), `#!/usr/bin/env python3
import json, os, sys
print(json.dumps({"args": sys.argv[1:], "context": {key: value for key, value in os.environ.items() if key.startswith("SUPERTHREAD_CODEX_")}}))
`, { mode: 0o755 });
  const env = { ...process.env, HOME: directory, CODEX_HOME: join(directory, ".codex"), PATH: `${bin}:${process.env.PATH}`,
    SUPERTHREAD_TERMINAL_TOKEN: token, SUPERTHREAD_TERMINAL_TTY: "/dev/tty-terminal",
    SUPERTHREAD_CODEX_TOKEN: "stale-token", SUPERTHREAD_CODEX_TTY: "/dev/tty-stale", SUPERTHREAD_CODEX_RECORDING_VERSION: "1" };
  const cases: Array<{ args: string[]; recording?: boolean }> = [
    { args: [] },
    { args: ["resume", "existing-session"] },
    { args: ["--help"] },
    { args: ["--remote", "ws://localhost:8080"] },
    { args: ["--no-daemon", "--remote=ws://localhost:8080"] },
    { args: ["--no-daemon", "agents"] },
    { args: ["--no-daemon", "app-server"] },
    { args: ["remote-control", "--no-daemon"] },
    { args: ["--", "--no-daemon"] },
    { args: ["--config", "--no-daemon"] },
    { args: ["--no-daemon"], recording: true },
    { args: ["--no-daemon", "resume", "existing-session"], recording: true },
    { args: ["resume", "existing-session", "--no-daemon"], recording: true },
    { args: ["--model", "test-model", "--no-daemon", "A prompt with spaces"], recording: true }
  ];
  for (const { args, recording } of cases) {
    const { stdout, stderr } = await exec("python3", [helper, "launch", ...args], { env });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.args, args);
    assert.ok(stderr === "" || stderr.startsWith("[SuperThread] Shared-server recording unavailable; running Codex unchanged."));
    assert.deepEqual(result.context, recording ? {
      SUPERTHREAD_CODEX_TOKEN: token, SUPERTHREAD_CODEX_TTY: "/dev/tty-terminal", SUPERTHREAD_CODEX_RECORDING_VERSION: "3"
    } : {}, `Unexpected recording context for ${JSON.stringify(args)}`);
  }
});

test("hooks ignore stale recording environments retained by older shared servers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-codex-stale-"));
  const helper = join(directory, "collector.py");
  await writeFile(helper, codexRecordingScript);
  const driver = `
import io, json, os, runpy, sys
namespace = runpy.run_path(sys.argv[1])
def unexpected_open(*args, **kwargs):
    raise AssertionError("Stale hooks must not open a terminal")
os.open = unexpected_open
for version in (None, "1", "2"):
    if version is None:
        os.environ.pop("SUPERTHREAD_CODEX_RECORDING_VERSION", None)
    else:
        os.environ["SUPERTHREAD_CODEX_RECORDING_VERSION"] = version
    sys.stdin = io.StringIO(json.dumps({"session_id": "stale-session", "hook_event_name": "SessionStart"}))
    namespace["hook"]()
print("STALE_HOOK_IGNORED")
`;
  const { stdout } = await exec("python3", ["-c", driver, helper], { env: { ...process.env,
    SUPERTHREAD_CODEX_TOKEN: token, SUPERTHREAD_CODEX_TTY: "/dev/tty-stale" } });
  assert.match(stdout, /STALE_HOOK_IGNORED/);
});

test("bash and zsh explicit isolated launchers return Hook metadata through their real PTY and preserve input/output", async () => {
  for (const shell of ["/bin/bash", "/bin/zsh"]) {
    const directory = await mkdtemp(join(tmpdir(), "superthread-codex-pty-"));
    const bin = join(directory, "bin");
    await mkdir(bin);
    const helper = join(directory, "collector.py");
    await writeFile(helper, codexRecordingScript);
    await exec("sh", ["-c", codexRecordingCommand("install")], { env: { ...process.env, HOME: directory, CODEX_HOME: join(directory, ".codex") } });
    const startup = `export PATH=${quoteShellArgument(bin)}:$PATH\n`;
    await Promise.all([".zshrc", ".bashrc"].map((file) => writeFile(join(directory, file), startup)));
    await writeFile(join(directory, ".bash_profile"), '. "$HOME/.bashrc"\n');
    await writeFile(join(bin, "codex"), `#!/usr/bin/env python3
import json, os, subprocess, sys
if "--help" in sys.argv:
    print("--no-daemon")
    sys.exit(0)
if "--no-daemon" not in sys.argv:
    assert "SUPERTHREAD_CODEX_TOKEN" not in os.environ
    assert "SUPERTHREAD_CODEX_TTY" not in os.environ
    print("SHARED_SERVER_OK", flush=True)
    sys.exit(0)
config=json.load(open(os.path.join(os.environ["CODEX_HOME"], "hooks.json")))
for event in ("SessionStart", "UserPromptSubmit"):
    payload={"hook_event_name": event, "session_id": "pty-session", "cwd": os.getcwd(), "prompt": "Repair 中文 terminal"}
    for group in config["hooks"][event]:
        for handler in group["hooks"]:
            subprocess.run(handler["command"], shell=True, input=json.dumps(payload).encode(), check=True)
print("CLI_DONE", flush=True)
`, { mode: 0o755 });
    const driver = `
import os, pty, select, signal, sys, time
pid, master = pty.fork()
if pid == 0:
    os.chdir(os.environ["HOME"])
    os.execv(sys.executable, [sys.executable, sys.argv[1], "bootstrap", sys.argv[2]])
output=b""
try:
    time.sleep(0.2)
    os.write(master, b"codex; codex --no-daemon; echo INPUT_OUTPUT_OK; exit\\n")
    end=time.monotonic()+10
    while time.monotonic()<end:
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk=os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output+=chunk
    sys.stdout.buffer.write(output)
finally:
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.close(master)
    os.waitpid(pid, 0)
`;
    const { stdout } = await exec("python3", ["-c", driver, helper, token], { env: { ...process.env, HOME: directory, SHELL: shell, CODEX_HOME: join(directory, ".codex"), ZDOTDIR: directory }, timeout: 15_000 });
    assert.match(stdout, /CLI_DONE/, stdout);
    assert.match(stdout, /SHARED_SERVER_OK/, stdout);
    assert.match(stdout, /INPUT_OUTPUT_OK/);
    const events: unknown[] = [];
    new CodexRecordingDecoder(token, (data) => events.push(data)).feed(stdout);
    assert.deepEqual(events, [
      { id: "pty-session", cwd: directory.replace(/^\/var\//, "/private/var/"), event: "SessionStart" },
      { id: "pty-session", cwd: directory.replace(/^\/var\//, "/private/var/"), event: "UserPromptSubmit", title: "Repair 中文 terminal" }
    ]);
  }
});

async function setup(): Promise<{ service: WorkspaceService; store: JsonStore; path: string; installs: string[]; fail(): void }> {
  const directory = await mkdtemp(join(tmpdir(), "superthread-codex-service-"));
  const path = join(directory, "snapshot.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 17, devices: [{ id: "local", name: "Mac", type: "local", status: "online", createdAt: "then" }], connections: [{ deviceId: "local", transport: "local", config: {} }] }));
  const store = new JsonStore(path);
  const terminals = Object.assign(new EventEmitter(), { has: () => false }) as unknown as TerminalRuntime;
  const installs: string[] = [];
  let failInstall = false;
  const service = new WorkspaceService(store, terminals, undefined, undefined, { sync() {}, reconnectAll() {}, setReconnectEnabled() {}, stop() {} }, undefined, undefined, {
    async install(connection) { installs.push(connection.deviceId); if (failInstall) throw new Error("Python 3 missing"); return "Installed"; }
  });
  await service.initialize();
  await store.update((draft) => {
    draft.projects.push({ id: "project", name: "Project", code: "project-code", createdAt: "then", updatedAt: "then" });
    for (const suffix of ["a", "b"]) {
      draft.workThreads.push({ id: suffix, name: suffix, status: "active", pinned: false, createdAt: "then", updatedAt: "then" });
      draft.workspaces.push({ id: `workspace-${suffix}`, name: suffix, workThreadId: suffix, projectId: "project", deviceId: "local", checkoutId: "checkout", kind: "main", path: "/same/shared/path", branch: "main", baseBranch: "main", status: "ready", createdAt: "then", updatedAt: "then" });
      draft.sessions.push({ id: `terminal-${suffix}`, name: "Terminal", workspaceId: `workspace-${suffix}`, status: "exited", shell: "zsh", createdAt: "then", codexConversationId: "old-never-import" });
    }
  });
  return { service, store, path, installs, fail: () => { failInstall = true; } };
}

test("existing devices are opted out; disable keeps records and setup failures remain retryable", async () => {
  const { service, store, installs, fail } = await setup();
  assert.equal(service.snapshot().schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(service.snapshot().devices[0]!.codexRecordingEnabled, undefined);
  assert.deepEqual(installs, []);
  const data: CodexRecordingEvent = { ...event, terminalId: "terminal-a" };
  await service.recordCodexSession(data);
  assert.equal(service.snapshot().workThreads[0]!.codexSessions, undefined);
  await service.setDeviceCodexRecording({ deviceId: "local", enabled: true });
  assert.deepEqual(installs, ["local"]);
  await service.recordCodexSession(data);
  assert.equal(store.snapshot().workThreads[0]!.codexSessions?.length, 1);
  await service.setDeviceCodexRecording({ deviceId: "local", enabled: false });
  await service.recordCodexSession({ ...data, id: "ignored-after-disable" });
  assert.equal(store.snapshot().workThreads[0]!.codexSessions?.length, 1);
  fail();
  await service.setDeviceCodexRecording({ deviceId: "local", enabled: true });
  assert.deepEqual(service.snapshot().devices[0]!.codexRecordingSetup, { status: "error", message: "Python 3 missing" });
});

test("new remote devices default to recording, while an explicit opt-out does not install anything", async () => {
  const { service, installs } = await setup();
  service.pingDevices = async () => service.snapshot();
  await service.addDevice({ name: "New SSH", host: "test.invalid", user: "builder" });
  const device = service.snapshot().devices.find((item) => item.name === "New SSH")!;
  assert.equal(device.codexRecordingEnabled, true);
  assert.deepEqual(installs, [device.id]);
  await service.addDevice({ name: "No recording", host: "test.invalid", user: "builder", codexRecordingEnabled: false });
  assert.equal(service.snapshot().devices.find((item) => item.name === "No recording")!.codexRecordingEnabled, false);
  assert.equal(installs.length, 1);
});

test("deduplication and first prompt labels use terminal membership rather than a shared directory", async () => {
  const { service, store, path } = await setup();
  await service.setDeviceCodexRecording({ deviceId: "local", enabled: true });
  const data: CodexRecordingEvent = { ...event, terminalId: "terminal-a" };
  await service.recordCodexSession(data);
  await Promise.all([
    service.recordCodexSession({ ...data, event: "UserPromptSubmit", title: "First prompt 中文" }),
    service.recordCodexSession(data)
  ]);
  await service.recordCodexSession({ ...data, event: "UserPromptSubmit", title: "Later prompt" });
  await service.recordCodexSession({ ...data, terminalId: "terminal-b", id: "other-thread" });
  const records = store.snapshot().workThreads[0]!.codexSessions!;
  assert.equal(records.length, 1);
  assert.equal(records[0]!.title, "First prompt 中文");
  assert.equal(store.snapshot().workThreads[1]!.codexSessions![0]!.codexSessionId, "other-thread");
  await store.update((draft) => {
    draft.sessions = []; draft.workspaces = []; draft.projects = []; draft.devices = [];
    draft.workThreads[0]!.status = "archived";
  });
  const reloaded = await new JsonStore(path).load();
  assert.deepEqual(reloaded.workThreads[0]!.codexSessions, records);
  assert.equal(records[0]!.projectName, "Project");
});
