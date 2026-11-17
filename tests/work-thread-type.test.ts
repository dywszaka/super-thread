import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";
import { createWorkThreadSchema, setWorkThreadTypeSchema, workThreadCreationSchema } from "../src/shared/contract";
import { emptySnapshot, type WorkThread } from "../src/shared/domain";
import { threadsOfType, workThreadType } from "../src/shared/work-thread-type";
import { useWorkbenchStore } from "../src/renderer/src/state/workbench-store";

const thread = (id: string, type?: WorkThread["type"]): WorkThread => ({
  id, name: id, ...(type === undefined ? {} : { type }), status: "active", pinned: false,
  document: "Keep document", todos: [], createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z"
});

test("missing, null and empty types read as Work without modifying legacy threads", () => {
  const threads = [thread("missing"), thread("empty", ""), thread("null", null), thread("work", "work"), { ...thread("life", "life"), status: "archived" as const }];
  const before = structuredClone(threads);
  assert.deepEqual(threadsOfType(threads, "work").map(({ id }) => id), ["missing", "empty", "null", "work"]);
  assert.deepEqual(threadsOfType(threads, "life").map(({ id }) => id), ["life"]);
  assert.deepEqual(threads, before);
});

test("current snapshots load without rewriting or backfilling thread types", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-types-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const snapshot = emptySnapshot();
  snapshot.workThreads = [thread("missing"), thread("empty", ""), thread("null", null), thread("life", "life")];
  const original = JSON.stringify(snapshot);
  await writeFile(path, original);
  const loaded = await new JsonStore(path).load();
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.workThreads)), snapshot.workThreads);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal("type" in loaded.workThreads[0]!, false);
});

test("creation and type-change contracts allow only fixed Work and Life values", () => {
  assert.deepEqual(createWorkThreadSchema.parse({ name: "Legacy" }), { name: "Legacy" });
  for (const type of ["work", "life"]) {
    assert.equal(createWorkThreadSchema.safeParse({ name: "New", type }).success, true);
    assert.equal(setWorkThreadTypeSchema.safeParse({ id: "thread", type }).success, true);
    assert.equal(workThreadCreationSchema.safeParse({ operationId: "op", name: "New", type, workspaces: [{ entryId: "one", configuration: { projectId: "p", deviceId: "d", kind: "main", name: "one" } }] }).success, true);
  }
  for (const type of ["", null, "custom", 1]) {
    assert.equal(createWorkThreadSchema.safeParse({ name: "New", type }).success, false);
    assert.equal(setWorkThreadTypeSchema.safeParse({ id: "thread", type }).success, false);
  }
});

test("types persist through edits, archival, restoration and reload without altering thread content", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-types-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const service = new WorkspaceService(new JsonStore(path));
  await service.initialize();
  t.after(() => service.shutdown());
  const legacy = await service.createWorkThread({ name: "Legacy", content: "Keep" });
  const life = await service.createWorkThread({ name: "Family", type: "life", content: "Original" });
  assert.equal("type" in service.snapshot().workThreads[0]!, false);
  assert.equal(workThreadType(service.snapshot().workThreads[0]!), "work");
  await service.setWorkThreadType({ id: legacy, type: "work" });
  assert.equal("type" in service.snapshot().workThreads[0]!, false);
  await Promise.all([
    service.setWorkThreadType({ id: legacy, type: "life" }),
    service.saveWorkThreadDocument({ id: legacy, content: "Autosaved" })
  ]);
  const saved = service.snapshot().workThreads[0]!;
  await service.archiveWorkThread(life);
  await service.setWorkThreadType({ id: life, type: "work" });
  await service.restoreWorkThread(life);
  await service.renameWorkThread({ id: life, name: "Personal" });
  const loaded = await new JsonStore(path).load();
  assert.equal(loaded.workThreads[0]!.type, "life");
  assert.equal(loaded.workThreads[0]!.document, "Autosaved");
  assert.deepEqual(loaded.workThreads[0], saved);
  assert.equal(loaded.workThreads[1]!.type, "work");
  assert.equal(loaded.workThreads[1]!.document, "Original");
  assert.equal(loaded.workThreads[1]!.status, "active");
  const before = service.snapshot();
  await assert.rejects(() => service.setWorkThreadType({ id: life, type: "custom" as "work" }));
  await assert.rejects(() => service.reorderWorkThreads({ id: legacy, targetId: life, placement: "before" }), /same type/);
  assert.deepEqual(service.snapshot(), before);
});

test("switching types clears hidden document navigation and preserves terminal state and drafts", () => {
  const initial = useWorkbenchStore.getInitialState();
  useWorkbenchStore.setState(initial, true);
  assert.equal(useWorkbenchStore.getState().workThreadType, "work");
  const draft = { operationId: "draft", name: "Life draft", type: "life" as const, workspaces: [], step: 0 as const };
  const store = useWorkbenchStore.getState();
  store.setWorkThreadDraft(draft);
  store.setWorkThreadFilter("work-thread", "workspace");
  store.setActiveSession("workspace", "terminal");
  store.switchWorkThreadType("life");
  const switched = useWorkbenchStore.getState();
  assert.deepEqual(switched.scope, { type: "all-work-threads" });
  assert.equal(switched.activeWorkspaceId, null);
  assert.equal(switched.activeSessionIds.workspace, "terminal");
  assert.deepEqual(switched.workThreadDraft, draft);
  assert.deepEqual(switched.expandedThreadIds, ["work-thread"]);
  const persisted = useWorkbenchStore.persist.getOptions().partialize!(switched) as Record<string, unknown>;
  assert.equal(persisted.workThreadType, "life");
  store.showAllTodos();
  store.switchWorkThreadType("work");
  assert.deepEqual(useWorkbenchStore.getState().scope, { type: "all-todos" });
  store.setWorkThreadFilter("life-thread", "life-workspace");
  store.revealWorkThreadType("life");
  assert.equal(useWorkbenchStore.getState().activeWorkspaceId, "life-workspace");
  assert.deepEqual(useWorkbenchStore.getState().scope, { type: "work-thread", id: "life-thread" });
  useWorkbenchStore.setState(initial, true);
});
