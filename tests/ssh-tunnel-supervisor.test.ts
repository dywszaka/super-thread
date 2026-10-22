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

class FakeChild extends EventEmitter {
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

  supervisor.sync([connection]);
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

  supervisor.sync([connection]);
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
  supervisor.sync([connection]);
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
  supervisor.sync([connection]);
  assert.equal(spawned, 0);
  supervisor.setReconnectEnabled(true);
  assert.equal(spawned, 1);
  supervisor.setReconnectEnabled(true);
  assert.equal(spawned, 1);
  supervisor.stop();
});
