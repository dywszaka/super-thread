import assert from "node:assert/strict";
import test from "node:test";
import { decodeClipboardWrite, installTerminalClipboard } from "../src/renderer/src/features/workspace/terminal-clipboard";

const encode = (text: string): string => Buffer.from(text).toString("base64");

function setup(platform = "darwin") {
  const host = new EventTarget();
  const writes: string[] = [];
  const input: string[] = [];
  let selection = "";
  let live = true;
  let oscDisposed = false;
  let keyHandler!: (event: KeyboardEvent) => boolean;
  let oscHandler!: (data: string) => boolean | Promise<boolean>;
  const terminal = {
    getSelection: () => selection,
    buffer: { active: { type: "normal" } },
    modes: { mouseTrackingMode: "none" },
    input: (data: string) => { input.push(data); },
    attachCustomKeyEventHandler: (handler: typeof keyHandler) => { keyHandler = handler; },
    parser: { registerOscHandler: (id: number, handler: typeof oscHandler) => {
      assert.equal(id, 52);
      oscHandler = handler;
      return { dispose: () => { oscDisposed = true; } };
    } }
  };
  const binding = installTerminalClipboard(terminal as Parameters<typeof installTerminalClipboard>[0], host as HTMLElement, {
    platform, writeText: async (text) => { writes.push(text); }, isLive: () => live,
    onError: () => assert.fail("unexpected clipboard write failure")
  });
  const key = (patch: Partial<KeyboardEvent> = {}) => {
    const event = { type: "keydown", key: "c", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: () => {}, ...patch } as KeyboardEvent;
    return keyHandler(event);
  };
  return { host, terminal, writes, input, binding, key,
    select: (text: string) => { selection = text; },
    setLive: (value: boolean) => { live = value; },
    osc: (data: string) => oscHandler(data),
    oscDisposed: () => oscDisposed
  };
}

test("OSC 52 accepts UTF-8, default/primary targets and unpadded base64", () => {
  const text = "中文 👋\n tmux selection\t";
  for (const target of ["c", "", "p", "s0", "cp"]) {
    assert.equal(decodeClipboardWrite(`${target};${encode(text)}`), text);
  }
  assert.equal(decodeClipboardWrite("c;aGk"), "hi");
});

test("OSC 52 ignores reads, empty writes, malformed encodings and oversized payloads", () => {
  for (const data of ["c;?", "c;", "c", "x;aGk=", "c;%%%%", "c;a", "c;aGk=;other", "c;/w==", `c;${encode("x".repeat(2_000_001))}`]) {
    assert.equal(decodeClipboardWrite(data), undefined);
  }
  assert.equal(decodeClipboardWrite(`c;${encode("x".repeat(2_000_000))}`)?.length, 2_000_000);
});

test("only live OSC 52 writes reach the clipboard; history and queries have no side effects", () => {
  const state = setup();
  state.setLive(false);
  assert.equal(state.osc(`c;${encode("old copy")}`), true);
  state.setLive(true);
  state.osc(`c;${encode("new copy")}`);
  state.osc("c;?");
  state.osc("c;");
  assert.deepEqual(state.writes, ["new copy"]);
  assert.deepEqual(state.input, []);
});

test("Cmd+C copies the terminal selection once and leaves Ctrl+C with xterm", () => {
  const state = setup();
  state.select("selected 中文");
  assert.equal(state.key(), false);
  assert.equal(state.key({ type: "keyup" }), false);
  assert.deepEqual(state.writes, ["selected 中文"]);
  for (const patch of [{ metaKey: false, ctrlKey: true }, { altKey: true }, { key: "v" }]) {
    assert.equal(state.key(patch), true);
  }
  assert.deepEqual(state.input, []);
});

test("native Copy fills the clipboard event synchronously and uses the terminal selection first", () => {
  const state = setup();
  state.select("buffer selection");
  state.terminal.buffer.active.type = "alternate";
  state.terminal.modes.mouseTrackingMode = "drag";
  const data: string[] = [];
  const event = new Event("copy", { cancelable: true });
  Object.assign(event, { clipboardData: { setData: (type: string, text: string) => { data.push(type, text); } } });
  state.host.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(data, ["text/plain", "buffer selection"]);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.input, []);
});

test("Copy requests the TUI selection only in an alternate screen with mouse tracking", () => {
  const state = setup();
  state.key();
  state.terminal.buffer.active.type = "alternate";
  state.key();
  assert.deepEqual(state.input, []);
  state.terminal.modes.mouseTrackingMode = "drag";
  state.key();
  state.key({ type: "keyup" });
  const event = new Event("copy", { cancelable: true });
  state.host.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(state.input, ["\x1b[2;5~", "\x1b[2;5~"]);
  assert.deepEqual(state.writes, []);
});

test("Ctrl+Shift+C remains the copy shortcut off macOS and cleanup releases handlers", () => {
  const state = setup("linux");
  state.select("selection");
  assert.equal(state.key(), true);
  assert.equal(state.key({ metaKey: false, ctrlKey: true, shiftKey: true }), false);
  state.binding.dispose();
  assert.equal(state.oscDisposed(), true);
  assert.equal(state.key(), true);
  state.host.dispatchEvent(new Event("copy"));
  assert.deepEqual(state.writes, ["selection"]);
});
