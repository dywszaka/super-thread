import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";

async function setup(): Promise<{ service: WorkspaceService; store: JsonStore }> {
  const directory = await mkdtemp(join(tmpdir(), "superthread-device-"));
  const store = new JsonStore(join(directory, "state.json"));
  const service = new WorkspaceService(store, undefined, undefined, undefined, {
    sync: () => undefined,
    reconnectAll: () => undefined,
    setReconnectEnabled: () => undefined,
    stop: () => undefined
  });
  await service.initialize();
  await store.update((draft) => {
    draft.devices.push({ id: "dev_remote", name: "Old host", type: "remote", status: "online", createdAt: "now" });
    draft.connections.push({ deviceId: "dev_remote", transport: "ssh", config: { host: "old.example", user: "allen", port: 22 } });
  });
  return { service, store };
}

test("remote device connection settings can be updated", async () => {
  const { service } = await setup();

  await service.updateDevice({ id: "dev_remote", name: "GPU host", host: "gpu.example", user: "builder", port: 2202 });

  const snapshot = service.snapshot();
  assert.deepEqual(snapshot.devices.find((device) => device.id === "dev_remote"), {
    id: "dev_remote", name: "GPU host", type: "remote", status: "unknown", createdAt: "now"
  });
  assert.deepEqual(snapshot.connections.find((connection) => connection.deviceId === "dev_remote")?.config, {
    host: "gpu.example", user: "builder", port: 2202
  });
});

test("remote device tunnel settings are persisted", async () => {
  const { service } = await setup();
  const tunnels = [
    { direction: "local-to-remote" as const, sourcePort: 3000, destinationHost: "127.0.0.1", destinationPort: 3000 },
    { direction: "remote-to-local" as const, sourcePort: 5432, destinationHost: "127.0.0.1", destinationPort: 15432 }
  ];

  await service.updateDevice({ id: "dev_remote", name: "GPU host", host: "gpu.example", user: "builder", port: 2202, tunnels });

  assert.deepEqual(service.snapshot().connections.find((connection) => connection.deviceId === "dev_remote")?.config.tunnels, tunnels);
  service.shutdown();
});

test("local devices cannot be edited or deleted", async () => {
  const { service } = await setup();

  await assert.rejects(() => service.updateDevice({ id: "dev_local", name: "Renamed", host: "local", user: "me" }), /managed by SuperThread/);
  await assert.rejects(() => service.deleteDevice("dev_local"), /cannot be deleted/);
});

test("remote devices can only be deleted when no project checkout uses them", async () => {
  const { service, store } = await setup();
  await store.update((draft) => {
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_remote", path: "/srv/project", createdAt: "now" });
  });

  await assert.rejects(() => service.deleteDevice("dev_remote"), /project checkouts and workspaces/);

  await store.update((draft) => {
    draft.checkouts = [];
    draft.workspaces.push({
      id: "workspace-1", name: "orphaned", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_remote",
      checkoutId: "checkout-1", path: "/srv/project-worktree", branch: "work/orphaned", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
  });
  await assert.rejects(() => service.deleteDevice("dev_remote"), /project checkouts and workspaces/);

  await store.update((draft) => { draft.workspaces = []; });
  await service.deleteDevice("dev_remote");
  assert.equal(service.snapshot().devices.some((device) => device.id === "dev_remote"), false);
  assert.equal(service.snapshot().connections.some((connection) => connection.deviceId === "dev_remote"), false);
});

test("window closure gates wake reconnects until a window is reopened", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-window-"));
  const enabled: boolean[] = [];
  let reconnects = 0;
  const service = new WorkspaceService(new JsonStore(join(directory, "state.json")), undefined, undefined, undefined, {
    sync() {}, stop() {}, setReconnectEnabled(value) { enabled.push(value); },
    reconnectAll() { reconnects++; }
  });
  await service.initialize();
  service.setWindowOpen(false);
  service.reconnectTunnels();
  service.reconnectTunnels();
  assert.equal(reconnects, 0);
  service.setWindowOpen(true);
  service.reconnectTunnels();
  assert.deepEqual(enabled, [false, true]);
  assert.equal(reconnects, 1);
  service.shutdown();
});

test("saving conflicting local ports rejects the transaction and does not change persisted settings", async () => {
  const { service, store } = await setup();
  const tunnel = { direction: "local-to-remote" as const, sourcePort: 3000, destinationHost: "127.0.0.1", destinationPort: 3000 };
  await store.update((draft) => {
    draft.devices.push({ id: "dev_other", name: "Other GPU", type: "remote", status: "unknown", createdAt: "now" });
    draft.connections.push({ deviceId: "dev_other", transport: "ssh", config: { host: "other.example", tunnels: [tunnel] } });
  });
  await assert.rejects(() => service.updateDevice({ id: "dev_remote", name: "Changed", host: "gpu.example", user: "builder", tunnels: [tunnel] }), /Local port 3000 already has a tunnel on Other GPU/);
  assert.equal(service.snapshot().devices.find((device) => device.id === "dev_remote")!.name, "Old host");
  await assert.rejects(() => service.addDevice({ name: "New", host: "new.example", user: "builder", tunnels: [tunnel] }), /Local port 3000/);
  assert.equal(service.snapshot().devices.some((device) => device.name === "New"), false);
});

test("concurrent saves cannot reserve the same local listener twice", async () => {
  const { service, store } = await setup();
  await store.update((draft) => {
    draft.devices.push({ id: "dev_other", name: "Other", type: "remote", status: "unknown", createdAt: "now" });
    draft.connections.push({ deviceId: "dev_other", transport: "ssh", config: { host: "other.example" } });
  });
  const tunnels = [{ direction: "local-to-remote" as const, sourcePort: 3000, destinationHost: "localhost", destinationPort: 3000 }];
  const results = await Promise.allSettled([
    service.updateDevice({ id: "dev_remote", name: "GPU", host: "gpu.example", user: "builder", tunnels }),
    service.updateDevice({ id: "dev_other", name: "Other", host: "other.example", user: "builder", tunnels })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(service.snapshot().connections.filter((connection) => connection.config.tunnels?.length).length, 1);
});

test("saving starts tunnels immediately and exposes runtime updates without persisting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-tunnel-state-"));
  const store = new JsonStore(join(directory, "state.json"));
  const synced: unknown[] = [];
  let notify: () => void = () => {};
  const states = [{ deviceId: "dev_remote", tunnel: { direction: "local-to-remote" as const, sourcePort: 3000, destinationHost: "localhost", destinationPort: 8000 }, status: "active" as const }];
  const service = new WorkspaceService(store, undefined, undefined, undefined, {
    sync(connections) { synced.push(connections); }, reconnectAll() {}, setReconnectEnabled() {}, stop() {},
    statuses() { return structuredClone(states); }, onChanged(listener) { notify = listener; }
  });
  await service.initialize();
  await store.update((draft) => {
    draft.devices.push({ id: "dev_remote", name: "GPU", type: "remote", status: "online", createdAt: "now" });
    draft.connections.push({ deviceId: "dev_remote", transport: "ssh", config: { host: "gpu" } });
  });
  await service.updateDevice({ id: "dev_remote", name: "GPU", host: "gpu", user: "builder", tunnels: [states[0]!.tunnel] });
  assert.equal(synced.length, 2);
  let updates = 0;
  service.on("tunnels-changed", () => { updates++; });
  notify();
  assert.equal(updates, 1);
  assert.deepEqual(service.tunnelStatuses(), states);
  assert.equal(JSON.stringify(store.snapshot()).includes('"active"'), false);
});

test("editing only tunnels preserves device reachability without another connection check", async () => {
  const { service } = await setup();
  await service.updateDevice({ id: "dev_remote", name: "Old host", host: "old.example", user: "allen", port: 22,
    tunnels: [{ direction: "local-to-remote", sourcePort: 3000, destinationHost: "localhost", destinationPort: 8000 }] });
  assert.equal(service.snapshot().devices.find((device) => device.id === "dev_remote")!.status, "online");
});
