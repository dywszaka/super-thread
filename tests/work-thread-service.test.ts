import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nextTmuxSessionName, tmuxSessionBaseName, WorkspaceService, type WorkspaceGitRuntime } from "../src/main/application/workspace-service";
import { sortedWorkThreads } from "../src/shared/work-thread-order";
import { JsonStore } from "../src/main/persistence/json-store";
import { ProcessCommandRunner, type CommandRunner } from "../src/main/runtime/command-runner";
import type { ExternalTerminalRuntime } from "../src/main/runtime/iterm-runtime";
import { TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import { CURRENT_SCHEMA_VERSION, emptySnapshot, type Session } from "../src/shared/domain";

async function setup(gitRuntime?: WorkspaceGitRuntime, terminals?: TerminalRuntime, commandRunner?: CommandRunner, externalTerminal?: ExternalTerminalRuntime): Promise<{ service: WorkspaceService; store: JsonStore }> {
  const directory = await mkdtemp(join(tmpdir(), "superthread-work-thread-"));
  const store = new JsonStore(join(directory, "state.json"));
  const service = new WorkspaceService(store, terminals, gitRuntime ? () => gitRuntime : undefined, undefined, undefined, commandRunner ? () => commandRunner : undefined, externalTerminal);
  await service.initialize();
  return { service, store };
}

function fakeTerminals(created: Session[] = [], failIds = new Set<string>()): TerminalRuntime {
  const terminals = new EventEmitter() as TerminalRuntime;
  Object.assign(terminals, {
    has: () => false,
    create: (session: Session) => {
      created.push(session);
      if (failIds.has(session.id)) throw new Error(`cannot restore ${session.name}`);
      return 900 + created.length;
    },
    attach: () => ({ data: "", sequence: 0 }),
    write: () => {},
    resize: () => {},
    kill: () => {}
  });
  return terminals;
}

function workspaceFixture(deviceId = "dev_local"): { threadId: string; projectId: string; checkoutId: string; workspaceId: string } {
  return { threadId: "thread-1", projectId: "project-1", checkoutId: "checkout-1", workspaceId: `workspace-${deviceId}` };
}

function addReadyWorkspace(snapshot: ReturnType<typeof emptySnapshot>, ids = workspaceFixture()): void {
  snapshot.workThreads.push({ id: ids.threadId, name: "Runtime", status: "active", pinned: false, createdAt: "now", updatedAt: "now" });
  snapshot.projects.push({ id: ids.projectId, name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
  snapshot.checkouts.push({ id: ids.checkoutId, projectId: ids.projectId, deviceId: "dev_local", path: "/tmp/demo", createdAt: "now" });
  snapshot.workspaces.push({
    id: ids.workspaceId, name: "demo", workThreadId: ids.threadId, projectId: ids.projectId, deviceId: "dev_local",
    checkoutId: ids.checkoutId, path: "/tmp/demo-worktree", branch: "work/demo", baseBranch: "main",
    status: "ready", createdAt: "now", updatedAt: "now"
  });
}

test("WorkThread names are globally unique ignoring case and whitespace", async () => {
  const { service } = await setup();
  await service.createWorkThread({ name: "  Terminal polish  " });

  assert.equal(service.snapshot().workThreads[0]?.name, "Terminal polish");
  assert.equal(service.snapshot().workThreads[0]?.pinned, false);
  await assert.rejects(() => service.createWorkThread({ name: "terminal POLISH" }), /already exists/);
});

test("renaming a WorkThread preserves its identity, document, and workspaces", async () => {
  const { service, store } = await setup();
  const snapshot = service.snapshot();
  addReadyWorkspace(snapshot);
  snapshot.workThreads[0]!.document = "# Notes";
  await store.update((draft) => { Object.assign(draft, snapshot); });
  await service.createWorkThread({ name: "Other" });

  await service.renameWorkThread({ id: "thread-1", name: "  New runtime  " });
  const renamed = service.snapshot().workThreads.find((thread) => thread.id === "thread-1");
  assert.equal(renamed?.name, "New runtime");
  assert.equal(renamed?.document, "# Notes");
  assert.equal(service.snapshot().workspaces[0]?.workThreadId, "thread-1");
  await assert.rejects(() => service.renameWorkThread({ id: "thread-1", name: "other" }), /already exists/);
  await assert.rejects(() => service.renameWorkThread({ id: "missing", name: "Unused" }), /not found/);
  assert.equal(service.snapshot().workThreads.find((thread) => thread.id === "thread-1")?.name, "New runtime");
});

test("WorkThread can be pinned and unpinned", async () => {
  const { service } = await setup();
  await service.createWorkThread({ name: "Important work" });
  const thread = service.snapshot().workThreads[0];
  assert.equal(thread?.pinned, false);

  await service.setWorkThreadPinned({ id: thread!.id, pinned: true });
  assert.equal(service.snapshot().workThreads[0]?.pinned, true);

  await service.setWorkThreadPinned({ id: thread!.id, pinned: false });
  assert.equal(service.snapshot().workThreads[0]?.pinned, false);
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
  await assert.rejects(() => service.createWorkspace({ workThreadId: threadId, projectId: "project-1", deviceId: "dev_local", name: "new", kind: "worktree", baseBranch: "main" }), /archived/);

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
    listWorkspaceLinkCandidates: async () => [],
    linkWorktreePaths: async () => {},
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

test("renaming a workspace changes only its display name", async () => {
  const { service, store } = await setup();
  await store.update((draft) => {
    addReadyWorkspace(draft);
    const workspace = draft.workspaces.find((item) => item.id === "workspace-dev_local");
    if (workspace) workspace.tmuxSessionName = "demo";
  });

  await service.renameWorkspace({ id: "workspace-dev_local", name: "  nvfp4-kernel  " });

  const workspace = service.snapshot().workspaces[0];
  assert.equal(workspace?.name, "nvfp4-kernel");
  assert.equal(workspace?.path, "/tmp/demo-worktree");
  assert.equal(workspace?.branch, "work/demo");
  assert.equal(workspace?.baseBranch, "main");
  assert.equal(workspace?.tmuxSessionName, "demo");
});

test("renaming a workspace rejects an empty, unknown, or device-duplicate name", async () => {
  const { service, store } = await setup();
  await store.update((draft) => {
    addReadyWorkspace(draft);
    draft.workspaces.push({
      id: "workspace-2", name: "benchmark", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "/tmp/benchmark", branch: "work/benchmark", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
  });

  await assert.rejects(() => service.renameWorkspace({ id: "workspace-dev_local", name: "   " }), /name is required/);
  await assert.rejects(() => service.renameWorkspace({ id: "workspace-missing", name: "other" }), /Workspace not found/);
  await assert.rejects(() => service.renameWorkspace({ id: "workspace-dev_local", name: "benchmark" }), /already exists on/);
  assert.equal(service.snapshot().workspaces.map((workspace) => workspace.name).join(","), "demo,benchmark");
});

test("failed workspace creation removes the pending workspace record", async () => {
  const fakeGit: WorkspaceGitRuntime = {
    inspect: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    clone: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    listWorkspaceLinkCandidates: async () => [],
    linkWorktreePaths: async () => {},
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
    () => service.createWorkspace({ workThreadId: threadId, projectId: "project-1", deviceId: "dev_local", name: "broken", kind: "worktree", baseBranch: "main" }),
    /worktree creation failed/
  );

  assert.deepEqual(service.snapshot().workspaces, []);
  assert.deepEqual(service.snapshot().sessions, []);
});

test("a Project x Device can have one main-checkout workspace", async () => {
  let worktreeCalled = false;
  let deleteCalled = false;
  const created: Session[] = [];
  const fakeGit: WorkspaceGitRuntime = {
    inspect: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    clone: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    listWorkspaceLinkCandidates: async () => [],
    linkWorktreePaths: async () => {},
    createWorktree: async () => { worktreeCalled = true; return { path: "", branch: "" }; },
    inspectWorkspaceDeleteRisk: async () => { throw new Error("Main workspace deletion must not inspect Git risk"); },
    deleteWorktree: async () => { deleteCalled = true; }
  };
  const { service, store } = await setup(fakeGit, fakeTerminals(created));
  await service.createWorkThread({ name: "Main owner" });
  await service.createWorkThread({ name: "Other thread" });
  const [owner, other] = service.snapshot().workThreads;
  await store.update((draft) => {
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_local", path: "/tmp/demo", createdAt: "now" });
  });

  await service.createWorkspace({ workThreadId: owner!.id, projectId: "project-1", deviceId: "dev_local", name: "main-demo", kind: "main" });
  const workspace = service.snapshot().workspaces[0];
  assert.equal(workspace?.path, "/tmp/demo");
  assert.equal(workspace?.kind, "main");
  assert.equal(worktreeCalled, false);
  assert.equal(created[0]?.cwd, "/tmp/demo");

  await assert.rejects(
    () => service.createWorkspace({ workThreadId: other!.id, projectId: "project-1", deviceId: "dev_local", name: "duplicate", kind: "main" }),
    /already used by.*Main owner/
  );

  await service.deleteWorkspace(workspace!.id);
  assert.equal(deleteCalled, false);
  assert.deepEqual(service.snapshot().workspaces, []);
  assert.equal(service.snapshot().checkouts[0]?.path, "/tmp/demo");
});

test("deleting a legacy failed workspace only removes its metadata", async () => {
  let gitCalled = false;
  const fakeGit: WorkspaceGitRuntime = {
    inspect: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    clone: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    listWorkspaceLinkCandidates: async () => [],
    linkWorktreePaths: async () => {},
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

for (const kind of [undefined, "worktree"] as const) {
  for (const force of [false, true]) {
    test(`deleting a base-checkout workspace preserves Git when kind=${kind}, force=${force}`, async () => {
      const killed: string[] = [];
      const terminals = fakeTerminals();
      terminals.kill = (id) => { killed.push(id); };
      const fakeGit: WorkspaceGitRuntime = {
        inspect: async () => { throw new Error("Must not inspect the base checkout"); },
        clone: async () => { throw new Error("Must not clone"); },
        listWorkspaceLinkCandidates: async () => [],
        linkWorktreePaths: async () => {},
        createWorktree: async () => { throw new Error("Must not create a worktree"); },
        inspectWorkspaceDeleteRisk: async () => { throw new Error("Must not inspect deletion risk"); },
        deleteWorktree: async () => { throw new Error("Must not delete the base checkout or its branch"); }
      };
      const { service, store } = await setup(fakeGit, terminals);
      const ids = workspaceFixture();
      await store.update((draft) => {
        addReadyWorkspace(draft, ids);
        Object.assign(draft.workspaces[0]!, { kind, path: "/tmp/demo/./", branch: "main" });
        draft.sessions.push({ id: "main-session", workspaceId: ids.workspaceId, name: "Terminal 1", status: "running", shell: "/bin/zsh", createdAt: "now" });
        draft.sessions.push({ id: "other-session", workspaceId: "other-workspace", name: "Terminal 2", status: "running", shell: "/bin/zsh", createdAt: "now" });
      });
      const checkout = service.snapshot().checkouts[0];
      const project = service.snapshot().projects[0];

      await service.deleteWorkspace(ids.workspaceId, force);

      assert.deepEqual(killed, ["main-session"]);
      assert.deepEqual(service.snapshot().workspaces, []);
      assert.deepEqual(service.snapshot().sessions.map((item) => item.id), ["other-session"]);
      assert.deepEqual(service.snapshot().checkouts, [checkout]);
      assert.deepEqual(service.snapshot().projects, [project]);
    });
  }
}

test("deleting main and legacy base-checkout workspaces preserves a real repository and its files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-main-delete-"));
  const runner = new ProcessCommandRunner();
  await runner.run("git", ["init", "-b", "main", directory]);
  await writeFile(join(directory, "local-work.txt"), "keep my work", "utf8");
  for (const kind of ["main", undefined] as const) {
    for (const force of [false, true]) {
      const { service, store } = await setup(undefined, fakeTerminals());
      const ids = workspaceFixture();
      await store.update((draft) => {
        addReadyWorkspace(draft, ids);
        draft.checkouts[0]!.path = directory;
        Object.assign(draft.workspaces[0]!, { kind, path: directory, branch: "main" });
      });

      await service.deleteWorkspace(ids.workspaceId, force);

      assert.deepEqual(service.snapshot().workspaces, []);
      assert.equal(service.snapshot().checkouts[0]?.path, directory);
      assert.equal(await readFile(join(directory, "local-work.txt"), "utf8"), "keep my work");
      assert.equal((await runner.run("git", ["-C", directory, "branch", "--show-current"])).stdout, "main");
    }
  }
});

test("worktree links are created before its first session", async () => {
  const events: string[] = [];
  const terminals = fakeTerminals();
  terminals.create = () => { events.push("session"); return 123; };
  const runtime: WorkspaceGitRuntime = {
    inspect: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    clone: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    createWorktree: async () => { events.push("worktree"); return { path: "/tmp/linked", branch: "work/linked" }; },
    listWorkspaceLinkCandidates: async (path) => { assert.equal(path, "/tmp/demo"); return [{ path: ".env", kind: "file" }]; },
    linkWorktreePaths: async (source, target, paths) => {
      assert.equal(source, "/tmp/demo"); assert.equal(target, "/tmp/linked"); assert.deepEqual(paths, [".env"]); events.push("links");
    },
    inspectWorkspaceDeleteRisk: async () => ({ hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0 }),
    deleteWorktree: async () => {}
  };
  const { service, store } = await setup(runtime, terminals);
  await store.update((draft) => { addReadyWorkspace(draft); draft.workspaces = []; });
  assert.deepEqual(await service.listWorkspaceLinkCandidates({ projectId: "project-1", deviceId: "dev_local" }), [{ path: ".env", kind: "file" }]);
  await service.createWorkspace({ workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local", name: "linked", kind: "worktree", baseBranch: "main", linkPaths: [".env"] });
  assert.deepEqual(events, ["worktree", "links", "session"]);
  assert.equal(service.snapshot().workspaces[0]?.status, "ready");
});

for (const rollbackFails of [false, true]) {
  test(`failed workspace links roll back creation; rollback failure=${rollbackFails}`, async () => {
    let deleted = false;
    const sessions: Session[] = [];
    const runtime: WorkspaceGitRuntime = {
      inspect: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
      clone: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
      createWorktree: async () => ({ path: "/tmp/linked", branch: "work/linked" }),
      listWorkspaceLinkCandidates: async () => [],
      linkWorktreePaths: async () => { throw new Error("link destination already exists"); },
      inspectWorkspaceDeleteRisk: async () => ({ hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0 }),
      deleteWorktree: async (source, path, branch, force) => {
        assert.equal(source, "/tmp/demo"); assert.equal(path, "/tmp/linked"); assert.equal(branch, "work/linked"); assert.equal(force, true);
        deleted = true; if (rollbackFails) throw new Error("rollback failed");
      }
    };
    const { service, store } = await setup(runtime, fakeTerminals(sessions));
    await store.update((draft) => { addReadyWorkspace(draft); draft.workspaces = []; });
    await assert.rejects(() => service.createWorkspace({ workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local", name: "linked", kind: "worktree", baseBranch: "main", linkPaths: [".env"] }), /link destination/);
    assert.equal(deleted, true);
    assert.deepEqual(sessions, []);
    if (rollbackFails) {
      assert.equal(service.snapshot().workspaces[0]?.status, "error");
      assert.equal(service.snapshot().workspaces[0]?.path, "/tmp/linked");
      assert.match(service.snapshot().workspaces[0]?.error ?? "", /rollback failed/);
    } else assert.deepEqual(service.snapshot().workspaces, []);
  });
}

test("deleting a workspace blocks dirty or unmerged work until force is confirmed", async () => {
  const deleted: Array<{ branch: string; force: boolean }> = [];
  const fakeGit: WorkspaceGitRuntime = {
    inspect: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    clone: async () => ({ root: "", name: "", remote: "", defaultBranch: "main" }),
    listWorkspaceLinkCandidates: async () => [],
    linkWorktreePaths: async () => {},
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

test("terminal close cannot be resurrected by its PTY exit event", async () => {
  const terminals = new EventEmitter() as TerminalRuntime;
  let running = true;
  Object.assign(terminals, {
    has: () => running,
    attach: () => ({ data: "", sequence: 0 }),
    write: () => {},
    resize: () => {},
    kill: (sessionId: string) => {
      running = false;
      terminals.emit("exit", { sessionId, exitCode: 0 });
    }
  });
  const { service, store } = await setup(undefined, terminals);
  await store.update((draft) => {
    draft.sessions.push({ id: "session-1", workspaceId: "workspace-1", name: "Terminal 1", status: "running", shell: "/bin/zsh", pid: 123, createdAt: "now" });
  });

  await service.killSession("session-1");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(service.snapshot().sessions, []);
});

test("running session summaries include only terminals actively doing work", async () => {
  const { service, store } = await setup();
  await store.update((draft) => {
    draft.sessions.push(
      { id: "busy-shell", workspaceId: "workspace-1", name: "build", status: "running", kind: "shell", shell: "/bin/zsh", activityStatus: "busy", createdAt: "now" },
      { id: "idle-shell", workspaceId: "workspace-1", name: "prompt", status: "running", kind: "shell", shell: "/bin/zsh", activityStatus: "idle", createdAt: "now" },
      { id: "waiting-codex", workspaceId: "workspace-1", name: "agent", status: "running", kind: "codex", shell: "codex", activityStatus: "waiting-input", createdAt: "now" }
    );
  });

  assert.deepEqual(service.runningSessionSummaries(), ["Unknown workspace / build (shell)"]);
});

test("Codex completion waits only until the result is viewed", async () => {
  const terminals = fakeTerminals();
  const { service, store } = await setup(undefined, terminals);
  await store.update((draft) => {
    draft.sessions.push({
      id: "codex-1", workspaceId: "workspace-1", name: "agent", status: "running", kind: "codex",
      shell: "codex", activityStatus: "idle", createdAt: "now"
    });
  });
  const emitActivity = async (activityStatus: "idle" | "busy" | "waiting-input", resultReady: boolean): Promise<void> => {
    const changed = new Promise<void>((resolve) => service.once("changed", resolve));
    terminals.emit("activity", { sessionId: "codex-1", activityStatus, resultReady });
    await changed;
  };

  await emitActivity("waiting-input", false);
  assert.equal(service.snapshot().sessions[0]?.activityStatus, "idle");
  assert.equal(Boolean(service.snapshot().sessions[0]?.resultUnread), false);

  await emitActivity("busy", false);
  await emitActivity("waiting-input", true);
  assert.equal(service.snapshot().sessions[0]?.activityStatus, "waiting-input");
  assert.equal(service.snapshot().sessions[0]?.resultUnread, true);

  await service.markSessionViewed("codex-1");
  assert.equal(service.snapshot().sessions[0]?.activityStatus, "idle");
  assert.equal(service.snapshot().sessions[0]?.resultUnread, false);
});

test("shell command completion also waits until the result is viewed", async () => {
  const terminals = fakeTerminals();
  const { service, store } = await setup(undefined, terminals);
  await store.update((draft) => {
    draft.sessions.push({
      id: "shell-1", workspaceId: "workspace-1", name: "build", status: "running", kind: "shell",
      shell: "/bin/zsh", activityStatus: "busy", createdAt: "now"
    });
  });
  const changed = new Promise<void>((resolve) => service.once("changed", resolve));
  terminals.emit("activity", { sessionId: "shell-1", activityStatus: "idle", resultReady: true });
  await changed;

  assert.equal(service.snapshot().sessions[0]?.activityStatus, "waiting-input");
  assert.equal(service.snapshot().sessions[0]?.resultUnread, true);

  await service.markSessionViewed("shell-1");
  assert.equal(service.snapshot().sessions[0]?.activityStatus, "idle");
  assert.equal(service.snapshot().sessions[0]?.resultUnread, false);
});

test("Codex creation falls back to a shell when the managed tool is missing", async () => {
  const created: Session[] = [];
  const probes: Array<{ program: string; args: string[] }> = [];
  const commandRunner: CommandRunner = {
    run: async (program, args) => {
      probes.push({ program, args });
      if (args.join(" ").includes("codex")) throw new Error("missing codex");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
  };
  const { service, store } = await setup(undefined, fakeTerminals(created), commandRunner);
  await store.update((draft) => addReadyWorkspace(draft));

  const codex = await service.createSession({ workspaceId: "workspace-dev_local", kind: "codex" });

  assert.match(codex.warning ?? "", /Codex CLI.*normal terminal/);
  assert.equal(codex.session.kind, "shell");
  assert.deepEqual(created.map((session) => session.kind), ["shell"]);
  assert.deepEqual(probes.map((probe) => probe.program), ["sh"]);
  assert.equal(probes.every((probe) => probe.args[1]?.includes('"${SHELL:-/bin/sh}" -lic')), true);
});

test("Codex conversation ids are persisted from terminal runtime events", async () => {
  const terminals = fakeTerminals();
  const commandRunner: CommandRunner = { run: async () => ({ stdout: "/usr/bin/codex", stderr: "", exitCode: 0 }) };
  const { service, store } = await setup(undefined, terminals, commandRunner);
  await store.update((draft) => addReadyWorkspace(draft));

  const codex = await service.createSession({ workspaceId: "workspace-dev_local", kind: "codex" });
  const changed = new Promise<void>((resolve) => service.once("changed", resolve));
  terminals.emit("codex-conversation", { sessionId: codex.session.id, codexConversationId: "01a0d2b6-f542-7bc0-9a51-4e2c62eecc99" });
  await changed;

  assert.equal(service.snapshot().sessions.find((session) => session.id === codex.session.id)?.codexConversationId, "01a0d2b6-f542-7bc0-9a51-4e2c62eecc99");
});

test("resuming and startup restoration preserve saved Codex conversation ids", async () => {
  const created: Session[] = [];
  const { service, store } = await setup(undefined, fakeTerminals(created));
  await store.update((draft) => {
    draft.workThreads.push({ id: "thread-1", name: "Runtime", status: "active", pinned: false, createdAt: "now", updatedAt: "now" });
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_local", path: "/tmp/demo", createdAt: "now" });
    draft.workspaces.push({
      id: "workspace-1", name: "demo", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "/tmp/demo-worktree", branch: "work/demo", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
    draft.sessions.push({
      id: "codex-1", workspaceId: "workspace-1", name: "agent", status: "restore-failed", kind: "codex", shell: "codex",
      codexConversationId: "01a0d2b6-f542-7bc0-9a51-4e2c62eecc99", exitedAt: "then", createdAt: "now"
    });
  });

  await service.resumeSession("codex-1");

  assert.equal(created[0]?.id, "codex-1");
  assert.equal(created[0]?.kind, "codex");
  assert.equal(created[0]?.codexConversationId, "01a0d2b6-f542-7bc0-9a51-4e2c62eecc99");
  assert.equal(service.snapshot().sessions[0]?.status, "running");
});

test("Codex sessions with saved conversation ids auto-restore after abnormal exit", async () => {
  const created: Session[] = [];
  const terminals = fakeTerminals(created);
  const { service, store } = await setup(undefined, terminals);
  await store.update((draft) => {
    draft.workThreads.push({ id: "thread-1", name: "Runtime", status: "active", pinned: false, createdAt: "now", updatedAt: "now" });
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_local", path: "/tmp/demo", createdAt: "now" });
    draft.workspaces.push({
      id: "workspace-1", name: "demo", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "/tmp/demo-worktree", branch: "work/demo", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
    draft.sessions.push({
      id: "codex-1", workspaceId: "workspace-1", name: "agent", status: "running", kind: "codex", shell: "codex",
      activityStatus: "idle", codexConversationId: "01a0d2b6-f542-7bc0-9a51-4e2c62eecc99", createdAt: "now"
    });
  });
  const restored = new Promise<void>((resolve) => {
    let changes = 0;
    service.on("changed", () => {
      changes += 1;
      if (changes === 2) resolve();
    });
  });

  terminals.emit("exit", { sessionId: "codex-1", exitCode: 1 });
  await restored;

  assert.equal(created[0]?.id, "codex-1");
  assert.equal(created[0]?.codexConversationId, "01a0d2b6-f542-7bc0-9a51-4e2c62eecc99");
  assert.equal(service.snapshot().sessions[0]?.status, "running");
});

test("opening tmux in iTerm reuses one workspace-level tmux session", async () => {
  assert.equal(tmuxSessionBaseName(" release.1:fix "), "release-1-fix");
  assert.equal(nextTmuxSessionName("demo", ["demo", "demo-2", "other"]), "demo-3");
  let listCount = 0;
  const opened: string[] = [];
  const commandRunner: CommandRunner = {
    run: async (_program, args) => {
      if (args.join(" ").includes("list-sessions")) {
        listCount += 1;
        return { stdout: "demo\ndemo-2", stderr: "", exitCode: 0 };
      }
      return { stdout: "/usr/bin/tmux", stderr: "", exitCode: 0 };
    }
  };
  const externalTerminal: ExternalTerminalRuntime = { open: async (command) => { opened.push(command); } };
  const { service, store } = await setup(undefined, fakeTerminals(), commandRunner, externalTerminal);
  await store.update((draft) => addReadyWorkspace(draft));

  await service.openWorkspaceTmuxInIterm("workspace-dev_local");
  await service.openWorkspaceTmuxInIterm("workspace-dev_local");

  assert.equal(service.snapshot().workspaces[0]?.tmuxSessionName, "demo-3");
  assert.equal(service.snapshot().sessions.length, 0);
  assert.equal(listCount, 1);
  assert.equal(opened.length, 2);
  assert.equal(opened.every((command) => command.includes("attach-session") && command.includes("demo-3")), true);
  assert.equal(opened.every((command) => command.includes("/usr/bin/tmux")), true);
});

test("concurrent iTerm opens share one tmux setup", async () => {
  let releaseProbe!: () => void;
  let probeCount = 0;
  const opened: string[] = [];
  const commandRunner: CommandRunner = {
    run: async (_program, args) => {
      probeCount += 1;
      if (probeCount === 1) await new Promise<void>((resolve) => { releaseProbe = resolve; });
      return { stdout: args.join(" ").includes("list-sessions") ? "" : "/usr/bin/tmux", stderr: "", exitCode: 0 };
    }
  };
  const externalTerminal: ExternalTerminalRuntime = { open: async (command) => { opened.push(command); } };
  const { service, store } = await setup(undefined, fakeTerminals(), commandRunner, externalTerminal);
  await store.update((draft) => addReadyWorkspace(draft));

  const first = service.openWorkspaceTmuxInIterm("workspace-dev_local");
  const duplicate = service.openWorkspaceTmuxInIterm("workspace-dev_local");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeCount, 1);
  releaseProbe();

  await Promise.all([first, duplicate]);
  assert.equal(probeCount, 3);
  assert.equal(opened.length, 1);
  assert.equal(service.snapshot().workspaces[0]?.tmuxSessionName, "demo");
});

test("a remote session that exits during startup remains retryable in place", async () => {
  const created: Session[] = [];
  let failImmediately = true;
  const terminals = new EventEmitter() as TerminalRuntime;
  Object.assign(terminals, {
    has: () => false,
    create: (session: Session) => {
      created.push({ ...session });
      if (failImmediately) terminals.emit("exit", { sessionId: session.id, exitCode: 255 });
      return 900 + created.length;
    },
    attach: () => ({ data: "", sequence: 0 }),
    write: () => {},
    resize: () => {},
    kill: () => {}
  });
  const commandRunner: CommandRunner = {
    run: async (_program, args) => ({ stdout: args.join(" ").includes("list-sessions") ? "" : "/usr/bin/tmux", stderr: "", exitCode: 0 })
  };
  const { service, store } = await setup(undefined, terminals, commandRunner);
  await store.update((draft) => {
    draft.devices.push({ id: "dev_remote", name: "GPU host", type: "remote", status: "online", createdAt: "now" });
    draft.connections.push({ deviceId: "dev_remote", transport: "ssh", config: { host: "gpu.example", user: "builder" } });
    draft.workThreads.push({ id: "thread-1", name: "Runtime", status: "active", pinned: false, createdAt: "now", updatedAt: "now" });
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_remote", path: "/srv/demo", createdAt: "now" });
    draft.workspaces.push({
      id: "workspace-1", name: "demo", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_remote",
      checkoutId: "checkout-1", path: "/srv/demo-worktree", branch: "work/demo", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
  });

  const result = await service.createSession({ workspaceId: "workspace-1", kind: "shell" });
  const failed = service.snapshot().sessions.find((session) => session.id === result.session.id);

  assert.equal(failed?.status, "exited");
  assert.equal(failed?.exitCode, 255);

  failImmediately = false;
  await service.resumeSession(result.session.id);

  const resumed = service.snapshot().sessions.find((session) => session.id === result.session.id);
  assert.equal(resumed?.status, "running");
  assert.deepEqual(created.map((session) => session.id), [result.session.id, result.session.id]);
});

test("opening workspace tmux reports when tmux is missing", async () => {
  const commandRunner: CommandRunner = { run: async () => { throw new Error("missing tmux"); } };
  const { service, store } = await setup(undefined, fakeTerminals(), commandRunner);
  await store.update((draft) => {
    draft.devices.push({ id: "dev_remote", name: "GPU host", type: "remote", status: "online", createdAt: "now" });
    draft.connections.push({ deviceId: "dev_remote", transport: "ssh", config: { host: "gpu.example", user: "builder" } });
    draft.workThreads.push({ id: "thread-1", name: "Runtime", status: "active", pinned: false, createdAt: "now", updatedAt: "now" });
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_remote", path: "/srv/demo", createdAt: "now" });
    draft.workspaces.push({
      id: "workspace-1", name: "demo", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_remote",
      checkoutId: "checkout-1", path: "/srv/demo-worktree", branch: "work/demo", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
  });

  await assert.rejects(() => service.openWorkspaceTmuxInIterm("workspace-1"), /tmux is not available on GPU host/);
  assert.equal(service.snapshot().sessions.length, 0);
  assert.equal(service.snapshot().workspaces[0]?.tmuxSessionName, undefined);
});

test("terminal order persists when sessions are reordered", async () => {
  const { service, store } = await setup();
  await store.update((draft) => {
    draft.workThreads.push({ id: "thread-1", name: "Runtime", status: "active", pinned: false, createdAt: "now", updatedAt: "now" });
    draft.workspaces.push({
      id: "workspace-1", name: "demo", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "/tmp/demo-worktree", branch: "work/demo", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
    draft.sessions.push(
      { id: "session-1", workspaceId: "workspace-1", name: "one", status: "running", shell: "/bin/zsh", order: 0, createdAt: "now" },
      { id: "session-2", workspaceId: "workspace-1", name: "two", status: "running", shell: "/bin/zsh", order: 1, createdAt: "now" }
    );
  });

  await service.reorderSessions({ workspaceId: "workspace-1", sessionIds: ["session-2", "session-1"] });

  assert.deepEqual(
    service.snapshot().sessions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((session) => session.id),
    ["session-2", "session-1"]
  );
});

test("startup restores interrupted sessions and isolates restore failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-restore-"));
  const path = join(directory, "state.json");
  const snapshot = emptySnapshot();
  snapshot.devices.push({ id: "dev_local", name: "Local", type: "local", status: "online", createdAt: "now" });
  snapshot.connections.push({ deviceId: "dev_local", transport: "local", config: {} });
  addReadyWorkspace(snapshot);
  snapshot.sessions.push(
    { id: "session-ok", workspaceId: "workspace-dev_local", name: "ok", status: "running", kind: "shell", shell: "/bin/zsh", pid: 111, cwd: "/tmp/demo-worktree/subdir", createdAt: "now" },
    { id: "session-fail", workspaceId: "workspace-dev_local", name: "bad", status: "running", kind: "codex", shell: "codex", pid: 222, createdAt: "now" }
  );
  snapshot.schemaVersion = CURRENT_SCHEMA_VERSION;
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const created: Session[] = [];
  const service = new WorkspaceService(new JsonStore(path), fakeTerminals(created, new Set(["session-fail"])));

  await service.initialize();

  const restored = service.snapshot().sessions;
  assert.equal(restored.find((session) => session.id === "session-ok")?.pid, 901);
  assert.equal(restored.find((session) => session.id === "session-ok")?.cwd, "/tmp/demo-worktree/subdir");
  assert.equal(restored.find((session) => session.id === "session-fail")?.status, "restore-failed");
  assert.match(restored.find((session) => session.id === "session-fail")?.restoreError ?? "", /cannot restore/);
});

test("resuming an exited session restarts it in place", async () => {
  const created: Session[] = [];
  const { service, store } = await setup(undefined, fakeTerminals(created));
  await store.update((draft) => {
    draft.workThreads.push({ id: "thread-1", name: "Runtime", status: "active", pinned: false, createdAt: "now", updatedAt: "now" });
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
  const resumed = service.snapshot().sessions[0];
  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.pid, 901);
  assert.equal(resumed?.cwd, "/tmp/demo-worktree");
  assert.equal(resumed?.name, "logs");
  await assert.rejects(() => service.resumeSession("session-1"), /Only an exited or failed terminal session/);
});

test("work thread Markdown is isolated, persists across restart and survives archive/restore", async () => {
  const { service, store } = await setup();
  await service.createWorkThread({ name: "Document A" });
  await service.createWorkThread({ name: "Document B" });
  const [a, b] = service.snapshot().workThreads;
  assert.equal(a?.document, "");
  const content = "# 中文标题\n\n- [ ] TODO\n\n```ts\nconst x = 1;\n```\n  ";
  await service.saveWorkThreadDocument({ id: a!.id, content });
  await service.archiveWorkThread(a!.id);
  await service.restoreWorkThread(a!.id);
  const restarted = new WorkspaceService(store);
  await restarted.initialize();
  assert.equal(restarted.snapshot().workThreads.find((thread) => thread.id === a!.id)?.document, content);
  assert.equal(restarted.snapshot().workThreads.find((thread) => thread.id === b!.id)?.document, "");
  assert.ok(service.snapshot().workThreads[0]?.documentUpdatedAt);
  await service.saveWorkThreadDocument({ id: a!.id, content: "" });
  assert.equal(service.snapshot().workThreads[0]?.document, "");
  await service.deleteWorkThread(a!.id);
  await assert.rejects(service.saveWorkThreadDocument({ id: a!.id, content: "stale" }), /Work thread not found/);
});


test("sidebar reordering persists without changing document order or workspace ownership", async () => {
  const { service, store } = await setup();
  const snapshot = service.snapshot();
  addReadyWorkspace(snapshot);
  snapshot.workThreads.push(
    { id: "thread-2", name: "Second", status: "active", pinned: false, createdAt: "z2", updatedAt: "later", document: "# Second", documentUpdatedAt: "latest" },
    { id: "thread-3", name: "Third", status: "active", pinned: false, createdAt: "z3", updatedAt: "last" },
    { id: "pinned", name: "Pinned", status: "active", pinned: true, createdAt: "first", updatedAt: "first" }
  );
  await store.update((draft) => { Object.assign(draft, snapshot); });
  const original = service.snapshot();
  await service.reorderWorkThreads({ id: "thread-3", targetId: "thread-1", placement: "before" });
  const order = () => sortedWorkThreads(service.snapshot().workThreads).map((thread) => thread.id);
  assert.deepEqual(order(), ["pinned", "thread-3", "thread-1", "thread-2"]);
  await service.reorderWorkThreads({ id: "thread-3", targetId: "thread-2", placement: "after" });
  assert.deepEqual(order(), ["pinned", "thread-1", "thread-2", "thread-3"]);
  for (const thread of service.snapshot().workThreads) {
    const { sidebarOrder, ...rest } = thread;
    assert.deepEqual(rest, original.workThreads.find((item) => item.id === thread.id));
  }
  assert.deepEqual(service.snapshot().workspaces, original.workspaces);
  await service.archiveWorkThread("thread-2");
  await service.restoreWorkThread("thread-2");
  assert.deepEqual(order(), ["pinned", "thread-1", "thread-2", "thread-3"]);
  // Reload the same store from disk as an application restart would.
  await store.load();
  assert.deepEqual(order(), ["pinned", "thread-1", "thread-2", "thread-3"]);
  await service.createWorkThread({ name: "New" });
  assert.equal(sortedWorkThreads(service.snapshot().workThreads).at(-1)?.name, "New");
});

test("sidebar reordering rejects missing, archived, and cross-pin targets without changing data", async () => {
  const { service, store } = await setup();
  await store.update((draft) => {
    draft.workThreads = [
      { id: "a", name: "A", status: "active", pinned: false, createdAt: "1", updatedAt: "1" },
      { id: "b", name: "B", status: "active", pinned: true, createdAt: "2", updatedAt: "2" },
      { id: "c", name: "C", status: "archived", pinned: false, createdAt: "3", updatedAt: "3" }
    ];
  });
  const before = service.snapshot();
  for (const targetId of ["missing", "b", "c"]) {
    await assert.rejects(service.reorderWorkThreads({ id: "a", targetId, placement: "before" }));
    assert.deepEqual(service.snapshot(), before);
  }
  await assert.rejects(service.reorderWorkThreads({ id: "c", targetId: "a", placement: "before" }), /Only active/);
  await service.reorderWorkThreads({ id: "a", targetId: "a", placement: "after" });
  assert.deepEqual(service.snapshot(), before);
});
