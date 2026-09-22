import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService, type WorkspaceGitRuntime } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";
import { TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import type { Session } from "../src/shared/domain";

async function setup(gitRuntime?: WorkspaceGitRuntime, terminals?: TerminalRuntime): Promise<{ service: WorkspaceService; store: JsonStore }> {
  const directory = await mkdtemp(join(tmpdir(), "superthread-work-thread-"));
  const store = new JsonStore(join(directory, "state.json"));
  const service = new WorkspaceService(store, terminals, gitRuntime ? () => gitRuntime : undefined);
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
    inspectWorkspaceDeleteRisk: async () => ({ hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0 }),
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

test("failed workspace creation removes the pending workspace record", async () => {
  const fakeGit: WorkspaceGitRuntime = {
    inspect: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    clone: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    createWorktree: async () => { throw new Error("worktree creation failed"); },
    inspectWorkspaceDeleteRisk: async () => ({ hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0 }),
    deleteWorktree: async () => {}
  };
  const { service, store } = await setup(fakeGit);
  await service.createWorkThread({ name: "Failed creation" });
  const threadId = service.snapshot().workThreads[0]?.id;
  assert.ok(threadId);
  await store.update((draft) => {
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_local", path: "/tmp/demo", createdAt: "now" });
  });

  await assert.rejects(
    () => service.createWorkspace({ workThreadId: threadId, projectId: "project-1", deviceId: "dev_local", name: "broken", baseBranch: "main" }),
    /worktree creation failed/
  );

  assert.deepEqual(service.snapshot().workspaces, []);
  assert.deepEqual(service.snapshot().sessions, []);
});

test("deleting a legacy failed workspace only removes its metadata", async () => {
  let gitCalled = false;
  const fakeGit: WorkspaceGitRuntime = {
    inspect: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    clone: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    createWorktree: async () => ({ path: "", branch: "" }),
    inspectWorkspaceDeleteRisk: async () => { gitCalled = true; throw new Error("Git should not be called"); },
    deleteWorktree: async () => { gitCalled = true; }
  };
  const { service, store } = await setup(fakeGit);
  await service.createWorkThread({ name: "Legacy failure" });
  const threadId = service.snapshot().workThreads[0]?.id;
  assert.ok(threadId);
  await store.update((draft) => {
    draft.workspaces.push({
      id: "workspace-error", name: "broken", workThreadId: threadId, projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "", branch: "work/broken", baseBranch: "main", status: "error",
      error: "Permission denied (publickey)", createdAt: "now", updatedAt: "now"
    });
  });

  await service.deleteWorkspace("workspace-error");

  assert.equal(gitCalled, false);
  assert.deepEqual(service.snapshot().workspaces, []);
});

test("deleting a workspace blocks dirty or unmerged work until force is confirmed", async () => {
  const deleted: Array<{ branch: string; force: boolean }> = [];
  const fakeGit: WorkspaceGitRuntime = {
    inspect: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    clone: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    createWorktree: async () => ({ path: "", branch: "" }),
    inspectWorkspaceDeleteRisk: async () => ({ hasUncommittedChanges: true, hasUntrackedFiles: true, unmergedCommitCount: 2 }),
    deleteWorktree: async (_checkout, _path, branch, force) => { deleted.push({ branch, force }); }
  };
  const { service, store } = await setup(fakeGit);
  await service.createWorkThread({ name: "Risky delete" });
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
    draft.sessions.push({ id: "session-1", workspaceId: "workspace-1", name: "Terminal 1", status: "running", shell: "/bin/zsh", pid: 123, createdAt: "now" });
  });

  await assert.rejects(() => service.deleteWorkspace("workspace-1"), /uncommitted changes.*untracked files.*2 commits/);
  assert.equal(service.snapshot().workspaces.length, 1);
  await service.deleteWorkspace("workspace-1", true);

  assert.deepEqual(deleted, [{ branch: "work/demo", force: true }]);
  assert.equal(service.snapshot().workspaces.length, 0);
  assert.equal(service.snapshot().sessions.length, 0);
});

test("terminal close removes the persisted session and rename persists", async () => {
  const { service, store } = await setup();
  await store.update((draft) => {
    draft.sessions.push({ id: "session-1", workspaceId: "workspace-1", name: "Terminal 1", status: "running", shell: "/bin/zsh", pid: 123, createdAt: "now" });
    draft.sessions.push({ id: "session-2", workspaceId: "workspace-1", name: "Terminal 2", status: "running", shell: "/bin/zsh", pid: 456, createdAt: "now" });
    draft.sessions.push({ id: "session-3", workspaceId: "workspace-1", name: "Exited", status: "exited", shell: "/bin/zsh", exitedAt: "now", createdAt: "now" });
  });

  await service.renameSession({ id: "session-2", name: "logs" });
  await service.killSession("session-1");
  await service.killSession("session-3");

  assert.deepEqual(service.snapshot().sessions.map((item) => [item.id, item.name]), [["session-2", "logs"]]);
});

test("resuming an exited session restarts it in place", async () => {
  const created: Session[] = [];
  const terminals = new EventEmitter() as TerminalRuntime;
  Object.assign(terminals, {
    has: () => false,
    create: (session: Session) => { created.push(session); return 987; },
    attach: () => {}, write: () => {}, resize: () => {}, kill: () => {}
  });
  const { service, store } = await setup(undefined, terminals);
  await store.update((draft) => {
    draft.workThreads.push({ id: "thread-1", name: "Runtime", status: "active", createdAt: "now", updatedAt: "now" });
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_local", path: "/tmp/demo", createdAt: "now" });
    draft.workspaces.push({
      id: "workspace-1", name: "demo", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "/tmp/demo-worktree", branch: "work/demo", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
    draft.sessions.push({ id: "session-1", workspaceId: "workspace-1", name: "logs", status: "exited", shell: "/bin/zsh", exitedAt: "then", createdAt: "now" });
  });

  await service.resumeSession("session-1");

  assert.equal(created.length, 1);
  assert.equal(created[0]?.id, "session-1");
  assert.equal(created[0]?.name, "logs");
  assert.deepEqual(service.snapshot().sessions[0], {
    id: "session-1", workspaceId: "workspace-1", name: "logs", status: "running", shell: "/bin/zsh", pid: 987, createdAt: "now"
  });
  await assert.rejects(() => service.resumeSession("session-1"), /Only an exited terminal session/);
});
