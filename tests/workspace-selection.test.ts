import assert from "node:assert/strict";
import test from "node:test";
import { formatDocumentUpdate, workThreadDocumentUpdate, workThreadsByDocumentUpdate, resolveSelectionId, sortedWorkThreads, visibleWorkspaces, workspaceProjectName } from "../src/renderer/src/features/workspace/selection";
import { emptySnapshot, type Workspace } from "../src/shared/domain";

test("workspace selection adopts the first project added after the dialog mounts", () => {
  assert.equal(resolveSelectionId("", null, []), "");
  assert.equal(resolveSelectionId("", null, [{ id: "project-1" }]), "project-1");
});

test("workspace selection preserves valid choices and replaces stale ones", () => {
  const items = [{ id: "project-1" }, { id: "project-2" }];
  assert.equal(resolveSelectionId("project-2", "project-1", items), "project-2");
  assert.equal(resolveSelectionId("missing", "project-1", items), "project-1");
  assert.equal(resolveSelectionId("missing", "also-missing", items), "project-1");
});

test("work threads sort by priority and keep creation order within a priority", () => {
  const threads = [
    { id: "normal-new", name: "Normal new", status: "active" as const, priority: "normal" as const, createdAt: "2026-02-01", updatedAt: "now" },
    { id: "low", name: "Low", status: "active" as const, priority: "low" as const, createdAt: "2026-01-01", updatedAt: "now" },
    { id: "high", name: "High", status: "active" as const, priority: "high" as const, createdAt: "2026-03-01", updatedAt: "now" },
    { id: "normal-old", name: "Normal old", status: "active" as const, priority: "normal" as const, createdAt: "2026-01-01", updatedAt: "now" }
  ];

  assert.deepEqual(sortedWorkThreads(threads).map((thread) => thread.id), ["high", "normal-old", "normal-new", "low"]);
  assert.deepEqual(threads.map((thread) => thread.id), ["normal-new", "low", "high", "normal-old"]);
});

const workspace = (id: string, workThreadId: string, projectId: string): Workspace => ({
  id,
  name: id,
  workThreadId,
  projectId,
  deviceId: "device-1",
  checkoutId: "checkout-1",
  path: `/tmp/${id}`,
  branch: `work/${id}`,
  baseBranch: "main",
  status: "ready",
  createdAt: "now",
  updatedAt: "now"
});

test("workspace scopes exclude workspaces in archived work threads", () => {
  const snapshot = emptySnapshot();
  snapshot.workThreads.push(
    { id: "thread-active", name: "Active", status: "active", priority: "normal", createdAt: "now", updatedAt: "now" },
    { id: "thread-archived", name: "Archived", status: "archived", priority: "normal", createdAt: "now", updatedAt: "now", archivedAt: "now" }
  );
  snapshot.workspaces.push(
    workspace("workspace-a", "thread-active", "project-a"),
    workspace("workspace-b", "thread-active", "project-b"),
    workspace("workspace-hidden", "thread-archived", "project-a")
  );

  assert.deepEqual(visibleWorkspaces(snapshot, { type: "all-workspaces" }).map((item) => item.id), ["workspace-a", "workspace-b"]);
  assert.deepEqual(visibleWorkspaces(snapshot, { type: "project", id: "project-a" }).map((item) => item.id), ["workspace-a"]);
  assert.deepEqual(visibleWorkspaces(snapshot, { type: "work-thread", id: "thread-active" }).map((item) => item.id), ["workspace-a", "workspace-b"]);
  assert.deepEqual(visibleWorkspaces(snapshot, { type: "work-thread", id: "thread-archived" }), []);
  assert.deepEqual(visibleWorkspaces(snapshot, { type: "all-work-threads" }), []);
  assert.deepEqual(visibleWorkspaces(snapshot, { type: "all-devices" }), []);
});

test("workspace sidebar labels include the owning project name", () => {
  const snapshot = emptySnapshot();
  snapshot.projects.push({ id: "project-a", name: "Runtime", repositoryUrl: "git@example.com:runtime.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
  const item = workspace("workspace-a", "thread-active", "project-a");

  assert.equal(workspaceProjectName(snapshot, item), "Runtime");
  assert.equal(workspaceProjectName(snapshot, workspace("workspace-b", "thread-active", "missing")), "Unknown project");
});

test("all work threads sort by document update, falling back to creation rather than metadata updates", () => {
  const threads = [
    { id: "high", name: "High", status: "active" as const, priority: "high" as const, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z", documentUpdatedAt: "2026-10-02T00:00:00Z" },
    { id: "low", name: "Low", status: "active" as const, priority: "low" as const, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", documentUpdatedAt: "2026-10-08T00:00:00Z" },
    { id: "new", name: "Unedited", status: "active" as const, priority: "normal" as const, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" },
    { id: "archived", name: "Archived", status: "archived" as const, priority: "normal" as const, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z", documentUpdatedAt: "2026-10-03T00:00:00Z" }
  ];
  assert.deepEqual(workThreadsByDocumentUpdate(threads).map((thread) => thread.id), ["low", "new", "archived", "high"]);
  assert.equal(workThreadDocumentUpdate(threads[2]!), "2026-10-05T00:00:00Z");
  assert.deepEqual(threads.map((thread) => thread.id), ["high", "low", "new", "archived"]);
  threads[0]!.documentUpdatedAt = "2026-10-09T00:00:00Z";
  assert.equal(workThreadsByDocumentUpdate(threads)[0]?.id, "high");
});

test("document update labels use zero-padded local MMDD HH:mm in 24-hour time", () => {
  assert.equal(formatDocumentUpdate(new Date(2026, 9, 8, 9, 5).toISOString()), "1008 09:05");
  assert.equal(formatDocumentUpdate(new Date(2026, 0, 2, 0, 7).toISOString()), "0102 00:07");
  assert.equal(formatDocumentUpdate(new Date(2026, 11, 31, 23, 59).toISOString()), "1231 23:59");
  assert.equal(formatDocumentUpdate("invalid"), "—");
});
