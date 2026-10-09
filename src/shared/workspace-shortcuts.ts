export interface WorkspaceShortcut {
  commandHeld: boolean;
  tabIndex?: number;
}

interface ShortcutInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
  isAutoRepeat: boolean;
}

export function workspaceShortcut(input: ShortcutInput): WorkspaceShortcut {
  const commandHeld = input.key === "Meta" ? input.type !== "keyUp" : input.meta;
  const digit = /^[1-9]$/.test(input.key) ? Number(input.key) : 0;
  const tabIndex = commandHeld && !input.control && !input.alt && !input.shift
    && input.type === "keyDown" && !input.isAutoRepeat && digit ? digit - 1 : undefined;
  return { commandHeld, tabIndex };
}
