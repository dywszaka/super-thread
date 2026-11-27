import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexRecordingScript } from "../src/main/runtime/codex-recording-script";
import { CodexRecordingDecoder, codexRecordingCommand } from "../src/main/runtime/codex-recording";

const exec = promisify(execFile);

test("startup failure falls back once, while a started TUI failure is never relaunched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-relay-fallback-"));
  const helper = join(directory, "collector.py");
  const bin = join(directory, "bin");
  const audit = join(directory, "audit.jsonl");
  await mkdir(bin);
  await writeFile(helper, codexRecordingScript);
  await writeFile(join(bin, "codex"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args == ["app-server", "proxy", "--help"]:
    print("--sock")
elif args == ["app-server", "daemon", "start"]:
    sys.exit(1 if os.environ.get("FAIL_START") == "1" else 0)
else:
    with open(os.environ["RELAY_AUDIT"], "a") as log: log.write(json.dumps(args) + "\\n")
    sys.exit(23 if "--remote" in args else 0)
`, { mode: 0o755 });
  const env = { ...process.env, HOME: directory, CODEX_HOME: join(directory, ".codex"), PATH: `${bin}:${process.env.PATH}`,
    SUPERTHREAD_TERMINAL_TOKEN: "ab".repeat(24), SUPERTHREAD_TERMINAL_TTY: "/dev/null", RELAY_AUDIT: audit };
  const fallback = await exec("python3", [helper, "launch"], { env: { ...env, FAIL_START: "1" } });
  assert.match(fallback.stderr, /running Codex unchanged/);
  await assert.rejects(exec("python3", [helper, "launch"], { env: { ...env, FAIL_START: "0" } }), { code: 23 });
  const launches: string[][] = (await readFile(audit, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[0], []);
  assert.equal(launches[1]![0], "--remote");
  assert.match(launches[1]![1]!, /^unix:\/\/\/tmp\/st-codex-.*\/rpc.sock$/);
  await assert.rejects(access(launches[1]![1]!.slice("unix://".length)), { code: "ENOENT" });
});

test("RPC attribution is scoped to each connection, confirmed responses and exact thread IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-observer-"));
  const helper = join(directory, "collector.py");
  await writeFile(helper, codexRecordingScript);
  const { stdout } = await exec("python3", ["-c", `
import json, runpy, sys
Observer = runpy.run_path(sys.argv[1])["ConversationObserver"]
records = [[], []]
observers = [Observer(lambda *event: records[0].append(event)), Observer(lambda *event: records[1].append(event))]
def observe(index, message, outgoing=False):
    observers[index].observe(json.dumps(message), outgoing)
for index in (0, 1):
    observe(index, {"id": 1, "method": "thread/start", "params": {"cwd": "/same"}}, True)
    observe(index, {"method": "thread/started", "params": {"thread": {"id": "foreign", "cwd": "/same"}}})
    observe(index, {"id": 99, "result": {"thread": {"id": "foreign", "cwd": "/same"}}})
    observe(index, {"id": 1, "method": "approval/request", "params": {}})
    assert records[index] == []
    observe(index, {"id": 1, "result": {"thread": {"id": "thread-" + str(index), "cwd": "/same", "turns": [{"secret": "historical transcript"}]}}})
    observe(index, {"id": 1, "result": {"thread": {"id": "duplicate", "cwd": "/same"}}})
    observe(index, {"id": 2, "method": "turn/start", "params": {"threadId": "foreign", "input": [{"type": "text", "text": "wrong thread"}]}}, True)
    observe(index, {"id": 2, "result": {"turn": {"id": "foreign-turn"}}})
    observe(index, {"id": 3, "method": "turn/start", "params": {"threadId": "thread-" + str(index), "input": [{"type": "text", "text": " rejected prompt "}]}}, True)
    observe(index, {"id": 3, "error": {"code": -1, "message": "rejected"}})
    observe(index, {"id": 4, "method": "turn/start", "params": {"threadId": "thread-" + str(index), "input": [{"type": "image", "url": "private-image"}, {"type": "text", "text": "  prompt\\n" + str(index)}]}}, True)
    assert len(records[index]) == 1
    observe(index, {"id": 4, "result": {"turn": {"id": "turn"}}})
    assert records[index] == [("thread-" + str(index), "SessionStart", "/same", None), ("thread-" + str(index), "UserPromptSubmit", "/same", "prompt " + str(index))]
    observe(index, {"id": "resume", "method": "thread/resume", "params": {"threadId": "thread-" + str(index)}}, True)
    observe(index, {"id": "resume", "result": {"thread": {"id": "thread-" + str(index), "cwd": "/same"}}})
    observe(index, {"id": "fork", "method": "thread/fork", "params": {"threadId": "thread-" + str(index)}}, True)
    observe(index, {"id": "fork", "result": {"thread": {"id": "fork-" + str(index), "cwd": "/same"}}})
    assert records[index][-1][0] == "fork-" + str(index)
    assert len(records[index]) == 4
    observers[index].observe(b"invalid json", False)
print("ATTRIBUTION_OK")
`, helper]);
  assert.match(stdout, /ATTRIBUTION_OK/);
});

test("bash and zsh concurrently record same-directory shared-daemon sessions through private relays", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-relay-pty-"));
  const helper = join(directory, "collector.py");
  const bin = join(directory, "bin");
  const audit = join(directory, "audit.jsonl");
  await mkdir(bin);
  await writeFile(helper, codexRecordingScript);
  await writeFile(join(bin, "codex"), await readFile(new URL("./fixtures/codex-relay-cli.py", import.meta.url), "utf8"), { mode: 0o755 });
  const driver = `
import json, os, pty, select, signal, subprocess, sys, time
children = []
for index, shell in enumerate(("/bin/bash", "/bin/zsh")):
    home = os.path.join(os.environ["HOME"], str(index))
    os.makedirs(home)
    subprocess.run(["sh", "-c", sys.argv[2]], env={**os.environ, "HOME": home, "CODEX_HOME": os.path.join(home, ".codex")}, check=True, stdout=subprocess.DEVNULL)
    for name in (".bash_profile", ".zshrc"):
        with open(os.path.join(home, name), "w") as f:
            f.write("export PATH=" + os.environ["RELAY_BIN"] + ":$PATH\\n")
    pid, master = pty.fork()
    if pid == 0:
        os.environ.update(HOME=home, CODEX_HOME=os.path.join(home, ".codex"), SHELL=shell, ZDOTDIR=home, RELAY_LABEL=str(index))
        os.chdir(os.environ["RELAY_CWD"])
        os.execv(sys.executable, [sys.executable, sys.argv[1], "bootstrap", ("ab" if index == 0 else "cd") * 24])
    children.append((pid, master))
try:
    for _, master in children:
        os.write(master, b"codex; echo SHELL_INPUT_OK; exit\\n")
    outputs = [b"", b""]
    active = {master: index for index, (_, master) in enumerate(children)}
    deadline = time.monotonic() + 20
    while active and time.monotonic() < deadline:
        for master in select.select(list(active), [], [], 0.1)[0]:
            try: chunk = os.read(master, 65536)
            except OSError: chunk = b""
            if chunk:
                outputs[active[master]] += chunk
            else:
                active.pop(master)
    print(json.dumps([output.decode(errors="replace") for output in outputs]))
finally:
    for pid, master in children:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        os.close(master)
        os.waitpid(pid, 0)
`;
  const { stdout } = await exec("python3", ["-c", driver, helper, codexRecordingCommand("install")], { env: { ...process.env, HOME: directory,
    RELAY_BIN: bin, RELAY_CWD: directory, RELAY_AUDIT: audit }, timeout: 25_000 });
  const outputs: string[] = JSON.parse(stdout);
  for (const [index, output] of outputs.entries()) {
    assert.match(output, /SHARED_RELAY_OK/, output);
    assert.match(output, /SHELL_INPUT_OK/, output);
    const events: unknown[] = [];
    const token = (index === 0 ? "ab" : "cd").repeat(24);
    new CodexRecordingDecoder(token, (event) => events.push(event)).feed(output);
    assert.deepEqual(events, [
      { id: `shared-${index}`, event: "SessionStart", cwd: "/same/shared/workspace" },
      { id: `shared-${index}`, event: "UserPromptSubmit", cwd: "/same/shared/workspace", title: `Prompt ${index}` },
      { id: `shared-${index}`, event: "SessionStart", cwd: "/same/shared/workspace" },
      { id: `fork-${index}`, event: "SessionStart", cwd: "/same/shared/workspace" }
    ]);
    assert.doesNotMatch(output, /private transcript|foreign-thread/);
  }
  const entries = (await readFile(audit, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    if (entry.socket) await assert.rejects(access(entry.socket), { code: "ENOENT" });
    if (entry.proxyPid) assert.throws(() => process.kill(entry.proxyPid, 0), { code: "ESRCH" });
  }
});

test("WebSocket observation handles split frames and bounds unsupported messages without controlling transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-ws-observer-"));
  const helper = join(directory, "collector.py");
  await writeFile(helper, codexRecordingScript);
  const { stdout } = await exec("python3", ["-c", `
import runpy, struct, sys
WebSocketObserver = runpy.run_path(sys.argv[1])["WebSocketObserver"]
class Sink:
    def __init__(self): self.messages = []
    def observe(self, data, outgoing): self.messages.append((bytes(data), outgoing))
def frame(data, outgoing, opcode=1, final=True):
    size = len(data)
    header = bytes(((128 if final else 0) | opcode, (128 if outgoing else 0) | (size if size < 126 else 126 if size <= 65535 else 127)))
    if size >= 126: header += size.to_bytes(2 if size <= 65535 else 8, "big")
    if outgoing:
        mask = b"abcd"
        return header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(data))
    return header + data
for outgoing in (True, False):
    header = b"GET / HTTP/1.1\\r\\n\\r\\n" if outgoing else b"HTTP/1.1 101 Switching Protocols\\r\\n\\r\\n"
    payload = b'{"id":1}'
    wire = header + frame(payload[:3], outgoing, final=False) + frame(b"ping", outgoing, opcode=9) + frame(payload[3:], outgoing, opcode=0)
    for split in range(len(wire) + 1):
        sink = Sink()
        observer = WebSocketObserver(sink, outgoing)
        observer.feed(wire[:split]); observer.feed(wire[split:])
        assert sink.messages == [(payload, outgoing)], (split, sink.messages)
    sink = Sink()
    observer = WebSocketObserver(sink, outgoing)
    observer.feed(header)
    for size in (200, 70000):
        payload = b"x" * size
        wire = frame(payload, outgoing)
        for offset in range(0, len(wire), 113): observer.feed(wire[offset:offset + 113])
        assert sink.messages[-1] == (payload, outgoing)
    observer.feed(bytes((129, (128 if outgoing else 0) | 127)) + struct.pack("!Q", 100 * 1024 * 1024))
    assert not observer.enabled and not observer.pending
    observer.feed(b"still forwarded by the relay")
print("FRAMING_OK")
`, helper]);
  assert.match(stdout, /FRAMING_OK/);
});
