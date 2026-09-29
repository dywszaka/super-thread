import { spawn } from "node:child_process";
import type { Device, DeviceConnection, Workspace } from "../../shared/domain";
import { interactiveLoginShellCommand, quoteShellArgument } from "./login-shell";
import { sshTerminalArgs } from "./terminal-runtime";

const openWindowScript = `on run argv
  set launchCommand to item 1 of argv
  tell application "iTerm2"
    activate
    create window with default profile command launchCommand
  end tell
end run`;

export interface ExternalTerminalRuntime {
  open(command: string): Promise<void>;
}

export function itermTmuxCommand(workspace: Workspace, device: Device, connection: DeviceConnection, tmuxSessionName: string): string {
  const attach = `cd ${quoteShellArgument(workspace.path)} && exec tmux attach-session -t ${quoteShellArgument(tmuxSessionName)}`;
  if (device.type === "local") return interactiveLoginShellCommand(attach);
  const remote = interactiveLoginShellCommand(attach);
  return ["ssh", ...sshTerminalArgs(connection, remote)].map(quoteShellArgument).join(" ");
}

export class ItermRuntime implements ExternalTerminalRuntime {
  async open(command: string): Promise<void> {
    if (process.platform !== "darwin") throw new Error("Opening tmux in iTerm is only supported on macOS");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/osascript", ["-e", openWindowScript, "--", command], { stdio: ["ignore", "ignore", "pipe"] });
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
