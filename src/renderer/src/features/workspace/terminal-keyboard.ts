import type { SessionKind } from "@/shared/domain";

export interface TerminalKeyEvent {
  type: string;
  key: string;
  keyCode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/**
 * xterm cannot distinguish Shift+Enter from Enter without an extended keyboard
 * protocol. Codex already treats LF (Ctrl+J) as an inserted newline, so emit
 * that portable sequence for Codex sessions only.
 */
export function terminalInputForKeyEvent(kind: SessionKind | undefined, event: TerminalKeyEvent): string | undefined {
  if (
    kind === "codex"
    && event.type === "keydown"
    && event.key === "Enter"
    && event.shiftKey
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && !event.isComposing
    && event.keyCode !== 229
  ) return "\n";

  return undefined;
}
