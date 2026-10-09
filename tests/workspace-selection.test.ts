import assert from "node:assert/strict";
import test from "node:test";
import { workspaceOverview, formatDocumentUpdate, workThreadDocumentUpdate, workThreadsByDocumentUpdate, resolveSelectionId, sortedWorkThreads, visibleWorkspaces, workspaceProjectName } from "../src/renderer/src/features/workspace/selection";
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

test("work threads sort pinned first and keep creation order otherwise", () => {
  const threads = [
    { id: "plain-new", name: "Plain new", status: "active" as const, pinned: false, createdAt: "2026-02-01", updatedAt: "now" },
    { id: "pinned-new", name: "Pinned new", status: "active" as const, pinned: true, createdAt: "2026-03-01", updatedAt: "now" },
    { id: "plain-old", name: "Plain old", status: "active" as const, pinned: false, createdAt: "2026-01-01", updatedAt: "now" },
    { id: "pinned-old", name: "Pinned old", status: "active" as const, pinned: true, createdAt: "2026-01-01", updatedAt: "now" }
  ];

  assert.deepEqual(sortedWorkThreads(threads).map((thread) => thread.id), ["pinned-old", "pinned-new", "plain-old", "plain-new"]);
  assert.deepEqual(threads.map((thread) => thread.id), ["plain-new", "pinned-new", "plain-old", "pinned-old"]);
  const custom = threads.map((thread, index) => ({ ...thread, sidebarOrder: index }));
  assert.deepEqual(sortedWorkThreads(custom).map((thread) => thread.id), ["pinned-new", "pinned-old", "plain-new", "plain-old"]);
  assert.deepEqual(workThreadsByDocumentUpdate(custom).map((thread) => thread.id), workThreadsByDocumentUpdate(threads).map((thread) => thread.id));
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
    { id: "thread-active", name: "Active", status: "active", pinned: false, createdAt: "now", updatedAt: "now" },
    { id: "thread-archived", name: "Archived", status: "archived", pinned: false, createdAt: "now", updatedAt: "now", archivedAt: "now" }
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
    { id: "pinned", name: "Pinned", status: "active" as const, pinned: true, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z", documentUpdatedAt: "2026-10-02T00:00:00Z" },
    { id: "plain", name: "Plain", status: "active" as const, pinned: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", documentUpdatedAt: "2026-10-08T00:00:00Z" },
    { id: "new", name: "Unedited", status: "active" as const, pinned: false, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" },
    { id: "archived", name: "Archived", status: "archived" as const, pinned: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z", documentUpdatedAt: "2026-10-03T00:00:00Z" }
  ];
  assert.deepEqual(workThreadsByDocumentUpdate(threads).map((thread) => thread.id), ["plain", "new", "archived", "pinned"]);
  assert.equal(workThreadDocumentUpdate(threads[2]!), "2026-10-05T00:00:00Z");
  assert.deepEqual(threads.map((thread) => thread.id), ["pinned", "plain", "new", "archived"]);
  threads[0]!.documentUpdatedAt = "2026-10-09T00:00:00Z";
  assert.equal(workThreadsByDocumentUpdate(threads)[0]?.id, "pinned");
});

test("document update labels use zero-padded local MMDD HH:mm in 24-hour time", () => {
  assert.equal(formatDocumentUpdate(new Date(2026, 9, 8, 9, 5).toISOString()), "1008 09:05");
  assert.equal(formatDocumentUpdate(new Date(2026, 0, 2, 0, 7).toISOString()), "0102 00:07");
  assert.equal(formatDocumentUpdate(new Date(2026, 11, 31, 23, 59).toISOString()), "1231 23:59");
  assert.equal(formatDocumentUpdate("invalid"), "—");
});

test("workspace overview counts actively busy sessions by kind and sorts active workspaces without mutating them", () => {
  const snapshot = emptySnapshot();
  snapshot.workThreads = [
    { id: "active", name: "Active", status: "active", pinned: false, createdAt: "now", updatedAt: "now" },
    { id: "archived", name: "Archived", status: "archived", pinned: false, createdAt: "now", updatedAt: "now" }
  ];
  snapshot.workspaces = [workspace("empty", "active", "project"), workspace("one", "active", "project"), workspace("two", "active", "project"), workspace("tie", "active", "project"), workspace("hidden", "archived", "project")];
  snapshot.sessions = [
    { id: "legacy", workspaceId: "one", status: "running" },
    { id: "shell", workspaceId: "two", kind: "shell", status: "running" },
    { id: "codex", workspaceId: "two", kind: "codex", status: "running" },
    { id: "tie", workspaceId: "tie", kind: "codex", status: "running" },
    { id: "hidden", workspaceId: "hidden", kind: "codex", status: "running" },
    { id: "exited", workspaceId: "empty", kind: "shell", status: "exited" },
    { id: "failed", workspaceId: "empty", kind: "codex", status: "restore-failed" },
    { id: "idle-shell", workspaceId: "empty", kind: "shell", status: "running", activityStatus: "idle" },
    { id: "waiting-codex", workspaceId: "empty", kind: "codex", status: "running", activityStatus: "waiting-input" },
    { id: "idle-codex", workspaceId: "empty", kind: "codex", status: "running", activityStatus: "idle" },
    { id: "unknown", workspaceId: "empty", kind: "shell", status: "running", activityStatus: undefined }
  ].map((session) => ({ name: session.id, shell: "/bin/zsh", createdAt: "now", activityStatus: "busy", ...session })) as typeof snapshot.sessions;
  snapshot.browserTabs = [{ id: "browser", workspaceId: "empty", title: "Browser", url: "https://example.com", order: 0, createdAt: "now", updatedAt: "now" }];
  assert.deepEqual(workspaceOverview(snapshot).map(({ workspace, terminals, codex }) => [workspace.id, terminals, codex]), [["two", 1, 1], ["one", 1, 0], ["tie", 0, 1], ["empty", 0, 0]]);
  assert.equal(snapshot.workspaces[0]?.id, "empty");
  snapshot.sessions[2]!.activityStatus = "waiting-input";
  assert.deepEqual(workspaceOverview(snapshot).map((row) => row.workspace.id), ["one", "two", "tie", "empty"]);
});
