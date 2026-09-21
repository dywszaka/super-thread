import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService, type WorkspaceGitRuntime } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";

async function setup(gitRuntime?: WorkspaceGitRuntime): Promise<{ service: WorkspaceService; store: JsonStore }> {
  const directory = await mkdtemp(join(tmpdir(), "superthread-work-thread-"));
  const store = new JsonStore(join(directory, "state.json"));
  const service = new WorkspaceService(store, undefined, gitRuntime ? () => gitRuntime : undefined);
  await service.initialize();
  return { service, store };
}

test("WorkThread names are globally unique ignoring case and whitespace", async () => {
  const { service } = await setup();
  await service.createWorkThread({ name: "  Terminal polish  " });

  assert.equal(service.snapshot().workThreads[0]?.name, "Terminal polish");
  await assert.rejects(() => service.createWorkThread({ name: "terminal POLISH" }), /already exists/);
});

test("archiving and restoring a WorkThread preserves its workspaces and sessions", async () => {
  const { service, store } = await setup();
  await service.createWorkThread({ name: "Runtime work" });
  const threadId = service.snapshot().workThreads[0]?.id;
  assert.ok(threadId);
  await store.update((draft) => {
    draft.workspaces.push({
      id: "workspace-1", name: "runtime", workThreadId: threadId, projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "/tmp/runtime", branch: "work/runtime", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
    draft.sessions.push({ id: "session-1", workspaceId: "workspace-1", name: "Terminal 1", status: "running", shell: "/bin/zsh", pid: 123, createdAt: "now" });
  });

  await service.archiveWorkThread(threadId);
  const archived = service.snapshot();
  assert.equal(archived.workThreads[0]?.status, "archived");
  assert.equal(archived.workspaces[0]?.id, "workspace-1");
  assert.equal(archived.sessions[0]?.id, "session-1");
  assert.equal(archived.sessions[0]?.status, "running");
  await assert.rejects(() => service.createWorkspace({ workThreadId: threadId, projectId: "project-1", deviceId: "dev_local", name: "new", baseBranch: "main" }), /archived/);

  await service.restoreWorkThread(threadId);
  assert.equal(service.snapshot().workThreads[0]?.status, "active");
  assert.equal(service.snapshot().workThreads[0]?.archivedAt, undefined);
});

test("a WorkThread must be empty before it can be deleted", async () => {
  const { service, store } = await setup();
  await service.createWorkThread({ name: "Delete guard" });
  const threadId = service.snapshot().workThreads[0]?.id;
  assert.ok(threadId);
  await store.update((draft) => {
    draft.workspaces.push({
      id: "workspace-1", name: "guarded", workThreadId: threadId, projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "/tmp/guarded", branch: "work/guarded", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
  });

  await assert.rejects(() => service.deleteWorkThread(threadId), /Remove every workspace/);
  await store.update((draft) => { draft.workspaces = []; });
  await service.deleteWorkThread(threadId);
  assert.deepEqual(service.snapshot().workThreads, []);
});

test("deleting the final workspace leaves its WorkThread intact", async () => {
  let deleted = false;
  const fakeGit: WorkspaceGitRuntime = {
    inspect: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    clone: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    createWorktree: async () => ({ path: "", branch: "" }),
    hasChanges: async () => false,
    deleteWorktree: async () => { deleted = true; }
  };
  const { service, store } = await setup(fakeGit);
  await service.createWorkThread({ name: "Keep me" });
  const threadId = service.snapshot().workThreads[0]?.id;
  assert.ok(threadId);
  await store.update((draft) => {
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_local", path: "/tmp/demo", createdAt: "now" });
    draft.workspaces.push({
      id: "workspace-1", name: "demo", workThreadId: threadId, projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "/tmp/demo-worktree", branch: "work/demo", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
  });

  await service.deleteWorkspace("workspace-1");

  assert.equal(deleted, true);
  assert.equal(service.snapshot().workspaces.length, 0);
  assert.equal(service.snapshot().workThreads[0]?.id, threadId);
});
