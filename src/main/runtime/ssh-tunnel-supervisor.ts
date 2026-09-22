import { spawn, type ChildProcess } from "node:child_process";
import type { DeviceConnection, SshTunnelConfig } from "../../shared/domain";

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;

type SpawnSsh = (args: string[]) => ChildProcess;
type Schedule = (callback: () => void, delayMs: number) => NodeJS.Timeout;

interface TunnelState {
  connection: DeviceConnection;
  signature: string;
  generation: number;
  attempt: number;
  startedAt: number;
  process?: ChildProcess;
  retryTimer?: NodeJS.Timeout;
}

const tunnelArgument = (tunnel: SshTunnelConfig): ["-L" | "-R", string] => {
  // Direction describes where the service is exposed, not the SSH flag:
  // remote-to-local exposes a remote service through a local (-L) listener.
  const flag = tunnel.direction === "remote-to-local" ? "-L" : "-R";
  return [flag, `127.0.0.1:${tunnel.destinationPort}:${tunnel.destinationHost}:${tunnel.sourcePort}`];
};

export function sshTunnelArgs(connection: DeviceConnection): string[] {
  const host = connection.config.host;
  if (connection.transport !== "ssh" || !host) return [];
  const config = connection.config;
  const args = [
    "-N",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "TCPKeepAlive=yes"
  ];
  if (config.port) args.push("-p", String(config.port));
  for (const tunnel of config.tunnels ?? []) args.push(...tunnelArgument(tunnel));
  args.push(config.user ? `${config.user}@${host}` : host);
  return args;
}

export class SshTunnelSupervisor {
  private readonly states = new Map<string, TunnelState>();
  private stopped = false;

  constructor(
    private readonly spawnSsh: SpawnSsh = (args) => spawn("ssh", args, { stdio: "ignore" }),
    private readonly schedule: Schedule = (callback, delayMs) => setTimeout(callback, delayMs),
    private readonly cancelSchedule: (timer: NodeJS.Timeout) => void = clearTimeout,
    private readonly clock: () => number = Date.now
  ) {}

  sync(connections: DeviceConnection[]): void {
    if (this.stopped) return;
    const desired = new Map(connections
      .filter((connection) => connection.transport === "ssh" && (connection.config.tunnels?.length ?? 0) > 0)
      .map((connection) => [connection.deviceId, connection]));

    for (const deviceId of this.states.keys()) {
      if (!desired.has(deviceId)) this.remove(deviceId);
    }
    for (const [deviceId, connection] of desired) {
      const signature = JSON.stringify(connection.config);
      const current = this.states.get(deviceId);
      if (current?.signature === signature) continue;
      if (current) this.remove(deviceId);
      this.states.set(deviceId, {
        connection: structuredClone(connection),
        signature,
        generation: 0,
        attempt: 0,
        startedAt: 0
      });
      this.start(deviceId);
    }
  }

  reconnectAll(): void {
    if (this.stopped) return;
    for (const [deviceId, state] of this.states) {
      state.attempt = 0;
      this.stopCurrent(state);
      this.start(deviceId);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const deviceId of [...this.states.keys()]) this.remove(deviceId);
  }

  private start(deviceId: string): void {
    const state = this.states.get(deviceId);
    if (!state || this.stopped) return;
    if (state.retryTimer) {
      this.cancelSchedule(state.retryTimer);
      state.retryTimer = undefined;
    }
    const generation = ++state.generation;
    try {
      const child = this.spawnSsh(sshTunnelArgs(state.connection));
      state.process = child;
      state.startedAt = this.clock();
      const exited = (): void => {
        const current = this.states.get(deviceId);
        if (!current || current.generation !== generation || current.process !== child) return;
        current.process = undefined;
        if (this.clock() - current.startedAt >= STABLE_CONNECTION_MS) current.attempt = 0;
        this.retry(deviceId, current);
      };
      child.once("error", exited);
      child.once("close", exited);
    } catch {
      this.retry(deviceId, state);
    }
  }

  private retry(deviceId: string, state: TunnelState): void {
    if (this.stopped || state.retryTimer) return;
    const delay = Math.min(INITIAL_RETRY_MS * (2 ** state.attempt), MAX_RETRY_MS);
    state.attempt += 1;
    state.retryTimer = this.schedule(() => {
      state.retryTimer = undefined;
      this.start(deviceId);
    }, delay);
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

  private remove(deviceId: string): void {
    const state = this.states.get(deviceId);
    if (!state) return;
    this.states.delete(deviceId);
    this.stopCurrent(state);
  }
}
