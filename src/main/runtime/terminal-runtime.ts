import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import { basename } from "node:path";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type { Device, DeviceConnection, Session, SessionActivityStatus, TerminalOutput, TerminalReplay, Workspace } from "../../shared/domain";
import { interactiveLoginShellCommand, quoteShellArgument } from "./login-shell";

interface LiveSession {
  pty: IPty;
  buffer: string;
  sequence: number;
  activityStatus: SessionActivityStatus;
  activityTimer?: NodeJS.Timeout;
  probing: boolean;
  remotePid?: number;
  markerBuffer: string;
}
export interface TerminalExitEvent { sessionId: string; exitCode?: number; }
export interface TerminalActivityEvent { sessionId: string; activityStatus: SessionActivityStatus; }

const remotePidMarker = /\x1b]777;superthread-pid=(\d+)\x07/;
const idleShells = new Set(["bash", "dash", "fish", "ksh", "nu", "sh", "tcsh", "zsh"]);

export function foregroundProcessIsBusy(output: string): boolean {
  const [processGroup, terminalProcessGroup] = output.trim().split(/\s+/).map(Number);
  return processGroup !== undefined && terminalProcessGroup !== undefined
    && Number.isInteger(processGroup) && Number.isInteger(terminalProcessGroup)
    && terminalProcessGroup > 0 && terminalProcessGroup !== processGroup;
}

export function tmuxPaneIsBusy(command: string): boolean {
  const executable = basename(command.trim()).replace(/^-/, "");
  return executable.length > 0 && !idleShells.has(executable);
}

export function tmuxActivityFromProbe(output: string): SessionActivityStatus {
  const [command = "", ...paneLines] = output.replaceAll("\r", "").split("\n");
  if (!tmuxPaneIsBusy(command)) return "idle";
  const executable = basename(command.trim()).replace(/^-/, "");
  const pane = paneLines.slice(-20).join("\n");
  const isCodexProcess = executable === "codex" || executable.startsWith("codex-");
  const isCodexNodeProcess = executable === "node" && /Ask Codex to do anything|\bWorking\b[^\n]*esc to interrupt|\bGPT-[\w.-]+\b[^\n]*(?:used|\bin\b|\bout\b)/i.test(pane);
  if (!isCodexProcess && !isCodexNodeProcess) return "busy";
  return codexActivityFromOutput(pane);
}

export function tmuxTarget(session: Session): string {
  const sessionName = session.tmuxSessionName || session.id;
  return session.tmuxWindowName ? `${sessionName}:${session.tmuxWindowName}` : sessionName;
}

export function legacyTmuxClientSessionName(session: Session): string {
  return `superthread-client-${session.id}`;
}

export function tmuxWindowLookupCommand(session: Session): string {
  const sessionName = quoteShellArgument(session.tmuxSessionName || session.id);
  const windowKey = quoteShellArgument(session.tmuxWindowKey || session.id);
  return `tmux list-windows -t ${sessionName} -F '#{window_id} #{@superthread_terminal_id}' 2>/dev/null | awk -v key=${windowKey} '$2 == key { print $1; exit }'`;
}

export function tmuxAttachCommand(session: Session, cwd: string): string {
  const sessionName = session.tmuxSessionName || session.id;
  if (!session.tmuxWindowKey && !session.tmuxWindowName) {
    return `tmux new-session -A -s ${quoteShellArgument(sessionName)}`;
  }
  if (session.tmuxWindowKey) {
    const quotedSession = quoteShellArgument(sessionName);
    const quotedKey = quoteShellArgument(session.tmuxWindowKey);
    const quotedCwd = quoteShellArgument(cwd);
    const lookup = tmuxWindowLookupCommand(session);
    return `if tmux has-session -t ${quotedSession} 2>/dev/null; then window=$(${lookup}); if [ -z "$window" ]; then window=$(tmux new-window -d -P -F '#{window_id}' -t ${quotedSession} -c ${quotedCwd}); fi; else window=$(tmux new-session -d -P -F '#{window_id}' -s ${quotedSession} -c ${quotedCwd}); fi; tmux set-option -w -t "$window" @superthread_terminal_id ${quotedKey}; exec tmux attach-session -t ${quotedSession}:"$window"`;
  }
  const quotedSession = quoteShellArgument(sessionName);
  const quotedWindow = quoteShellArgument(session.tmuxWindowName || session.id);
  const quotedCwd = quoteShellArgument(cwd);
  const ensureWindow = `if tmux has-session -t ${quotedSession} 2>/dev/null; then if ! tmux list-windows -t ${quotedSession} -F '#{window_name}' | grep -Fqx -- ${quotedWindow}; then tmux new-window -d -t ${quotedSession} -n ${quotedWindow} -c ${quotedCwd}; fi; else tmux new-session -d -s ${quotedSession} -n ${quotedWindow} -c ${quotedCwd}; fi`;
  const legacyClient = quoteShellArgument(session.tmuxClientSessionName || legacyTmuxClientSessionName(session));
  return `${ensureWindow}; tmux kill-session -t ${legacyClient} 2>/dev/null || true; exec tmux attach-session -t ${quoteShellArgument(tmuxTarget(session))}`;
}

export function codexActivityFromOutput(output: string): "busy" | "waiting-input" {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const waitingAt = lastMatchIndex(plain, /\b(approve|confirmation|permission|allow)\b|\b(?:y\/n|yes\/no)\b|press enter|waiting for (?:your )?input|Ask Codex to do anything|(?:^|\n)\s*[›>]\s/gim);
  const workingAt = lastMatchIndex(plain, /\bWorking\b|esc to interrupt/gim);
  return waitingAt > workingAt ? "waiting-input" : "busy";
}

function lastMatchIndex(value: string, pattern: RegExp): number {
  let index = -1;
  for (const match of value.matchAll(pattern)) index = match.index;
  return index;
}

function run(program: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 1_500);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${program} exited with ${code ?? "unknown"}`));
    });
  });
}

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
    } else if (kind === "codex" || kind === "tmux") {
      const command = this.managedToolCommand(kind, session, cwd);
      args = ["-lic", command];
    }
    const instance = pty.spawn(program, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: device.type === "local" ? cwd : os.homedir(),
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>
    });
    const live: LiveSession = {
      pty: instance,
      buffer: "",
      sequence: 0,
      activityStatus: session.activityStatus ?? "idle",
      probing: false,
      markerBuffer: ""
    };
    this.sessions.set(session.id, live);
    instance.onData((data) => {
      if (device.type === "remote" && kind === "shell" && live.remotePid === undefined) {
        live.markerBuffer += data;
        const marker = live.markerBuffer.match(remotePidMarker);
        if (!marker && live.markerBuffer.length < 4_096) return;
        if (marker) live.remotePid = Number(marker[1]);
        data = live.markerBuffer.replace(remotePidMarker, "");
        live.markerBuffer = "";
      }
      live.buffer = (live.buffer + data).slice(-64_000);
      live.sequence += 1;
      if (kind === "codex") {
        this.setActivity(session.id, live, codexActivityFromOutput(data));
      }
      this.emit("output", { sessionId: session.id, data, sequence: live.sequence } satisfies TerminalOutput);
    });
    instance.onExit(({ exitCode }) => {
      if (live.activityTimer) clearInterval(live.activityTimer);
      this.sessions.delete(session.id);
      this.emit("exit", { sessionId: session.id, exitCode } satisfies TerminalExitEvent);
    });
    if (kind !== "codex") {
      const probe = (): void => { void this.probeActivity(session, live, device, connection); };
      live.activityTimer = setInterval(probe, 1_000);
      live.activityTimer.unref();
      probe();
    }
    return instance.pid;
  }

  private remoteCommand(kind: string, session: Session, cwd: string): string {
    if (kind === "codex" || kind === "tmux") {
      return interactiveLoginShellCommand(`cd ${quoteShellArgument(cwd)} && ${this.managedToolCommand(kind, session, cwd)}`);
    }
    return `cd ${quoteShellArgument(cwd)} && printf '\\033]777;superthread-pid=%s\\007' "$$" && exec "\${SHELL:-/bin/sh}" -l`;
  }

  private managedToolCommand(kind: "codex" | "tmux", session: Session, cwd: string): string {
    if (kind === "codex") {
      const args = session.codexConversationId ? ` resume ${quoteShellArgument(session.codexConversationId)}` : "";
      return `codex${args}`;
    }
    return tmuxAttachCommand(session, cwd);
  }

  private async probeActivity(session: Session, live: LiveSession, device: Device, connection: DeviceConnection): Promise<void> {
    if (live.probing || !this.sessions.has(session.id)) return;
    live.probing = true;
    try {
      const kind = session.kind ?? "shell";
      let command: string;
      let interpret: (output: string) => SessionActivityStatus;
      if (kind === "tmux") {
        if (session.tmuxWindowKey) {
          command = `target=$(${tmuxWindowLookupCommand(session)}); test -n "$target"; tmux display-message -p -t "$target" '#{pane_current_command}'; tmux capture-pane -p -t "$target" -S -20`;
        } else {
          const target = quoteShellArgument(tmuxTarget(session));
          command = `tmux display-message -p -t ${target} '#{pane_current_command}'; tmux capture-pane -p -t ${target} -S -20`;
        }
        interpret = tmuxActivityFromProbe;
      } else {
        const pid = device.type === "remote" ? live.remotePid : live.pty.pid;
        if (!pid) return;
        command = `ps -o pgid= -o tpgid= -p ${pid}`;
        interpret = (output) => foregroundProcessIsBusy(output) ? "busy" : "idle";
      }
      const output = device.type === "remote"
        ? await run("ssh", this.sshArgs(connection, interactiveLoginShellCommand(command)))
        : await run("sh", ["-lc", command]);
      this.setActivity(session.id, live, interpret(output));
    } catch {
      // A transient probe failure must not turn an idle terminal into a false running warning.
    } finally {
      live.probing = false;
    }
  }

  private sshArgs(connection: DeviceConnection, command: string): string[] {
    const config = connection.config;
    const target = config.user ? `${config.user}@${config.host}` : String(config.host);
    const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=2"];
    if (config.port) args.push("-p", String(config.port));
    args.push(target, command);
    return args;
  }

  private setActivity(sessionId: string, live: LiveSession, activityStatus: SessionActivityStatus): void {
    if (live.activityStatus === activityStatus) return;
    live.activityStatus = activityStatus;
    this.emit("activity", { sessionId, activityStatus } satisfies TerminalActivityEvent);
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
