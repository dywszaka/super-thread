import { documentLinkSchema, saveWorkThreadDocumentSchema, MAX_WORK_THREAD_DOCUMENT_LENGTH } from "../src/shared/contract";
import assert from "node:assert/strict";
import test from "node:test";
import { addProjectSchema, addRemoteDeviceSchema, browseDirectorySchema, createSessionSchema, createWorkspaceSchema, renameSessionSchema, reorderSessionsSchema, setupProjectSchema, updateProjectSchema, updateRemoteDeviceSchema } from "../src/shared/contract";

test("AddProject import is device-scoped and clone is local-only at the contract boundary", () => {
  assert.equal(addProjectSchema.safeParse({ mode: "import", deviceId: "dev_remote", path: "/srv/demo" }).success, true);
  assert.equal(addProjectSchema.safeParse({ mode: "import", path: "/srv/demo" }).success, false);
  assert.equal(addProjectSchema.safeParse({ mode: "clone", repositoryUrl: "git@example.com:team/demo.git", parentDirectory: "/Users/me/code" }).success, true);
  assert.equal(addProjectSchema.safeParse({ mode: "clone", repositoryUrl: "git@example.com:team/demo.git", parentDirectory: "/Users/me/code", projectName: "demo-gpu" }).success, true);
  assert.equal(addProjectSchema.safeParse({ mode: "clone", repositoryUrl: "git@example.com:team/demo.git", parentDirectory: "/Users/me/code", projectName: "../demo" }).success, false);
  assert.equal(addProjectSchema.safeParse({ mode: "clone", repositoryUrl: "git@example.com:team/demo.git", deviceId: "dev_remote", parentDirectory: "/srv" }).success, false);
});

test("SetupProject requires the path that matches the selected setup mode", () => {
  assert.equal(setupProjectSchema.safeParse({ projectId: "project-1", deviceId: "dev_remote", mode: "import", path: "/srv/demo" }).success, true);
  assert.equal(setupProjectSchema.safeParse({ projectId: "project-1", deviceId: "dev_local", mode: "clone", parentDirectory: "/Users/me/code" }).success, true);
  assert.equal(setupProjectSchema.safeParse({ projectId: "project-1", deviceId: "dev_remote", mode: "import", parentDirectory: "/srv" }).success, false);
  assert.equal(setupProjectSchema.safeParse({ projectId: "project-1", deviceId: "dev_local", mode: "clone", path: "/Users/me/code/demo" }).success, false);
});

test("CreateWorkspace distinguishes a main checkout from an isolated worktree", () => {
  const base = { workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local", name: "demo" };
  assert.equal(createWorkspaceSchema.safeParse({ ...base, kind: "main" }).success, true);
  assert.equal(createWorkspaceSchema.safeParse({ ...base, kind: "main", baseBranch: "main" }).success, false);
  assert.equal(createWorkspaceSchema.safeParse({ ...base, kind: "worktree", baseBranch: "main" }).success, true);
  assert.equal(createWorkspaceSchema.safeParse({ ...base, kind: "worktree" }).success, false);
});

test("UpdateProject accepts safe names and rejects path-like names", () => {
  assert.equal(updateProjectSchema.safeParse({ id: "project-1", name: "Runtime Core" }).success, true);
  assert.equal(updateProjectSchema.safeParse({ id: "project-1", name: "../runtime" }).success, false);
});

test("BrowseDirectory accepts a selected device and optional path", () => {
  assert.deepEqual(browseDirectorySchema.parse({ deviceId: "dev_remote", path: "  /srv  " }), { deviceId: "dev_remote", path: "/srv" });
  assert.equal(browseDirectorySchema.safeParse({ path: "/srv" }).success, false);
});

test("RenameSession requires a bounded non-empty name", () => {
  assert.equal(renameSessionSchema.safeParse({ id: "session-1", name: "logs" }).success, true);
  assert.equal(renameSessionSchema.safeParse({ id: "session-1", name: "" }).success, false);
  assert.equal(renameSessionSchema.safeParse({ id: "session-1", name: "x".repeat(81) }).success, false);
});

test("CreateSession supports managed terminal kinds and reorder validates workspace ownership input", () => {
  assert.equal(createSessionSchema.safeParse({ workspaceId: "workspace-1", kind: "shell" }).success, true);
  assert.equal(createSessionSchema.safeParse({ workspaceId: "workspace-1", kind: "codex" }).success, true);
  assert.equal(createSessionSchema.safeParse({ workspaceId: "workspace-1", kind: "tmux" }).success, false);
  assert.equal(createSessionSchema.safeParse({ workspaceId: "workspace-1", kind: "screen" }).success, false);
  assert.equal(reorderSessionsSchema.safeParse({ workspaceId: "workspace-1", sessionIds: ["session-2", "session-1"] }).success, true);
  assert.equal(reorderSessionsSchema.safeParse({ workspaceId: "workspace-1", sessionIds: [] }).success, false);
});

test("remote device tunnels validate both forwarding directions and reject duplicate bindings", () => {
  const base = { name: "GPU", host: "gpu.example", user: "builder", port: 22 };
  const tunnels = [
    { direction: "local-to-remote", sourcePort: 3000, destinationHost: "127.0.0.1", destinationPort: 3000 },
    { direction: "remote-to-local", sourcePort: 3000, destinationHost: "127.0.0.1", destinationPort: 4000 }
  ];
  assert.equal(addRemoteDeviceSchema.safeParse({ ...base, tunnels }).success, true);
  assert.equal(updateRemoteDeviceSchema.safeParse({ ...base, id: "dev_remote", tunnels }).success, true);
  assert.equal(addRemoteDeviceSchema.safeParse({ ...base, tunnels: [...tunnels, tunnels[0]] }).success, false);
  assert.equal(addRemoteDeviceSchema.safeParse({ ...base, tunnels: [{ ...tunnels[0], sourcePort: 0 }] }).success, false);
});


test("document IPC preserves whitespace and rejects invalid or oversized content", () => {
  const content = "  # Notes\n\n";
  assert.deepEqual(saveWorkThreadDocumentSchema.parse({ id: "thread", content }), { id: "thread", content });
  assert.equal(saveWorkThreadDocumentSchema.safeParse({ id: "thread", content: "" }).success, true);
  for (const input of [{ id: "", content }, { id: "thread", content: null }, { id: "thread", content, path: "/tmp/notes.md" }, { id: "thread", content: "x".repeat(MAX_WORK_THREAD_DOCUMENT_LENGTH + 1) }]) {
    assert.equal(saveWorkThreadDocumentSchema.safeParse(input).success, false);
  }
});


test("document links allow web/email URLs and reject local or executable protocols", () => {
  for (const url of ["https://example.com/docs", "http://localhost:3000", "mailto:hello@example.com"]) {
    assert.equal(documentLinkSchema.safeParse(url).success, true);
  }
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "vscode://file/tmp", "./relative.md"]) {
    assert.equal(documentLinkSchema.safeParse(url).success, false);
  }
});
