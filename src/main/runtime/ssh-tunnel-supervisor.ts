import { spawn, type ChildProcess } from "node:child_process";
import type { DeviceConnection, SshTunnelConfig, SshTunnelRuntime } from "../../shared/domain";
import { tunnelBinding } from "../../shared/ssh-tunnels";

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;
const READY_MARKER = "SUPERTHREAD_TUNNEL_READY";

type SpawnSsh = (args: string[]) => ChildProcess;
type Schedule = (callback: () => void, delayMs: number) => NodeJS.Timeout;

interface TunnelState {
  connection: DeviceConnection;
  runtime: SshTunnelRuntime;
  signature: string;
  generation: number;
  attempt: number;
  startedAt: number;
  process?: ChildProcess;
  retryTimer?: NodeJS.Timeout;
}

const tunnelArgument = (tunnel: SshTunnelConfig): ["-L" | "-R", string] => {
  const flag = tunnel.direction === "local-to-remote" ? "-L" : "-R";
  return [flag, `127.0.0.1:${tunnel.sourcePort}:${tunnel.destinationHost}:${tunnel.destinationPort}`];
};

export function sshTunnelArgs(connection: DeviceConnection): string[] {
  const host = connection.config.host;
  if (connection.transport !== "ssh" || !host) return [];
  const config = connection.config;
  const args = [
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "TCPKeepAlive=yes",
    "-o", "LogLevel=DEBUG1",
    // Run a fixed local command after authentication and local forward setup.
    // A spawned SSH process alone does not mean its listener is ready.
    "-o", "PermitLocalCommand=yes",
    "-o", `LocalCommand=printf '${READY_MARKER}\\n'`,
    // Each managed forward owns its lifecycle, independent of SSH config masters.
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ForkAfterAuthentication=no"
  ];
  if (config.port) args.push("-p", String(config.port));
  for (const tunnel of config.tunnels ?? []) args.push(...tunnelArgument(tunnel));
  args.push(config.user ? `${config.user}@${host}` : host);
  return args;
}

export class SshTunnelSupervisor {
  private readonly states = new Map<string, TunnelState>();
  private stopped = false;
  private reconnectEnabled = true;
  private changed: () => void = () => {};

  constructor(
    private readonly spawnSsh: SpawnSsh = (args) => spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] }),
    private readonly schedule: Schedule = (callback, delayMs) => setTimeout(callback, delayMs),
    private readonly cancelSchedule: (timer: NodeJS.Timeout) => void = clearTimeout,
    private readonly clock: () => number = Date.now
  ) {}

  onChanged(listener: () => void): void { this.changed = listener; }
  statuses(): SshTunnelRuntime[] { return structuredClone([...this.states.values()].map((state) => state.runtime)); }

  sync(connections: DeviceConnection[]): void {
    if (this.stopped) return;
    const desired = new Map<string, DeviceConnection>();
    for (const connection of connections) {
      if (connection.transport !== "ssh") continue;
      for (const tunnel of connection.config.tunnels ?? []) {
        desired.set(`${connection.deviceId}:${tunnelBinding(tunnel)}`, {
          ...connection, config: { ...connection.config, tunnels: [tunnel] }
        });
      }
    }
    for (const key of this.states.keys()) {
      if (!desired.has(key)) this.remove(key);
    }
    for (const [key, connection] of desired) {
      const signature = JSON.stringify(connection.config);
      const current = this.states.get(key);
      if (current?.signature === signature) continue;
      if (current) this.remove(key);
      this.states.set(key, {
        connection: structuredClone(connection),
        runtime: { deviceId: connection.deviceId, tunnel: structuredClone(connection.config.tunnels![0]!), status: "paused" },
        signature, generation: 0, attempt: 0, startedAt: 0
      });
      this.start(key);
    }
    this.changed();
  }

  reconnectAll(): void {
    if (this.stopped || !this.reconnectEnabled) return;
    for (const [key, state] of this.states) {
      state.attempt = 0;
      this.stopCurrent(state);
      this.start(key);
    }
  }

  setReconnectEnabled(enabled: boolean): void {
    if (this.stopped || this.reconnectEnabled === enabled) return;
    this.reconnectEnabled = enabled;
    for (const [key, state] of this.states) {
      if (!enabled && state.retryTimer) {
        this.cancelSchedule(state.retryTimer);
        state.retryTimer = undefined;
      }
      // Preserve live forwards while windows are closed.
      if (!enabled && !state.process) this.setStatus(state, "paused");
      if (enabled && !state.process) this.start(key);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const key of [...this.states.keys()]) this.remove(key);
  }

  private setStatus(state: TunnelState, status: SshTunnelRuntime["status"], error?: string, retryAt?: number): void {
    Object.assign(state.runtime, { status, error, retryAt });
    this.changed();
  }

  private start(key: string): void {
    const state = this.states.get(key);
    if (!state || state.process || this.stopped || !this.reconnectEnabled) return;
    if (state.retryTimer) {
      this.cancelSchedule(state.retryTimer);
      state.retryTimer = undefined;
    }
    const generation = ++state.generation;
    this.setStatus(state, "connecting");
    try {
      const child = this.spawnSsh(sshTunnelArgs(state.connection));
      state.process = child;
      state.startedAt = this.clock();
      let output = "";
      let diagnostic = "";
      let stderrLine = "";
      const tunnel = state.runtime.tunnel;
      const isCurrent = (): boolean => this.states.get(key) === state && state.generation === generation && state.process === child;
      child.stdout?.on("data", (chunk: Buffer) => {
        if (!isCurrent()) return;
        output = (output + chunk.toString()).slice(-1024);
        if (tunnel.direction === "local-to-remote" && output.split(/\r?\n/).includes(READY_MARKER)) this.setStatus(state, "active");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (!isCurrent()) return;
        const lines = (stderrLine + chunk.toString()).split(/\r?\n/);
        stderrLine = lines.pop()!.slice(-2048);
        for (const line of lines) {
          // Reverse forwards are confirmed asynchronously, after LocalCommand.
          if (tunnel.direction === "remote-to-local" && line.includes(`remote forward success for: listen 127.0.0.1:${tunnel.sourcePort},`)) this.setStatus(state, "active");
          if (line && !/^debug\d*:/.test(line)) diagnostic = (diagnostic + line + "\n").slice(-2048);
        }
      });
      const exited = (error?: Error): void => {
        if (!isCurrent()) return;
        state.process = undefined;
        if (this.clock() - state.startedAt >= STABLE_CONNECTION_MS) state.attempt = 0;
        const message = error?.message || diagnostic.trim() || stderrLine.trim() || "SSH connection closed";
        this.retry(key, state, message.replace(/[\x00-\x1f\x7f]/g, " ").slice(-600));
      };
      child.once("error", exited);
      child.once("close", () => exited());
    } catch (error) {
      this.retry(key, state, error instanceof Error ? error.message : String(error));
    }
  }

  private retry(key: string, state: TunnelState, error: string): void {
    if (this.stopped || state.retryTimer) return;
    if (!this.reconnectEnabled) { this.setStatus(state, "paused", error); return; }
    const delay = Math.min(INITIAL_RETRY_MS * (2 ** state.attempt), MAX_RETRY_MS);
    state.attempt += 1;
    const generation = state.generation;
    state.retryTimer = this.schedule(() => {
      if (this.states.get(key) !== state || state.generation !== generation || !state.retryTimer) return;
      state.retryTimer = undefined;
      this.start(key);
    }, delay);
    this.setStatus(state, "retrying", error, this.clock() + delay);
  }

  private stopCurrent(state: TunnelState): void {
    state.generation += 1;
    if (state.retryTimer) {
      this.cancelSchedule(state.retryTimer);
      state.retryTimer = undefined;
    }
    const child = state.process;
    state.process = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  private remove(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    this.states.delete(key);
    this.stopCurrent(state);
  }
}
