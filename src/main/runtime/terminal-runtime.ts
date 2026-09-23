import { EventEmitter } from "node:events";
import os from "node:os";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type { Device, DeviceConnection, Session, TerminalOutput, TerminalReplay, Workspace } from "../../shared/domain";

interface LiveSession { pty: IPty; buffer: string; sequence: number; }

export class TerminalRuntime extends EventEmitter {
  private readonly sessions = new Map<string, LiveSession>();

  create(session: Session, workspace: Workspace, device: Device, connection: DeviceConnection): number {
    const shell = process.env.SHELL || "/bin/zsh";
    let program = shell;
    let args = ["-l"];
    if (device.type === "remote") {
      const config = connection.config;
      const target = config.user ? `${config.user}@${config.host}` : String(config.host);
      program = "ssh";
      args = ["-t"];
      if (config.port) args.push("-p", String(config.port));
      args.push(target, `cd '${workspace.path.replaceAll("'", `'\\''`)}' && exec \"\${SHELL:-/bin/sh}\" -l`);
    }
    const instance = pty.spawn(program, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: device.type === "local" ? workspace.path : os.homedir(),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>
    });
    const live: LiveSession = { pty: instance, buffer: "", sequence: 0 };
    this.sessions.set(session.id, live);
    instance.onData((data) => {
      live.buffer = (live.buffer + data).slice(-64_000);
      live.sequence += 1;
      this.emit("output", { sessionId: session.id, data, sequence: live.sequence } satisfies TerminalOutput);
    });
    instance.onExit(({ exitCode }) => {
      this.sessions.delete(session.id);
      this.emit("exit", session.id, exitCode);
    });
    return instance.pid;
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
