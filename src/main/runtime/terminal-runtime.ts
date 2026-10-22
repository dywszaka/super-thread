import { EventEmitter } from "node:events";
import os from "node:os";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type { Device, DeviceConnection, Session, SessionActivityStatus, TerminalOutput, TerminalReplay, Workspace } from "../../shared/domain";
import { ProcessCommandRunner } from "./command-runner";
import { quoteShellArgument } from "./login-shell";

interface LiveSession {
  pty: IPty;
  buffer: string;
  sequence: number;
  activityStatus: SessionActivityStatus;
  activityTimer?: NodeJS.Timeout;
  probing: boolean;
}
export interface TerminalExitEvent { sessionId: string; exitCode?: number; }
export interface TerminalActivityEvent { sessionId: string; activityStatus: SessionActivityStatus; resultReady: boolean; }

export function foregroundProcessIsBusy(output: string): boolean {
  const [processGroup, terminalProcessGroup] = output.trim().split(/\s+/).map(Number);
  return processGroup !== undefined && terminalProcessGroup !== undefined
    && Number.isInteger(processGroup) && Number.isInteger(terminalProcessGroup)
    && terminalProcessGroup > 0 && terminalProcessGroup !== processGroup;
}

export function sshTerminalArgs(connection: DeviceConnection, command: string): string[] {
  const config = connection.config;
  const target = config.user ? `${config.user}@${config.host}` : String(config.host);
  const args = [
    "-t",
    "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3"
  ];
  if (config.port) args.push("-p", String(config.port));
  args.push(target, command);
  return args;
}

const runLocalProbe = async (program: string, args: string[]): Promise<string> =>
  (await new ProcessCommandRunner().run(program, args, { timeoutMs: 1_500 })).stdout;

export class TerminalRuntime extends EventEmitter {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(
    private readonly runProbe = runLocalProbe,
    private readonly spawnPty: typeof pty.spawn = pty.spawn
  ) { super(); }

  create(session: Session, workspace: Workspace, device: Device, connection: DeviceConnection): number {
    if (session.kind && session.kind !== "shell") throw new Error("Only shell terminal sessions are supported");
    if (this.sessions.has(session.id)) throw new Error("Terminal session is already running");
    const remote = device.type === "remote";
    const cwd = session.cwd || workspace.path;
    const program = remote ? "ssh" : process.env.SHELL || "/bin/zsh";
    const args = remote
      ? sshTerminalArgs(connection, `cd ${quoteShellArgument(cwd)} && exec "\${SHELL:-/bin/sh}" -l`)
      : ["-l"];
    const instance = this.spawnPty(program, args, {
      name: "xterm-256color", cols: 100, rows: 30,
      cwd: remote ? os.homedir() : cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>
    });
    const live: LiveSession = {
      pty: instance, buffer: "", sequence: 0,
      activityStatus: remote ? "unknown" : "idle", probing: false
    };
    this.sessions.set(session.id, live);
    instance.onData((data) => {
      live.buffer = (live.buffer + data).slice(-64_000);
      live.sequence += 1;
      this.emit("output", { sessionId: session.id, data, sequence: live.sequence } satisfies TerminalOutput);
    });
    instance.onExit(({ exitCode }) => {
      if (live.activityTimer) clearInterval(live.activityTimer);
      if (this.sessions.get(session.id) !== live) return;
      this.sessions.delete(session.id);
      this.emit("exit", { sessionId: session.id, exitCode } satisfies TerminalExitEvent);
    });
    // A remote terminal owns just its interactive SSH connection. Do not open
    // additional SSH sessions to infer activity, including while windows close.
    if (!remote) {
      const probe = (): void => { void this.probeActivity(session.id, live); };
      live.activityTimer = setInterval(probe, 1_000);
      live.activityTimer.unref();
      probe();
    }
    return instance.pid;
  }

  private async probeActivity(sessionId: string, live: LiveSession): Promise<void> {
    if (live.probing || this.sessions.get(sessionId) !== live) return;
    live.probing = true;
    try {
      const output = await this.runProbe("ps", ["-o", "pgid=", "-o", "tpgid=", "-p", String(live.pty.pid)]);
      if (this.sessions.get(sessionId) !== live) return;
      const activityStatus = foregroundProcessIsBusy(output) ? "busy" : "idle";
      if (live.activityStatus === activityStatus) return;
      const resultReady = live.activityStatus === "busy" && activityStatus === "idle";
      live.activityStatus = activityStatus;
      this.emit("activity", { sessionId, activityStatus, resultReady } satisfies TerminalActivityEvent);
    } catch {
      // A failed local sample must not invent a completion or running warning.
    } finally {
      live.probing = false;
    }
  }

  attach(id: string): TerminalReplay {
    const live = this.sessions.get(id);
    return { data: live?.buffer ?? "", sequence: live?.sequence ?? 0 };
  }

  has(id: string): boolean { return this.sessions.has(id); }
  write(id: string, data: string): void { this.sessions.get(id)?.pty.write(data); }
  resize(id: string, cols: number, rows: number): void { this.sessions.get(id)?.pty.resize(cols, rows); }
  kill(id: string): void { this.sessions.get(id)?.pty.kill(); }
}
