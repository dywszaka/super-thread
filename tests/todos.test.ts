import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";
import { createTodoSchema, updateTodoSchema } from "../src/shared/contract";
import { emptySnapshot, type Todo, type WorkThread } from "../src/shared/domain";
import { localTodoDate, todoEntries, visibleThreadTodos } from "../src/shared/todos";
import { visibleWorkspaces } from "../src/renderer/src/features/workspace/selection";
import { useWorkbenchStore } from "../src/renderer/src/state/workbench-store";

test("TODO IPC rejects empty titles, invalid dates and unexpected fields", () => {
  const input = { workThreadId: "thread", title: " Plan ", date: "2026-10-10" };
  assert.equal(createTodoSchema.parse(input).title, "Plan");
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-1"]) assert.equal(createTodoSchema.safeParse({ ...input, date }).success, false);
  assert.equal(createTodoSchema.safeParse({ ...input, date: "2028-02-29" }).success, true);
  for (const title of ["   ", "x".repeat(501)]) assert.equal(createTodoSchema.safeParse({ ...input, title }).success, false);
  assert.equal(createTodoSchema.safeParse({ ...input, completedAt: "spoofed" }).success, false);
  assert.equal(updateTodoSchema.safeParse({ workThreadId: "thread", id: "todo" }).success, false);
  assert.equal(updateTodoSchema.safeParse({ workThreadId: "thread", id: "todo", completed: "true" }).success, false);
});

test("thread retention uses completion time with an inclusive seven-day boundary", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const base: Todo = { id: "pending", title: "Old pending", date: "2020-01-01", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" };
  const todos = [base, { ...base, id: "boundary", completedAt: "2026-10-03T12:00:00Z" }, { ...base, id: "expired", completedAt: "2026-10-03T11:59:59.999Z" }, { ...base, id: "recent", completedAt: "2026-10-10T11:00:00Z" }];
  assert.deepEqual(visibleThreadTodos(todos, now).map((todo) => todo.id), ["pending", "boundary", "recent"]);
  const thread: WorkThread = { id: "archived", name: "History", status: "archived", pinned: false, todos, createdAt: base.createdAt, updatedAt: base.updatedAt };
  assert.equal(todoEntries([thread]).length, 4);
  assert.equal(todoEntries([thread], true, now).length, 3);
  assert.equal(visibleThreadTodos(todos, now + 1).some((todo) => todo.id === "boundary"), false);
  assert.equal(localTodoDate(new Date(2026, 9, 10, 0, 1)), "2026-10-10");
});

test("TODO persistence survives concurrent document saves, archive, reload and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-todos-"));
  const path = join(directory, "state.json");
  const store = new JsonStore(path);
  await store.load();
  const service = new WorkspaceService(store);
  await service.createWorkThread({ name: "Daily" });
  const threadId = service.snapshot().workThreads[0]!.id;
  await Promise.all([
    service.createTodo({ workThreadId: threadId, title: " First ", date: "2026-10-10" }),
    service.saveWorkThreadDocument({ id: threadId, content: "# Keep my draft" }),
    service.createTodo({ workThreadId: threadId, title: "Second", date: "2026-10-11" })
  ]);
  const thread = service.snapshot().workThreads[0]!;
  assert.equal(thread.todos?.length, 2);
  assert.equal(thread.document, "# Keep my draft");
  const todoId = thread.todos![0]!.id;
  const target = { workThreadId: threadId, id: todoId };
  await service.updateTodo({ ...target, completed: true });
  const completedAt = service.snapshot().workThreads[0]!.todos![0]!.completedAt;
  assert.ok(completedAt);
  await service.updateTodo({ ...target, title: "Updated", date: "2026-10-09", completed: true });
  assert.equal(service.snapshot().workThreads[0]!.todos![0]!.completedAt, completedAt);
  assert.equal(service.snapshot().workThreads[0]!.documentUpdatedAt, thread.documentUpdatedAt);
  await service.archiveWorkThread(threadId);
  const reloadedStore = new JsonStore(path);
  const persisted = await reloadedStore.load();
  assert.equal(todoEntries(persisted.workThreads).length, 2);
  assert.equal(persisted.workThreads[0]!.status, "archived");
  const reloadedService = new WorkspaceService(reloadedStore);
  await reloadedService.updateTodo({ ...target, completed: false });
  assert.equal(reloadedService.snapshot().workThreads[0]!.todos![0]!.completedAt, undefined);
  await reloadedService.restoreWorkThread(threadId);
  await reloadedService.deleteTodo(target);
  await assert.rejects(reloadedService.updateTodo({ ...target, completed: true }), /not found/);
  await assert.rejects(reloadedService.createTodo({ workThreadId: "missing", title: "Orphan", date: "2026-10-10" }), /not found/);
  await reloadedService.deleteWorkThread(threadId);
  assert.deepEqual(todoEntries((await new JsonStore(path).load()).workThreads), []);
});

test("schema 11 migrates without losing documents; All todos clears workspace selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-todo-migration-"));
  const path = join(directory, "state.json");
  const snapshot = emptySnapshot();
  snapshot.schemaVersion = 11;
  snapshot.workThreads.push({ id: "legacy", name: "Legacy", status: "active", pinned: true, document: "# Existing", createdAt: "then", updatedAt: "then" });
  await writeFile(path, JSON.stringify(snapshot));
  const migrated = await new JsonStore(path).load();
  assert.equal(migrated.schemaVersion, 12);
  assert.equal(migrated.workThreads[0]!.document, "# Existing");
  assert.deepEqual(migrated.workThreads[0]!.todos, []);
  useWorkbenchStore.getState().setActiveWorkspace("workspace");
  useWorkbenchStore.getState().showAllTodos();
  assert.deepEqual(useWorkbenchStore.getState().scope, { type: "all-todos" });
  assert.equal(useWorkbenchStore.getState().activeWorkspaceId, null);
  assert.deepEqual(visibleWorkspaces(migrated, { type: "all-todos" }), []);
});
