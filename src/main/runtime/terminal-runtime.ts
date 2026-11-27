import { EventEmitter } from "node:events";
import os from "node:os";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type { Device, DeviceConnection, Session, SessionActivityStatus, TerminalOutput, TerminalReplay, Workspace } from "../../shared/domain";
import { DeviceCommandRunner, ProcessCommandRunner } from "./command-runner";
import { quoteShellArgument } from "./login-shell";
import { randomBytes } from "node:crypto";
import { CodexRecordingDecoder, codexRecordingCommand } from "./codex-recording";
import { TerminalPidDecoder, terminalProcessArgs, terminalPrograms } from "./terminal-processes";

interface LiveSession {
  pty: IPty;
  buffer: string;
  sequence: number;
  activityStatus: SessionActivityStatus;
  activityTimer?: NodeJS.Timeout;
  probing: boolean;
  deviceId: string;
  connection: DeviceConnection;
  remote: boolean;
  shellPid?: number;
}
export interface TerminalProcessInspection { sessionId: string; programs: string[]; error?: string; }
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
const runRemoteProbe = async (connection: DeviceConnection): Promise<string> =>
  (await new DeviceCommandRunner(connection).run("ps", terminalProcessArgs, { timeoutMs: 6_000 })).stdout;

export class TerminalRuntime extends EventEmitter {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(
    private readonly runProbe = runLocalProbe,
    private readonly spawnPty: typeof pty.spawn = pty.spawn,
    private readonly inspectRemote = runRemoteProbe
  ) { super(); }

  create(session: Session, workspace: Workspace, device: Device, connection: DeviceConnection): number {
    if (session.kind && session.kind !== "shell") throw new Error("Only shell terminal sessions are supported");
    if (this.sessions.has(session.id)) throw new Error("Terminal session is already running");
    const remote = device.type === "remote";
    const cwd = session.cwd || workspace.path;
    const token = device.codexRecordingEnabled ? randomBytes(24).toString("hex") : undefined;
    const bootstrap = token ? codexRecordingCommand("bootstrap", token) : undefined;
    const pidToken = remote ? randomBytes(24).toString("hex") : undefined;
    const announcePid = `printf '\\033]777;superthread-terminal;${pidToken};%s\\007' "$$"; `;
    const program = remote ? "ssh" : bootstrap ? "/bin/sh" : process.env.SHELL || "/bin/zsh";
    const args = remote
      ? sshTerminalArgs(connection, `cd ${quoteShellArgument(cwd)} && { ${announcePid}${bootstrap || 'exec "${SHELL:-/bin/sh}" -l'}; }`)
      : bootstrap ? ["-c", bootstrap] : ["-l"];
    const instance = this.spawnPty(program, args, {
      name: "xterm-256color", cols: 100, rows: 30,
      cwd: remote ? os.homedir() : cwd,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SUPERTHREAD_") && key !== "BASH_FUNC_codex%%")), TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>
    });
    const live: LiveSession = {
      pty: instance, buffer: "", sequence: 0,
      activityStatus: remote ? "unknown" : "idle", probing: false,
      deviceId: device.id, connection, remote, shellPid: remote ? undefined : instance.pid
    };
    this.sessions.set(session.id, live);
    const decoder = token ? new CodexRecordingDecoder(token, (event) => this.emit("codex-recording", { ...event, terminalId: session.id })) : undefined;
    const pidDecoder = pidToken ? new TerminalPidDecoder(pidToken, (pid) => { live.shellPid ??= pid; }) : undefined;
    instance.onData((data) => {
      data = pidDecoder ? pidDecoder.feed(data) : data;
      data = decoder ? decoder.feed(data) : data;
      if (!data) return;
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
    // additional SSH sessions for periodic activity checks. Close/quit inspection is on demand.
    if (!remote) {
      const probe = (): void => { void this.probeActivity(session.id, live); };
      live.activityTimer = setInterval(probe, 1_000);
      live.activityTimer.unref();
      probe();
    }
    return instance.pid;
  }

  async inspectPrograms(ids?: string[]): Promise<TerminalProcessInspection[]> {
    const selected = new Set(ids ?? this.sessions.keys());
    const snapshots = new Map<string, Promise<string>>();
    return (await Promise.all([...this.sessions].filter(([id]) => selected.has(id)).map(async ([sessionId, live]) => {
      let programs: string[] = [];
      let error: string | undefined;
      try {
        if (!live.shellPid) throw new Error("Terminal is still connecting; shell PID is not available");
        const key = live.remote ? `remote:${live.deviceId}` : "local";
        let snapshot = snapshots.get(key);
        if (!snapshot) {
          snapshot = live.remote ? this.inspectRemote(live.connection) : this.runProbe("ps", terminalProcessArgs);
          snapshots.set(key, snapshot);
        }
        programs = terminalPrograms(await snapshot, live.shellPid);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      return this.sessions.get(sessionId) === live ? { sessionId, programs, error } : undefined;
    }))).filter((item) => item !== undefined);
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
