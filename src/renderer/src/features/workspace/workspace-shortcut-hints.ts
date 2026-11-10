import type { WorkspaceShortcut } from "@/shared/workspace-shortcuts";

export class WorkspaceShortcutHints {
  private commandHeld = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly setVisible: (visible: boolean) => void) {}

  update(shortcut: WorkspaceShortcut): void {
    if (!shortcut.commandHeld) { this.clear(); return; }
    const wasHeld = this.commandHeld;
    this.commandHeld = true;
    if (shortcut.tabIndex !== undefined) {
      // Switching native views can lose the key-up event. Dismiss now and
      // require a new Command press before starting another hint timer.
      this.hide();
    } else if (!wasHeld) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.setVisible(true);
      }, 3_000);
    }
  }

  clear = (): void => {
    this.commandHeld = false;
    this.hide();
  };

  private hide(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.setVisible(false);
  }
}
