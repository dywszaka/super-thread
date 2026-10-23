import type { IDisposable, Terminal } from "@xterm/xterm";

const maxClipboardBytes = 2_000_000;

/** OSC 52 writes only: never answer clipboard reads from terminal applications. */
export function decodeClipboardWrite(data: string): string | undefined {
  const separator = data.indexOf(";");
  if (separator < 0 || !/^[cps0-7]*$/.test(data.slice(0, separator))) return;
  const encoded = data.slice(separator + 1);
  if (!encoded || encoded === "?" || encoded.length > Math.ceil(maxClipboardBytes / 3) * 4) return;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return;
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (bytes.length > maxClipboardBytes) return;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return; }
}

interface ClipboardOptions {
  platform: string;
  writeText(text: string): Promise<void>;
  isLive(): boolean;
  onError(): void;
}

type ClipboardTerminal = Pick<Terminal, "getSelection" | "buffer" | "modes" | "input" | "parser" | "attachCustomKeyEventHandler">;

export function installTerminalClipboard(terminal: ClipboardTerminal, host: HTMLElement, options: ClipboardOptions): IDisposable {
  const writeText = (text: string): void => {
    void options.writeText(text).catch(options.onError);
  };
  const copy = (event?: ClipboardEvent): boolean => {
    const text = terminal.getSelection();
    if (text) {
      // Native Edit → Copy owns a synchronous clipboard transaction.
      if (event?.clipboardData) event.clipboardData.setData("text/plain", text);
      else writeText(text);
    } else if (terminal.buffer.active.type === "alternate" && terminal.modes.mouseTrackingMode !== "none") {
      // Mouse-aware TUIs own their selection. Ctrl+Insert is the conventional
      // application Copy key; never send Ctrl+C (process interrupt) instead.
      terminal.input("\x1b[2;5~", true);
    } else return false;
    event?.preventDefault();
    event?.stopPropagation();
    return true;
  };
  const onCopy = (event: ClipboardEvent): void => { copy(event); };
  host.addEventListener("copy", onCopy, true);
  terminal.attachCustomKeyEventHandler((event) => {
    const shortcut = event.key.toLowerCase() === "c" && !event.altKey
      && (options.platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey);
    if (!shortcut) return true;
    if (event.type === "keydown" && copy()) event.preventDefault();
    return false;
  });
  const osc = terminal.parser.registerOscHandler(52, (data) => {
    // Reattaching replays historical escape sequences, not new copy requests.
    if (options.isLive()) {
      const text = decodeClipboardWrite(data);
      if (text) writeText(text);
    }
    return true;
  });
  return { dispose: () => {
    host.removeEventListener("copy", onCopy, { capture: true });
    terminal.attachCustomKeyEventHandler(() => true);
    osc.dispose();
  } };
}
