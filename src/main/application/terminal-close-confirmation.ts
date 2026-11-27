import type { MessageBoxOptions } from "electron";

export interface TerminalCloseInspection { running: string[]; unchecked: string[]; }

export function terminalCloseOptions(inspection: TerminalCloseInspection, action: "quit" | "close"): MessageBoxOptions | undefined {
  if (!inspection.running.length && !inspection.unchecked.length) return;
  const sections: string[] = [];
  if (inspection.running.length) sections.push(`Programs still running:\n${inspection.running.join("\n")}`);
  if (inspection.unchecked.length) sections.push(`Could not check these terminals:\n${inspection.unchecked.join("\n")}`);
  return {
    type: "warning",
    buttons: [action === "quit" ? "Quit Super Thread" : "Close Terminal", "Cancel"],
    cancelId: 1,
    defaultId: 1,
    message: inspection.running.length ? "Programs are still running in terminals" : "Terminal activity could not be checked",
    detail: sections.join("\n\n")
  };
}
