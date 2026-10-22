import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import type { DeviceConnection } from "../src/shared/domain";
import { SshTunnelSupervisor, sshTunnelArgs } from "../src/main/runtime/ssh-tunnel-supervisor";

const connection: DeviceConnection = {
  deviceId: "dev_remote",
  transport: "ssh",
  config: {
    host: "dev.example",
    user: "builder",
    port: 2202,
    tunnels: [
      { direction: "local-to-remote", sourcePort: 3000, destinationHost: "127.0.0.1", destinationPort: 3001 },
      { direction: "remote-to-local", sourcePort: 5432, destinationHost: "127.0.0.1", destinationPort: 15432 }
    ]
  }
};

const singleConnection: DeviceConnection = { ...connection, config: { ...connection.config, tunnels: [connection.config.tunnels![0]!] } };

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killedWith?: NodeJS.Signals;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith = signal;
    this.signalCode = signal;
    return true;
  }
}

test("sshTunnelArgs creates loopback-only local and reverse forwards with keepalives", () => {
  assert.deepEqual(sshTunnelArgs(connection), [
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "TCPKeepAlive=yes",
    "-o", "LogLevel=DEBUG1",
    "-o", "PermitLocalCommand=yes",
    "-o", "LocalCommand=printf 'SUPERTHREAD_TUNNEL_READY\\n'",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ForkAfterAuthentication=no",
    "-p", "2202",
    "-L", "127.0.0.1:3000:127.0.0.1:3001",
    "-R", "127.0.0.1:5432:127.0.0.1:15432",
    "builder@dev.example"
  ]);
});

test("SshTunnelSupervisor reconnects with backoff and recycles connections on resume", () => {
  const children: FakeChild[] = [];
  const delays: number[] = [];
  const callbacks: Array<() => void> = [];
  const supervisor = new SshTunnelSupervisor(
    () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    (callback, delay) => {
      callbacks.push(callback);
      delays.push(delay);
      return { delay } as unknown as NodeJS.Timeout;
    },
    () => undefined,
    () => 0
  );

  supervisor.sync([singleConnection]);
  assert.equal(children.length, 1);

  children[0]?.emit("close", 255, null);
  assert.deepEqual(delays, [1_000]);
  callbacks[0]?.();
  assert.equal(children.length, 2);

  children[1]?.emit("close", 255, null);
  assert.deepEqual(delays, [1_000, 2_000]);
  callbacks[1]?.();
  supervisor.reconnectAll();
  assert.equal(children.length, 4);
  assert.equal(children[2]?.killedWith, "SIGTERM");

  supervisor.stop();
  assert.equal(children[3]?.killedWith, "SIGTERM");
});

test("SshTunnelSupervisor stops removed device tunnels", () => {
  const child = new FakeChild();
  const supervisor = new SshTunnelSupervisor(() => child as unknown as ChildProcess);

  supervisor.sync([singleConnection]);
  supervisor.sync([]);

  assert.equal(child.killedWith, "SIGTERM");
});

test("closed windows cancel retries, suppress wake reconnects and preserve live forwards", () => {
  const children: FakeChild[] = [];
  const callbacks: Array<() => void> = [];
  const cancelled: NodeJS.Timeout[] = [];
  const supervisor = new SshTunnelSupervisor(
    () => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; },
    (callback) => { callbacks.push(callback); return { id: callbacks.length } as unknown as NodeJS.Timeout; },
    (timer) => { cancelled.push(timer); }
  );
  supervisor.sync([singleConnection]);
  supervisor.setReconnectEnabled(false);
  supervisor.reconnectAll();
  assert.equal(children.length, 1);
  assert.equal(children[0]?.killedWith, undefined);
  // A forward may disconnect after the window closes. Do not retry it.
  children[0]?.emit("close", 255, null);
  assert.equal(callbacks.length, 0);
  supervisor.setReconnectEnabled(true);
  assert.equal(children.length, 2);
  children[1]?.emit("close", 255, null);
  assert.equal(callbacks.length, 1);
  supervisor.setReconnectEnabled(false);
  assert.equal(cancelled.length, 1);
  callbacks[0]?.(); // A callback already queued when cancellation occurred.
  supervisor.reconnectAll();
  assert.equal(children.length, 2);
  supervisor.setReconnectEnabled(true);
  assert.equal(children.length, 3);
  supervisor.stop();
});

test("configuration sync cannot spawn SSH while reconnects are suspended", () => {
  let spawned = 0;
  const supervisor = new SshTunnelSupervisor(() => { spawned++; return new FakeChild() as unknown as ChildProcess; });
  supervisor.setReconnectEnabled(false);
  supervisor.sync([singleConnection]);
  assert.equal(spawned, 0);
  supervisor.setReconnectEnabled(true);
  assert.equal(spawned, 1);
  supervisor.setReconnectEnabled(true);
  assert.equal(spawned, 1);
  supervisor.stop();
});


test("tunnels become active only after local readiness or the matching reverse confirmation", () => {
  const children: FakeChild[] = [];
  const supervisor = new SshTunnelSupervisor(() => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; });
  let changes = 0;
  supervisor.onChanged(() => { changes++; });
  supervisor.sync([connection]);
  assert.equal(children.length, 2);
  assert.deepEqual(supervisor.statuses().map((item) => item.status), ["connecting", "connecting"]);
  children[0]!.stdout.emit("data", Buffer.from("SUPERTHREAD_TUNNEL_"));
  assert.equal(supervisor.statuses()[0]!.status, "connecting");
  children[0]!.stdout.emit("data", Buffer.from("READY\n"));
  children[1]!.stdout.emit("data", Buffer.from("SUPERTHREAD_TUNNEL_READY\n"));
  assert.deepEqual(supervisor.statuses().map((item) => item.status), ["active", "connecting"]);
  children[1]!.stderr.emit("data", Buffer.from("debug1: remote forward success for: listen 127.0.0.1:9999, connect localhost:12\n"));
  assert.equal(supervisor.statuses()[1]!.status, "connecting");
  children[1]!.stderr.emit("data", Buffer.from("debug1: remote forward success for: listen 127.0.0.1:"));
  children[1]!.stderr.emit("data", Buffer.from("5432, connect 127.0.0.1:15432\r\n"));
  assert.equal(supervisor.statuses()[1]!.status, "active");
  assert.ok(changes >= 3);
  const statuses = supervisor.statuses();
  statuses[0]!.tunnel.sourcePort = 1;
  assert.equal(supervisor.statuses()[0]!.tunnel.sourcePort, 3000);
  supervisor.stop();
});

test("a failing mapping reports its error and retries without restarting other forwards", () => {
  const children: FakeChild[] = [];
  const callbacks: Array<() => void> = [];
  const supervisor = new SshTunnelSupervisor(
    () => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; },
    (callback) => { callbacks.push(callback); return {} as NodeJS.Timeout; },
    () => {}, () => 100
  );
  supervisor.sync([connection]);
  children[0]!.stdout.emit("data", Buffer.from("SUPERTHREAD_TUNNEL_READY\n"));
  children[1]!.stderr.emit("data", Buffer.from("Error: remote port forwarding failed for listen port 5432\n"));
  children[1]!.emit("close", 255);
  assert.equal(supervisor.statuses()[0]!.status, "active");
  assert.equal(supervisor.statuses()[1]!.status, "retrying");
  assert.match(supervisor.statuses()[1]!.error!, /port forwarding failed/);
  assert.equal(supervisor.statuses()[1]!.retryAt, 1100);
  // A late readiness marker from an exited process cannot overwrite the failure.
  children[1]!.stderr.emit("data", Buffer.from("debug1: remote forward success for: listen 127.0.0.1:5432, connect localhost:15432\n"));
  assert.equal(supervisor.statuses()[1]!.status, "retrying");
  callbacks[0]!();
  assert.equal(children.length, 3);
  assert.equal(children[0]!.killedWith, undefined);
  supervisor.stop();
});

test("saving one mapping preserves unchanged live mappings and ignores stale events", () => {
  const children: FakeChild[] = [];
  const supervisor = new SshTunnelSupervisor(() => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; });
  supervisor.sync([connection]);
  const changed = structuredClone(connection);
  changed.config.tunnels![1]!.destinationPort = 8000;
  supervisor.sync([changed]);
  assert.equal(children.length, 3);
  assert.equal(children[0]!.killedWith, undefined);
  assert.equal(children[1]!.killedWith, "SIGTERM");
  children[1]!.emit("error", new Error("late error"));
  assert.equal(supervisor.statuses()[1]!.status, "connecting");
  supervisor.sync([changed]);
  assert.equal(children.length, 3);
  supervisor.sync([]);
  assert.deepEqual(supervisor.statuses(), []);
  supervisor.stop();
});

test("cancelled retries cannot restart a replacement mapping or create duplicate processes", () => {
  const children: FakeChild[] = [];
  const callbacks: Array<() => void> = [];
  const supervisor = new SshTunnelSupervisor(
    () => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; },
    (callback) => { callbacks.push(callback); return {} as NodeJS.Timeout; }, () => {}
  );
  supervisor.sync([singleConnection]);
  children[0]!.emit("error", new Error("spawn failed"));
  assert.equal(supervisor.statuses()[0]!.error, "spawn failed");
  supervisor.setReconnectEnabled(false);
  assert.equal(supervisor.statuses()[0]!.status, "paused");
  supervisor.setReconnectEnabled(true);
  callbacks[0]!();
  assert.equal(children.length, 2);
  children[1]!.emit("close", 255);
  const changed = structuredClone(singleConnection);
  changed.config.tunnels![0]!.destinationPort++;
  supervisor.sync([changed]);
  callbacks[1]!();
  assert.equal(children.length, 3);
  supervisor.stop();
});
