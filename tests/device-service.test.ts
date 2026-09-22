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
