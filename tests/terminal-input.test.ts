import assert from "node:assert/strict";
import test from "node:test";
import { installTerminalInput } from "../src/renderer/src/features/workspace/terminal-input";

function setup() {
  const host = new EventTarget();
  const output: string[] = [];
  let onData: ((data: string) => void) | undefined;
  const emit = (data: string): void => { output.push(data); onData?.(data); };
  const terminal = {
    textarea: host,
    input: (data: string, user: boolean) => { assert.equal(user, true); emit(data); },
    onData: (listener: (data: string) => void) => {
      onData = listener;
      return { dispose: () => { onData = undefined; } };
    }
  };
  const binding = installTerminalInput(terminal as unknown as Parameters<typeof installTerminalInput>[0], host as HTMLElement);
  const dispatch = (type: string, properties = {}, target = host): Event => {
    const event = new Event(type, { cancelable: true, composed: true });
    Object.assign(event, properties);
    target.dispatchEvent(event);
    return event;
  };
  const key = (properties = {}) => dispatch("keydown", { key: "Enter", keyCode: 13, shiftKey: true, ...properties });
  const input = (data: string, properties = {}) => dispatch("input", { data, inputType: "insertText", ...properties });
  return { output, binding, dispatch, key, input, emit };
}

test("Shift+Enter preserves its modifier and prevents a second CR from xterm", () => {
  const state = setup();
  const event = state.key();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(state.output, ["\x1b[13;2u"]);
});

test("Enter, modified chords and IME confirmation stay with xterm", () => {
  for (const properties of [{ shiftKey: false }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    const state = setup();
    assert.equal(state.key(properties).defaultPrevented, false);
    assert.deepEqual(state.output, []);
  }
  const state = setup();
  state.dispatch("compositionstart");
  assert.equal(state.key().defaultPrevented, false);
  state.dispatch("compositionend");
  assert.equal(state.key().defaultPrevented, false);
});

test("full-width punctuation commits once when input follows a non-229 keydown or precedes its own keydown", () => {
  for (const character of "，。！？：；（）【】、‘’“”") {
    const state = setup();
    state.key({ key: "Shift", keyCode: 16 });
    state.input(character);
    // The IME may deliver the character's keydown after its input event.
    state.key({ key: character, keyCode: 229 });
    state.dispatch("keyup");
    assert.deepEqual(state.output, [character]);
  }
  const state = setup();
  state.key({ key: "，", keyCode: 188, shiftKey: false });
  state.input("，");
  assert.deepEqual(state.output, ["，"]);
});

test("keypress/keydown output, native composition, paste and emoji input are not duplicated", () => {
  const state = setup();
  state.key({ key: "!", keyCode: 49 });
  state.emit("!");
  state.input("!");
  state.key({ key: "Unidentified", keyCode: 229 });
  state.input("，");
  state.key({ key: "Shift", keyCode: 16 });
  state.input("中", { isComposing: true });
  state.input("pasted，", { inputType: "insertFromPaste" });
  state.input("中", { inputType: "insertCompositionText" });
  state.dispatch("compositionstart");
  state.input("中文");
  state.dispatch("compositionend");
  state.input("中文");
  state.dispatch("keyup");
  state.input("🙂");
  assert.deepEqual(state.output, ["!"]);
});

test("blur releases stale key state and disposal removes every input hook", () => {
  const state = setup();
  state.key({ key: "Shift", keyCode: 16 });
  state.dispatch("blur");
  state.input("，");
  state.binding.dispose();
  assert.equal(state.key().defaultPrevented, false);
  state.input("！");
  assert.deepEqual(state.output, []);
});
