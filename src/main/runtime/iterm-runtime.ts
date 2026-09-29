import { spawn } from "node:child_process";
import type { Device, DeviceConnection, Workspace } from "../../shared/domain";
import { quoteShellArgument } from "./login-shell";
import { sshTerminalArgs } from "./terminal-runtime";

export const openItermScript = `on run argv
  set launchCommand to item 1 of argv
  tell application "iTerm2"
    activate
    if (count of windows) is 0 then
      create window with default profile command launchCommand
    else
      tell current window
        create tab with default profile command launchCommand
      end tell
    end if
  end tell
end run`;

export interface ExternalTerminalRuntime {
  open(command: string): Promise<void>;
}

export function itermTmuxCommand(
  workspace: Workspace,
  device: Device,
  connection: DeviceConnection,
  tmuxSessionName: string,
  tmuxExecutable: string
): string {
  const attach = `cd ${quoteShellArgument(workspace.path)} && exec ${quoteShellArgument(tmuxExecutable)} attach-session -t ${quoteShellArgument(tmuxSessionName)}`;
  if (device.type === "local") return ["/bin/sh", "-c", attach].map(quoteShellArgument).join(" ");
  return ["ssh", ...sshTerminalArgs(connection, attach)].map(quoteShellArgument).join(" ");
}

export class ItermRuntime implements ExternalTerminalRuntime {
  async open(command: string): Promise<void> {
    if (process.platform !== "darwin") throw new Error("Opening tmux in iTerm is only supported on macOS");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/osascript", ["-e", openItermScript, "--", command], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Unable to open iTerm (osascript exited with ${code ?? "unknown"})`));
      });
    });
  }
}
