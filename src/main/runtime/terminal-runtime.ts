import { EventEmitter } from "node:events";
import os from "node:os";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type { Device, DeviceConnection, Session, TerminalOutput, TerminalReplay, Workspace } from "../../shared/domain";

interface LiveSession { pty: IPty; buffer: string; sequence: number; }
export interface TerminalExitEvent { sessionId: string; exitCode?: number; }
export interface TerminalActivityEvent { sessionId: string; activityStatus: "busy" | "waiting-input"; }

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export class TerminalRuntime extends EventEmitter {
  private readonly sessions = new Map<string, LiveSession>();

  create(session: Session, workspace: Workspace, device: Device, connection: DeviceConnection): number {
    const shell = process.env.SHELL || "/bin/zsh";
    const cwd = session.cwd || workspace.path;
    const kind = session.kind ?? "shell";
    let program = shell;
    let args: string[] = ["-l"];
    if (device.type === "remote") {
      const config = connection.config;
      const target = config.user ? `${config.user}@${config.host}` : String(config.host);
      const command = this.remoteCommand(kind, session, cwd);
      program = "ssh";
      args = ["-t"];
      if (config.port) args.push("-p", String(config.port));
      args.push(target, command);
    } else if (kind === "codex") {
      program = "codex";
      args = session.codexConversationId ? ["resume", session.codexConversationId] : [];
    } else if (kind === "tmux") {
      program = "tmux";
      args = ["new-session", "-A", "-s", session.tmuxSessionName || session.id];
    }
    const instance = pty.spawn(program, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: device.type === "local" ? cwd : os.homedir(),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>
    });
    const live: LiveSession = { pty: instance, buffer: "", sequence: 0 };
    this.sessions.set(session.id, live);
    instance.onData((data) => {
      live.buffer = (live.buffer + data).slice(-64_000);
      live.sequence += 1;
      if ((session.kind ?? "shell") === "codex") {
        const activityStatus = /\b(waiting|approve|confirm|input|permission)\b/i.test(data) ? "waiting-input" : "busy";
        this.emit("activity", { sessionId: session.id, activityStatus } satisfies TerminalActivityEvent);
      }
      this.emit("output", { sessionId: session.id, data, sequence: live.sequence } satisfies TerminalOutput);
    });
    instance.onExit(({ exitCode }) => {
      this.sessions.delete(session.id);
      this.emit("exit", { sessionId: session.id, exitCode } satisfies TerminalExitEvent);
    });
    return instance.pid;
  }

  private remoteCommand(kind: string, session: Session, cwd: string): string {
    const prefix = `cd ${quote(cwd)} && exec `;
    if (kind === "codex") {
      const args = session.codexConversationId ? ` resume ${quote(session.codexConversationId)}` : "";
      return `${prefix}codex${args}`;
    }
    if (kind === "tmux") return `${prefix}tmux new-session -A -s ${quote(session.tmuxSessionName || session.id)}`;
    return `${prefix}"\${SHELL:-/bin/sh}" -l`;
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
