import type { ITerminalOptions, ITheme } from "@xterm/xterm";

// Read the same tokens used by the terminal host, tabs, and empty states.
// The terminal intentionally keeps its dark palette in both system appearances.
export function terminalAppearance(host: HTMLElement): ITerminalOptions {
  const styles = getComputedStyle(host);
  const token = (name: string): string => styles.getPropertyValue(name).trim();
  const theme: ITheme = {
    background: token("--terminal-background"),
    foreground: token("--terminal-foreground"),
    cursor: token("--terminal-cursor"),
    cursorAccent: token("--terminal-background"),
    selectionBackground: token("--terminal-selection-background")
  };
  const colors = [
    ["black", "brightBlack"], ["red", "brightRed"],
    ["green", "brightGreen"], ["yellow", "brightYellow"],
    ["blue", "brightBlue"], ["magenta", "brightMagenta"],
    ["cyan", "brightCyan"], ["white", "brightWhite"]
  ] as const;
  for (const [color, bright] of colors) {
    theme[color] = token(`--terminal-${color}`);
    theme[bright] = token(`--terminal-bright-${color}`);
  }
  return {
    fontFamily: token("--font-mono"),
    fontSize: Number.parseFloat(token("--terminal-font-size")),
    lineHeight: Number.parseFloat(token("--terminal-line-height")),
    fontWeight: "400",
    fontWeightBold: "600",
    theme
  };
}
