import { basename } from "node:path";

export const terminalProcessArgs = ["-A", "-o", "pid=", "-o", "ppid=", "-o", "stat=", "-o", "comm="];
const shells = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]);

/** The root is the login shell; descendants include foreground, background and stopped jobs. */
export function terminalPrograms(output: string, rootPid: number): string[] {
  const processes = output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    // macOS falls back to a parenthesized short name when the executable path is unavailable.
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), state: match[3]!, name: basename(match[4]!).replace(/^\((.*)\)$/, "$1").replace(/^-/, "") }] : [];
  });
  const root = processes.find((item) => item.pid === rootPid);
  if (!root) throw new Error("Terminal shell was not found in the process snapshot");
  const descendants = new Set([rootPid]);
  let size: number;
  do {
    size = descendants.size;
    for (const item of processes) if (descendants.has(item.parent)) descendants.add(item.pid);
  } while (descendants.size !== size);
  return [...new Set(processes.filter((item) => descendants.has(item.pid)
    && !/^[ZX]/.test(item.state)
    && (item.pid !== rootPid || !shells.has(item.name))).map((item) => item.name))];
}

/** A one-time PID announcement on the existing SSH PTY, never a file on the device. */
export class TerminalPidDecoder {
  private pending = "";
  readonly prefix: string;
  constructor(token: string, private readonly receive: (pid: number) => void) {
    this.prefix = `\x1b]777;superthread-terminal;${token};`;
  }
  feed(chunk: string): string {
    this.pending += chunk;
    let output = "";
    for (;;) {
      const start = this.pending.indexOf(this.prefix);
      if (start < 0) {
        let keep = Math.min(this.pending.length, this.prefix.length - 1);
        while (keep > 0 && !this.prefix.startsWith(this.pending.slice(-keep))) keep--;
        output += this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
        return output;
      }
      output += this.pending.slice(0, start);
      this.pending = this.pending.slice(start);
      const end = this.pending.indexOf("\x07", this.prefix.length);
      if (end < 0) {
        if (this.pending.length > 256) this.pending = "";
        return output;
      }
      const value = this.pending.slice(this.prefix.length, end);
      if (/^[1-9]\d{0,9}$/.test(value)) this.receive(Number(value));
      this.pending = this.pending.slice(end + 1);
    }
  }
}
