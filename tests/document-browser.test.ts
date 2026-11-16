import assert from "node:assert/strict";
import test from "node:test";
import { emptySnapshot, type Workspace } from "../src/shared/domain";
import { documentBrowserWorkspaces } from "../src/renderer/src/features/workspace/document-browser";

function fixture() {
  const snapshot = emptySnapshot();
  snapshot.workThreads.push({ id: "thread", name: "Doc", status: "active", pinned: false, createdAt: "then", updatedAt: "then" });
  const workspace: Workspace = { id: "one", workThreadId: "thread", name: "One", projectId: "project", deviceId: "dev_local", checkoutId: "checkout", kind: "main", path: "/tmp", branch: "", baseBranch: "", status: "ready", createdAt: "then", updatedAt: "then" };
  return { snapshot, workspace };
}

test("Doc browser candidates distinguish no workspace, one workspace and multiple workspaces", () => {
  const { snapshot, workspace } = fixture();
  assert.deepEqual(documentBrowserWorkspaces(snapshot, "thread"), []);
  snapshot.workspaces.push(workspace);
  assert.deepEqual(documentBrowserWorkspaces(snapshot, "thread").map((item) => item.id), ["one"]);
  snapshot.workspaces.push({ ...workspace, id: "two", deviceId: "remote" });
  assert.deepEqual(documentBrowserWorkspaces(snapshot, "thread").map((item) => item.id), ["one", "two"]);
});

test("Doc browser candidates exclude other threads, standalone and unready workspaces", () => {
  const { snapshot, workspace } = fixture();
  snapshot.workThreads.push({ ...snapshot.workThreads[0]!, id: "other" });
  snapshot.workspaces.push(
    workspace,
    { ...workspace, id: "creating", status: "creating" },
    { ...workspace, id: "failed", status: "error" },
    { ...workspace, id: "other", workThreadId: "other" },
    { ...workspace, id: "standalone", workThreadId: undefined }
  );
  assert.deepEqual(documentBrowserWorkspaces(snapshot, "thread").map((item) => item.id), ["one"]);
  snapshot.workspaces = snapshot.workspaces.filter((item) => item.id !== "one");
  assert.deepEqual(documentBrowserWorkspaces(snapshot, "thread"), []);
});

test("archived or deleted threads have no Doc browser candidates until restored", () => {
  const { snapshot, workspace } = fixture();
  snapshot.workspaces.push(workspace);
  snapshot.workThreads[0]!.status = "archived";
  assert.deepEqual(documentBrowserWorkspaces(snapshot, "thread"), []);
  snapshot.workThreads[0]!.status = "active";
  assert.deepEqual(documentBrowserWorkspaces(snapshot, "thread").map((item) => item.id), ["one"]);
  snapshot.workThreads = [];
  assert.deepEqual(documentBrowserWorkspaces(snapshot, "thread"), []);
});
