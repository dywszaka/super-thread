import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService, type WorkspaceGitRuntime } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";
import type { CommandRunner } from "../src/main/runtime/command-runner";
import { TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import { CURRENT_SCHEMA_VERSION, emptySnapshot, type Session } from "../src/shared/domain";

async function setup(gitRuntime?: WorkspaceGitRuntime, terminals?: TerminalRuntime, commandRunner?: CommandRunner): Promise<{ service: WorkspaceService; store: JsonStore }> {
  const directory = await mkdtemp(join(tmpdir(), "superthread-work-thread-"));
  const store = new JsonStore(join(directory, "state.json"));
  const service = new WorkspaceService(store, terminals, gitRuntime ? () => gitRuntime : undefined, undefined, undefined, commandRunner ? () => commandRunner : undefined);
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
  snapshot.workThreads.push({ id: ids.threadId, name: "Runtime", status: "active", createdAt: "now", updatedAt: "now" });
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

test("managed terminal creation records kind metadata and falls back when a tool is missing", async () => {
  const created: Session[] = [];
  const probes: Array<{ program: string; args: string[] }> = [];
  const commandRunner: CommandRunner = {
    run: async (program, args) => {
      probes.push({ program, args });
      if (args.join(" ").includes("codex")) throw new Error("missing codex");
      return { stdout: "/usr/bin/tmux", stderr: "", exitCode: 0 };
    }
  };
  const { service, store } = await setup(undefined, fakeTerminals(created), commandRunner);
  await store.update((draft) => addReadyWorkspace(draft));

  const codex = await service.createSession({ workspaceId: "workspace-dev_local", kind: "codex" });
  const tmux = await service.createSession({ workspaceId: "workspace-dev_local", kind: "tmux" });
  const secondTmux = await service.createSession({ workspaceId: "workspace-dev_local", kind: "tmux" });

  assert.match(codex.warning ?? "", /Codex CLI.*normal terminal/);
  assert.equal(codex.session.kind, "shell");
  assert.equal(tmux.session.kind, "tmux");
  assert.equal(tmux.session.tmuxSessionName, "superthread-workspace-dev_local");
  assert.equal(secondTmux.session.tmuxSessionName, tmux.session.tmuxSessionName);
  assert.notEqual(secondTmux.session.tmuxWindowName, tmux.session.tmuxWindowName);
  assert.deepEqual(created.map((session) => session.kind), ["shell", "tmux", "tmux"]);
  assert.deepEqual(probes.map((probe) => probe.program), ["sh", "sh", "sh"]);
  assert.equal(probes.every((probe) => probe.args[1]?.includes('"${SHELL:-/bin/sh}" -lic')), true);
});

test("concurrent duplicate terminal creation requests share one result", async () => {
  const created: Session[] = [];
  let releaseProbe!: () => void;
  let probeCount = 0;
  const commandRunner: CommandRunner = {
    run: async () => {
      probeCount += 1;
      await new Promise<void>((resolve) => { releaseProbe = resolve; });
      return { stdout: "/usr/bin/tmux", stderr: "", exitCode: 0 };
    }
  };
  const { service, store } = await setup(undefined, fakeTerminals(created), commandRunner);
  await store.update((draft) => addReadyWorkspace(draft));

  const first = service.createSession({ workspaceId: "workspace-dev_local", kind: "tmux" });
  const duplicate = service.createSession({ workspaceId: "workspace-dev_local", kind: "tmux" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeCount, 1);
  releaseProbe();

  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(firstResult.session.id, duplicateResult.session.id);
  assert.equal(created.length, 1);
  assert.equal(service.snapshot().sessions.length, 1);
});

test("remote tmux fallback warning is shown once per workspace", async () => {
  const commandRunner: CommandRunner = { run: async () => { throw new Error("missing tmux"); } };
  const { service, store } = await setup(undefined, fakeTerminals(), commandRunner);
  await store.update((draft) => {
    draft.devices.push({ id: "dev_remote", name: "GPU host", type: "remote", status: "online", createdAt: "now" });
    draft.connections.push({ deviceId: "dev_remote", transport: "ssh", config: { host: "gpu.example", user: "builder" } });
    draft.workThreads.push({ id: "thread-1", name: "Runtime", status: "active", createdAt: "now", updatedAt: "now" });
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_remote", path: "/srv/demo", createdAt: "now" });
    draft.workspaces.push({
      id: "workspace-1", name: "demo", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_remote",
      checkoutId: "checkout-1", path: "/srv/demo-worktree", branch: "work/demo", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
  });

  const first = await service.createSession({ workspaceId: "workspace-1", kind: "tmux" });
  const second = await service.createSession({ workspaceId: "workspace-1", kind: "tmux" });

  assert.match(first.warning ?? "", /tmux.*normal terminal/);
  assert.equal(second.warning, undefined);
  assert.deepEqual(service.snapshot().sessions.map((session) => session.kind), ["shell", "shell"]);
});

test("terminal order persists when sessions are reordered", async () => {
  const { service, store } = await setup();
  await store.update((draft) => {
    draft.workThreads.push({ id: "thread-1", name: "Runtime", status: "active", createdAt: "now", updatedAt: "now" });
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
    { id: "session-fail", workspaceId: "workspace-dev_local", name: "bad", status: "running", kind: "tmux", shell: "tmux", pid: 222, createdAt: "now" }
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
  const resumed = service.snapshot().sessions[0];
  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.pid, 901);
  assert.equal(resumed?.cwd, "/tmp/demo-worktree");
  assert.equal(resumed?.name, "logs");
  await assert.rejects(() => service.resumeSession("session-1"), /Only an exited or failed terminal session/);
});
