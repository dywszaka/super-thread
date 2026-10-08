import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";
import { TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import { createSessionSchema, deleteTerminalPresetSchema, saveTerminalPresetSchema } from "../src/shared/contract";
import type { Session, Device } from "../src/shared/domain";

async function setup(remote = false) {
  const root = await mkdtemp(join(tmpdir(), "superthread-custom-terminal-"));
  const file = join(root, "state.json");
  const store = new JsonStore(file);
  const created: Session[] = [];
  const terminals = Object.assign(new EventEmitter(), {
    has: () => false,
    create: (session: Session) => { created.push(session); return 100 + created.length; },
    kill: () => {},
    shutdown: () => {}
  }) as unknown as TerminalRuntime;
  const calls: Array<{ deviceId: string; path?: string }> = [];
  const service = new WorkspaceService(store, terminals, undefined, remote ? (device: Device) => ({
    list: async (path) => {
      calls.push({ deviceId: device.id, path });
      if (path === "/missing") throw new Error("Directory not found");
      return { deviceId: device.id, path: path === "~/tools" ? "/home/builder/tools" : path!, entries: [], parentPath: null };
    }
  }) : undefined);
  await service.initialize();
  await store.update((draft) => {
    draft.devices.push({ id: "remote", name: "GPU", type: "remote", status: "online", createdAt: "now" });
    draft.connections.push({ deviceId: "remote", transport: "ssh", config: { host: "gpu", user: "builder" } });
    for (const [id, deviceId] of [["local-a", "dev_local"], ["local-b", "dev_local"], ["remote-a", "remote"]]) {
      draft.workspaces.push({ id: id!, deviceId: deviceId!, name: id!, workThreadId: "thread", projectId: "project", checkoutId: "checkout", path: root, branch: "main", baseBranch: "main", status: "ready", createdAt: "now", updatedAt: "now" });
    }
  });
  return { service, store, created, root, file, calls };
}

test("custom terminal IPC rejects invalid names, directories, extra fields and non-shell kinds", () => {
  const input = { deviceId: "local", name: " Tools ", path: " ~/tools " };
  assert.deepEqual(saveTerminalPresetSchema.parse(input), { deviceId: "local", name: "Tools", path: "~/tools" });
  for (const patch of [{ name: " " }, { name: "x".repeat(81) }, { path: "" }, { path: "/tmp\u0000x" }, { path: "/tmp\ncommand" }, { deviceId: "" }, { workspaceId: "ws" }]) {
    assert.equal(saveTerminalPresetSchema.safeParse({ ...input, ...patch }).success, false);
  }
  assert.equal(deleteTerminalPresetSchema.safeParse({ deviceId: "local", id: "preset" }).success, true);
  assert.equal(deleteTerminalPresetSchema.safeParse({ id: "preset" }).success, false);
  assert.equal(createSessionSchema.safeParse({ workspaceId: "ws", terminalPresetId: "preset" }).success, true);
  assert.equal(createSessionSchema.safeParse({ workspaceId: "ws", terminalPresetId: "preset", kind: "codex" }).success, false);
});

test("device presets persist, share across workspaces, isolate devices and survive editing/deletion in existing sessions", async () => {
  const { service, store, created, root, file } = await setup();
  await service.saveTerminalPreset({ deviceId: "dev_local", name: "Tools", path: root });
  const preset = service.snapshot().devices.find((item) => item.id === "dev_local")!.terminalPresets![0]!;
  assert.deepEqual((await new JsonStore(file).load()).devices.find((item) => item.id === "dev_local")?.terminalPresets, [preset]);
  await assert.rejects(service.saveTerminalPreset({ deviceId: "dev_local", name: " tools ", path: root }), /already exists/);
  await assert.rejects(service.createSession({ workspaceId: "remote-a", terminalPresetId: preset.id }), /workspace’s device/);
  await assert.rejects(service.createSession({ workspaceId: "local-a", terminalPresetId: "missing" }), /workspace’s device/);
  const first = await service.createSession({ workspaceId: "local-a", terminalPresetId: preset.id });
  const second = await service.createSession({ workspaceId: "local-b", terminalPresetId: preset.id });
  assert.equal(first.session.cwd, preset.path);
  assert.equal(second.session.name, "Tools");
  assert.equal(second.session.kind, "shell");
  assert.equal(created[1]?.workspaceId, "local-b");
  await service.saveTerminalPreset({ deviceId: "dev_local", id: preset.id, name: "Home", path: "~" });
  assert.equal(service.snapshot().devices.find((item) => item.id === "dev_local")?.terminalPresets?.[0]?.path, homedir());
  await service.deleteTerminalPreset({ deviceId: "dev_local", id: preset.id });
  await store.update((draft) => { draft.sessions[0]!.status = "exited"; });
  await service.resumeSession(first.session.id);
  assert.equal(created.at(-1)?.cwd, preset.path);
  assert.equal(created.at(-1)?.name, "Tools");
  assert.equal(service.snapshot().workspaces[0]?.path, root);
  await assert.rejects(service.saveTerminalPreset({ deviceId: "dev_local", id: preset.id, name: "Gone", path: root }), /no longer exists/);
});

test("remote presets resolve and revalidate their directory on the owning device", async () => {
  const { service, created, calls, root } = await setup(true);
  await service.saveTerminalPreset({ deviceId: "remote", name: "Tools", path: "~/tools" });
  await service.saveTerminalPreset({ deviceId: "dev_local", name: "Tools", path: root });
  const preset = service.snapshot().devices.find((item) => item.id === "remote")!.terminalPresets![0]!;
  const result = await service.createSession({ workspaceId: "remote-a", terminalPresetId: preset.id });
  assert.equal(result.session.cwd, "/home/builder/tools");
  assert.deepEqual(calls.filter((call) => call.deviceId === "remote"), [
    { deviceId: "remote", path: "~/tools" }, { deviceId: "remote", path: "/home/builder/tools" }
  ]);
  await assert.rejects(service.saveTerminalPreset({ deviceId: "remote", name: "Missing", path: "/missing" }), /Directory not found/);
  assert.equal(created.length, 1);
  await service.deleteTerminalPreset({ deviceId: "dev_local", id: preset.id });
  assert.equal(service.snapshot().devices.find((item) => item.id === "remote")?.terminalPresets?.length, 1);
});

test("concurrent duplicate saves create one entry and invalidated paths never start a PTY", async () => {
  const { service, created } = await setup();
  const path = await mkdtemp(join(tmpdir(), "superthread-tools-"));
  const saves = await Promise.allSettled([
    service.saveTerminalPreset({ deviceId: "dev_local", name: "Logs", path }),
    service.saveTerminalPreset({ deviceId: "dev_local", name: "logs", path })
  ]);
  assert.equal(saves.filter((result) => result.status === "fulfilled").length, 1);
  const preset = service.snapshot().devices.find((item) => item.id === "dev_local")!.terminalPresets![0]!;
  await rm(path, { recursive: true });
  await assert.rejects(service.createSession({ workspaceId: "local-a", terminalPresetId: preset.id }), /Unable to list directories/);
  assert.equal(created.length, 0);
  assert.equal(service.snapshot().sessions.length, 0);
});
