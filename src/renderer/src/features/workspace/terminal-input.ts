import type { IDisposable, Terminal } from "@xterm/xterm";

type InputTerminal = Pick<Terminal, "textarea" | "input" | "onData">;

/** Bridge input paths that xterm 5.5's legacy keyboard encoder cannot represent. */
export function installTerminalInput(terminal: InputTerminal, host: HTMLElement): IDisposable {
  let key: { ime: boolean; sent: boolean } | undefined;
  let composing = false;
  let compositionEnding = false;
  let compositionTimer: ReturnType<typeof setTimeout> | undefined;
  const data = terminal.onData(() => { if (key) key.sent = true; });
  const isTextarea = (event: Event): boolean => event.target === terminal.textarea;
  const keydown = (event: KeyboardEvent): void => {
    if (!isTextarea(event)) return;
    key = { ime: event.keyCode === 229, sent: false };
    if (event.key !== "Enter" || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
      || event.isComposing || key.ime || composing || compositionEnding) return;
    // CSI-u preserves Shift for Codex and other TUIs instead of submitting CR.
    event.preventDefault();
    event.stopImmediatePropagation();
    terminal.input("\x1b[13;2u", true);
  };
  const keyup = (event: KeyboardEvent): void => { if (isTextarea(event)) key = undefined; };
  const compositionstart = (event: CompositionEvent): void => {
    if (!isTextarea(event)) return;
    if (compositionTimer) clearTimeout(compositionTimer);
    composing = true;
    compositionEnding = false;
  };
  const compositionend = (event: CompositionEvent): void => {
    if (!isTextarea(event)) return;
    composing = false;
    // xterm finalizes composition from the textarea on the next turn.
    compositionEnding = true;
    compositionTimer = setTimeout(() => { compositionEnding = false; }, 0);
  };
  const input = (rawEvent: Event): void => {
    const event = rawEvent as InputEvent;
    if (!isTextarea(event) || event.inputType !== "insertText" || !event.data
      || event.isComposing || composing || compositionEnding || !key || key.ime || key.sent) return;
    // Some IMEs commit punctuation without keypress, even before its keydown
    // while Shift is held. xterm drops composed input while any key is down.
    // Use the public input API once, leaving 229/composition to xterm itself.
    event.stopImmediatePropagation();
    terminal.input(event.data, true);
  };
  const blur = (): void => { key = undefined; };
  host.addEventListener("keydown", keydown, { capture: true });
  host.addEventListener("keyup", keyup, { capture: true });
  host.addEventListener("compositionstart", compositionstart, { capture: true });
  host.addEventListener("compositionend", compositionend, { capture: true });
  host.addEventListener("input", input, { capture: true });
  host.addEventListener("blur", blur, { capture: true });
  return { dispose: () => {
    if (compositionTimer) clearTimeout(compositionTimer);
    data.dispose();
    host.removeEventListener("keydown", keydown, { capture: true });
    host.removeEventListener("keyup", keyup, { capture: true });
    host.removeEventListener("compositionstart", compositionstart, { capture: true });
    host.removeEventListener("compositionend", compositionend, { capture: true });
    host.removeEventListener("input", input, { capture: true });
    host.removeEventListener("blur", blur, { capture: true });
  } };
}
