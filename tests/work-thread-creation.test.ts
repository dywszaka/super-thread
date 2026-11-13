import assert from "node:assert/strict";
import test from "node:test";
import { WorkThreadCreationCoordinator } from "../src/main/application/work-thread-creation";
import { emptySnapshot, type CreateWorkspaceInput } from "../src/shared/domain";
import { workThreadCreationSchema } from "../src/shared/contract";
import type { WorkThreadCreation, WorkThreadCreationInput } from "../src/shared/work-thread-creation";

function fixture() {
  const snapshot = emptySnapshot();
  snapshot.projects.push({ id: "project", name: "Demo", code: "demo", createdAt: "now", updatedAt: "now" });
  snapshot.devices.push({ id: "local", name: "Mac", type: "local", status: "online", createdAt: "now" }, { id: "remote", name: "SSH", type: "remote", status: "unknown", createdAt: "now" });
  snapshot.checkouts.push(...["local", "remote"].map((deviceId) => ({ id: `checkout-${deviceId}`, projectId: "project", deviceId, path: "/repo", isGit: true, defaultBranch: "main", createdAt: "now" })));
  const input: WorkThreadCreationInput = { operationId: "operation", name: "Feature", content: "## Goal\nOriginal", workspaces: ["one", "two", "three"].map((name) => ({ entryId: name, configuration: { name, projectId: "project", deviceId: "local", kind: "worktree", baseBranch: "main", linkPaths: [] } })) };
  const calls: string[] = [];
  const changes: Array<WorkThreadCreation | null> = [];
  const failures = new Set<string>();
  const leftovers = new Set<string>();
  let threadFailure = false;
  let hold: Promise<void> | undefined;
  const services = {
    snapshot: () => structuredClone(snapshot),
    createWorkThread: async (value: { name: string; content?: string }, threadId: string) => {
      if (threadFailure) throw new Error("disk full");
      snapshot.workThreads.push({ id: threadId, name: value.name, document: value.content, status: "active", pinned: false, createdAt: "now", updatedAt: "now" });
      return threadId;
    },
    createWorkspace: async (value: CreateWorkspaceInput, workspaceId: string) => {
      calls.push(value.name);
      await hold;
      if (!failures.has(value.name) || leftovers.has(value.name)) snapshot.workspaces.push({ ...value, id: workspaceId, checkoutId: `checkout-${value.deviceId}`, path: `/work/${value.name}`, branch: `work/${value.name}`, baseBranch: "main", status: leftovers.has(value.name) ? "error" : "ready", error: leftovers.has(value.name) ? "rollback failed" : undefined, createdAt: "now", updatedAt: "now" });
      if (failures.has(value.name)) throw new Error("SSH disconnected");
      snapshot.sessions.push({ id: `session-${workspaceId}`, workspaceId, name: "Terminal 1", kind: "shell", status: "running", order: 0, shell: "zsh", createdAt: "now" });
      return workspaceId;
    }
  };
  const coordinator = new WorkThreadCreationCoordinator(services, (state) => changes.push(state));
  const finish = async () => {
    for (let index = 0; index < 30 && coordinator.current()?.status === "running"; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.notEqual(coordinator.current()?.status, "running");
    return coordinator.current()!;
  };
  return { snapshot, input, calls, changes, failures, leftovers, coordinator, finish, failThread: () => { threadFailure = true; }, allowThread: () => { threadFailure = false; }, hold: (value: Promise<void>) => { hold = value; } };
}

test("creation contract requires workspaces and rejects ownership overrides, duplicate IDs, invalid types and links", () => {
  const { input } = fixture();
  assert.equal(workThreadCreationSchema.safeParse(input).success, true);
  assert.equal(workThreadCreationSchema.safeParse({ ...input, workspaces: [] }).success, false);
  assert.equal(workThreadCreationSchema.safeParse({ ...input, workspaces: [input.workspaces[0], input.workspaces[0]] }).success, false);
  for (const patch of [{ workThreadId: "foreign" }, { name: "../escape" }, { linkPaths: ["../escape"] }, { kind: "main", baseBranch: "main" }]) {
    assert.equal(workThreadCreationSchema.safeParse({ ...input, workspaces: [{ entryId: "one", configuration: { ...input.workspaces[0]!.configuration, ...patch } }] }).success, false);
  }
});

test("creates all workspaces and default sessions across devices; repeated submissions never duplicate", async () => {
  const f = fixture();
  f.input.workspaces[1]!.configuration.deviceId = "remote";
  f.input.workspaces[2]!.configuration = { name: "three", kind: "main", projectId: "project", deviceId: "local" };
  f.coordinator.submit(f.input);
  f.coordinator.submit(f.input);
  const result = await f.finish();
  assert.equal(result.status, "completed");
  assert.equal(f.snapshot.workThreads.length, 1);
  assert.equal(f.snapshot.workspaces.length, 3);
  assert.equal(f.snapshot.sessions.length, 3);
  assert.ok(f.snapshot.workspaces.every((workspace) => workspace.workThreadId === result.threadId));
  f.coordinator.submit(f.input);
  assert.deepEqual(f.calls, ["one", "two", "three"]);
  assert.ok(f.changes.some((state) => state?.entries[1]?.status === "creating"));
});

test("preflight rejects batch names, main ownership and unavailable checkout without creating a thread", () => {
  for (const kind of ["duplicate", "main", "checkout", "non-git", "existing-name", "thread-name"] as const) {
    const f = fixture();
    if (kind === "duplicate") f.input.workspaces[1]!.configuration.name = "one";
    if (kind === "main") f.input.workspaces = f.input.workspaces.map((item) => ({ entryId: item.entryId, configuration: { projectId: "project", deviceId: "local", name: item.entryId, kind: "main" } }));
    if (kind === "checkout") f.snapshot.checkouts = [];
    if (kind === "non-git") f.snapshot.checkouts[0]!.isGit = false;
    if (kind === "existing-name") f.snapshot.workspaces.push({ id: "old", name: "one", kind: "main", projectId: "project", deviceId: "local", checkoutId: "checkout-local", path: "/repo", branch: "main", baseBranch: "main", status: "ready", createdAt: "now", updatedAt: "now" });
    if (kind === "thread-name") f.snapshot.workThreads.push({ id: "old", name: "FEATURE", status: "archived", pinned: false, createdAt: "now", updatedAt: "now" });
    assert.throws(() => f.coordinator.submit(f.input));
    assert.equal(f.coordinator.current(), null);
    assert.equal(f.calls.length, 0);
  }
});

test("midway failure pauses and retries only corrected or waiting items, preserving saved Doc", async () => {
  const f = fixture();
  f.failures.add("two");
  f.coordinator.submit(f.input);
  const paused = await f.finish();
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.entries.map((entry) => entry.status), ["succeeded", "failed", "pending"]);
  f.snapshot.workThreads[0]!.document = "Edited independently";
  f.input.workspaces[1]!.configuration.name = "corrected";
  f.coordinator.submit({ ...f.input, content: "must not replace Doc" });
  assert.equal((await f.finish()).status, "completed");
  assert.deepEqual(f.calls, ["one", "two", "corrected", "three"]);
  assert.equal(f.snapshot.workThreads.length, 1);
  assert.equal(f.snapshot.workThreads[0]!.document, "Edited independently");
});

test("first-item and thread-save failures can retry without duplicate thread records", async () => {
  const f = fixture();
  f.failThread(); f.coordinator.submit(f.input);
  assert.equal((await f.finish()).threadId, undefined);
  f.allowThread(); f.failures.add("one"); f.coordinator.submit(f.input);
  assert.deepEqual((await f.finish()).entries.map((entry) => entry.status), ["failed", "pending", "pending"]);
  f.failures.clear(); f.coordinator.submit(f.input);
  assert.equal((await f.finish()).status, "completed");
  assert.equal(f.snapshot.workThreads.length, 1);
});

test("leftover cleanup blocks retries even when the failed item is removed; deleting leftover unblocks", async () => {
  const f = fixture();
  f.failures.add("two"); f.leftovers.add("two"); f.coordinator.submit(f.input);
  const state = await f.finish();
  assert.match(state.entries[1]!.error!, /rollback failed/);
  assert.throws(() => f.coordinator.submit(f.input), /leftover/);
  assert.throws(() => f.coordinator.submit({ ...f.input, workspaces: [f.input.workspaces[0]!] }), /leftover/);
  f.snapshot.workspaces = f.snapshot.workspaces.filter((workspace) => workspace.id !== state.entries[1]!.workspaceId);
  f.failures.clear(); f.leftovers.clear(); f.coordinator.submit(f.input);
  assert.equal((await f.finish()).status, "completed");
});

test("successful entries are immutable, and concurrent operations/discard are rejected", async () => {
  const f = fixture();
  let release!: () => void;
  f.hold(new Promise<void>((resolve) => { release = resolve; }));
  f.failures.add("two"); f.coordinator.submit(f.input);
  assert.throws(() => f.coordinator.submit({ ...f.input, operationId: "another" }), /current creation/);
  assert.throws(() => f.coordinator.discard(f.input.operationId), /Wait/);
  assert.equal(f.coordinator.isCreatingThread(f.coordinator.current()!.threadId!), true);
  release(); await f.finish();
  f.input.workspaces[0]!.configuration.name = "changed";
  assert.throws(() => f.coordinator.submit(f.input), /Successfully created/);
  f.coordinator.discard(f.input.operationId);
  assert.equal(f.coordinator.current(), null);
  assert.equal(f.snapshot.workspaces.length, 1);
  assert.equal(f.snapshot.workThreads.length, 1);
});

test("ordinary folders accept main workspaces and existing main ownership is rejected", async () => {
  const f = fixture();
  f.snapshot.checkouts[0]!.isGit = false;
  f.input.workspaces = [{ entryId: "main", configuration: { name: "directory", projectId: "project", deviceId: "local", kind: "main" } }];
  f.coordinator.submit(f.input); await f.finish(); f.coordinator.discard(f.input.operationId);
  assert.throws(() => f.coordinator.submit({ ...f.input, operationId: "next", name: "Another", workspaces: [{ entryId: "another", configuration: { ...f.input.workspaces[0]!.configuration, name: "other" } }] }), /already used/);
});
