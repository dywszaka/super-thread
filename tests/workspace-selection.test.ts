import assert from "node:assert/strict";
import test from "node:test";
import { resolveSelectionId, visibleWorkspaces, workspaceProjectName } from "../src/renderer/src/features/workspace/selection";
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
    { id: "thread-active", name: "Active", status: "active", createdAt: "now", updatedAt: "now" },
    { id: "thread-archived", name: "Archived", status: "archived", createdAt: "now", updatedAt: "now", archivedAt: "now" }
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
