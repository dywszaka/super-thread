import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService, type WorkspaceGitRuntime, type WorkspaceDeleteRisk } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";
import { TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import { finishWorkThreadSchema } from "../src/shared/contract";

async function fixture() {
  const statePath = join(await mkdtemp(join(tmpdir(), "superthread-finish-")), "state.json");
  const store = new JsonStore(statePath);
  const killed: string[] = [];
  const terminals = Object.assign(new EventEmitter(), { has: () => false, kill: (id: string) => killed.push(id) }) as unknown as TerminalRuntime;
  const risks = new Map<string, WorkspaceDeleteRisk>();
  const failedChecks = new Set<string>();
  const failedDeletes = new Set<string>();
  const calls: Array<{ path: string; force: boolean; deviceId: string }> = [];
  let inspectionGate: Promise<void> | undefined;
  let inspected = 0;
  let afterInspection: (() => void) | undefined;
  const runtime = (deviceId: string): WorkspaceGitRuntime => ({
    inspect: async () => ({ root: "/repo", name: "Repo" }), clone: async () => ({ root: "/repo", name: "Repo" }),
    createWorktree: async () => { throw new Error("unexpected creation"); },
    linkWorktreePaths: async () => {}, listWorkspaceLinkCandidates: async () => [],
    inspectWorkspaceDeleteRisk: async (_checkout, path) => {
      inspected += 1; await inspectionGate;
      if (failedChecks.has(path)) throw new Error("SSH unavailable");
      const risk = risks.get(path) ?? { hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0 };
      afterInspection?.();
      return risk;
    },
    deleteWorktree: async (_checkout, path, _branch, force) => {
      if (failedDeletes.has(path)) throw new Error("deletion failed");
      calls.push({ path, force, deviceId });
    }
  });
  const service = new WorkspaceService(store, terminals, (device) => runtime(device.id));
  await service.initialize();
  const threadId = await service.createWorkThread({ name: "Finish me", content: "Keep my Doc" });
  await store.update((draft) => {
    draft.workThreads[0]!.todos = [{ id: "todo", title: "Keep TODO", date: "2026-11-13", createdAt: "now", updatedAt: "now" }];
    draft.projects.push({ id: "project", name: "Repo", code: "repo", createdAt: "now", updatedAt: "now" });
    draft.devices.push({ id: "remote", name: "SSH", type: "remote", status: "unknown", createdAt: "now" });
    draft.connections.push({ deviceId: "remote", transport: "ssh", config: { host: "example.invalid" } });
    for (const deviceId of ["dev_local", "remote"]) draft.checkouts.push({ id: `checkout-${deviceId}`, projectId: "project", deviceId, path: "/repo", isGit: true, defaultBranch: "main", createdAt: "now" });
    for (const name of ["one", "two", "main"]) {
      const deviceId = name === "two" ? "remote" : "dev_local";
      draft.workspaces.push({ id: name, name, workThreadId: threadId, projectId: "project", deviceId, checkoutId: `checkout-${deviceId}`, kind: name === "main" ? "main" : "worktree", path: name === "main" ? "/repo" : `/work/${name}`, branch: `work/${name}`, baseBranch: "main", status: "ready", createdAt: "now", updatedAt: "now" });
      draft.sessions.push({ id: `session-${name}`, workspaceId: name, name: "Terminal", kind: "shell", order: 0, shell: "sh", status: "running", createdAt: "now" });
      draft.browserTabs.push({ id: `browser-${name}`, workspaceId: name, url: "https://example.com", title: "Browser", order: 1, createdAt: "now", updatedAt: "now" });
      draft.filePreviewTabs.push({ id: `preview-${name}`, workspaceId: name, path: "README.md", fileType: "markdown", order: 2, createdAt: "now", updatedAt: "now" });
    }
  });
  const input = () => ({ id: threadId, workspaceIds: service.snapshot().workspaces.filter((item) => item.workThreadId === threadId).map((item) => item.id), forceWorkspaceIds: [] as string[] });
  return { service, store, statePath, terminals, threadId, risks, failedChecks, failedDeletes, killed, calls, input,
    hold: (gate: Promise<void>) => { inspectionGate = gate; },
    inspected: () => inspected,
    afterInspection: (callback: () => void) => { afterInspection = callback; }
  };
}

test("finish IPC requires exact, unique workspace IDs and explicit per-workspace force approvals", () => {
  const valid = { id: "thread", workspaceIds: ["one"], forceWorkspaceIds: [] };
  assert.equal(finishWorkThreadSchema.safeParse(valid).success, true);
  assert.equal(finishWorkThreadSchema.safeParse({ ...valid, forceWorkspaceIds: ["one"] }).success, true);
  for (const patch of [{ force: true }, { forceWorkspaceIds: ["foreign"] }, { workspaceIds: ["one", "one"] }, { forceWorkspaceIds: ["one", "one"] }, { id: "" }]) assert.equal(finishWorkThreadSchema.safeParse({ ...valid, ...patch }).success, false);
});

test("finish previews checks without mutation, deletes all owned workspaces and archives while preserving Doc/TODO", async () => {
  const f = await fixture();
  const before = f.service.snapshot();
  const preview = await f.service.inspectWorkThreadFinish(f.threadId);
  assert.deepEqual(f.service.snapshot(), before);
  assert.equal(preview.workspaces.length, 3);
  assert.equal(preview.workspaces.find((item) => item.workspaceId === "main")?.keepsDirectory, true);
  assert.equal(preview.workspaces[0]!.runningSessionCount, 1);
  await f.service.finishWorkThread(f.input());
  const after = f.service.snapshot();
  assert.equal(after.workThreads[0]!.status, "archived");
  assert.equal(after.workThreads[0]!.document, "Keep my Doc");
  assert.deepEqual(after.workThreads[0]!.projectIds, ["project"]);
  assert.deepEqual(after.workThreads[0]!.todos, before.workThreads[0]!.todos);
  assert.ok(after.workThreads[0]!.archivedAt);
  assert.equal(after.workspaces.length + after.sessions.length + after.browserTabs.length + after.filePreviewTabs.length, 0);
  assert.deepEqual(f.calls, [{ path: "/work/one", force: false, deviceId: "dev_local" }, { path: "/work/two", force: false, deviceId: "remote" }]);
  assert.deepEqual(f.killed, ["session-one", "session-two", "session-main"]);
  await f.service.restoreWorkThread(f.threadId);
  assert.equal(f.service.snapshot().workspaces.length, 0);
  assert.equal(f.service.snapshot().workThreads[0]!.status, "active");
  assert.deepEqual((await new JsonStore(f.statePath).load()).workThreads[0]!.projectIds, ["project"]);
  await f.service.deleteProject("project");
  assert.deepEqual(f.service.snapshot().workThreads[0]!.projectIds, []);
});

test("dirty, untracked and unmerged changes block the entire group until that workspace is explicitly approved", async () => {
  const f = await fixture();
  f.risks.set("/work/two", { hasUncommittedChanges: true, hasUntrackedFiles: true, unmergedCommitCount: 2 });
  const preview = await f.service.inspectWorkThreadFinish(f.threadId);
  assert.deepEqual(preview.workspaces[1]!.risks, ["uncommitted changes", "untracked files", "2 commits not merged into the base branch"]);
  await assert.rejects(() => f.service.finishWorkThread(f.input()), /Workspace delete blocked/);
  assert.equal(f.calls.length + f.killed.length, 0);
  await assert.rejects(() => f.service.finishWorkThread({ ...f.input(), forceWorkspaceIds: ["one"] }), /Workspace delete blocked/);
  await f.service.finishWorkThread({ ...f.input(), forceWorkspaceIds: ["two"] });
  assert.equal(f.calls[0]!.force, false);
  assert.equal(f.calls[1]!.force, true);
});

test("failed checks cannot be bypassed with force and do not delete any workspace", async () => {
  const f = await fixture(); f.failedChecks.add("/work/two");
  assert.match((await f.service.inspectWorkThreadFinish(f.threadId)).workspaces[1]!.error!, /SSH unavailable/);
  await assert.rejects(() => f.service.finishWorkThread({ ...f.input(), forceWorkspaceIds: ["two"] }), /SSH unavailable/);
  assert.equal(f.calls.length + f.killed.length, 0);
  assert.equal(f.service.snapshot().workThreads[0]!.status, "active");
});

for (const submodule of [
  { path: "deps/child", hasUncommittedChanges: true, hasUntrackedFiles: true, unmergedCommitCount: 2 },
  { path: "deps/clean", hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0 },
  { path: "deps/unknown", hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0, warning: "could not verify commits" }
]) {
  test(`submodule ${submodule.path} warnings allow workspace deletion and Finish after confirmation`, async () => {
    const f = await fixture();
    const risk = { hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0, submodules: [submodule] };
    f.risks.set("/work/one", risk);
    f.risks.set("/work/two", risk);
    const preview = await f.service.inspectWorkThreadFinish(f.threadId);
    const inspected = preview.workspaces[0]!;
    assert.equal(inspected.error, undefined);
    assert.match(inspected.risks.join("\n"), new RegExp(submodule.path));
    if (submodule.hasUncommittedChanges) assert.match(inspected.risks.join("\n"), /uncommitted changes.*untracked files.*2 commit\(s\) not merged/);
    if (submodule.warning) assert.match(inspected.risks.join("\n"), /could not verify commits/);
    await assert.rejects(() => f.service.deleteWorkspace("one"), /Workspace delete blocked.*Submodule/);
    assert.equal(f.calls.length + f.killed.length, 0);
    assert.equal(f.service.snapshot().workspaces.length, 3);
    await f.service.deleteWorkspace("one", true);
    await assert.rejects(() => f.service.finishWorkThread(f.input()), /Workspace delete blocked.*Submodule/);
    assert.equal(f.service.snapshot().workThreads[0]!.status, "active");
    await f.service.finishWorkThread({ ...f.input(), forceWorkspaceIds: ["two"] });
    assert.deepEqual(f.calls.map((call) => call.force), [true, true]);
    assert.equal(f.service.snapshot().workspaces.length, 0);
    assert.equal(f.service.snapshot().workThreads[0]!.status, "archived");
  });
}

test("partial deletion failure keeps thread active and retry touches only remaining workspaces", async () => {
  const f = await fixture(); f.failedDeletes.add("/work/two");
  await assert.rejects(() => f.service.finishWorkThread(f.input()), /1 workspace\(s\) deleted.*not archived/);
  assert.equal(f.service.snapshot().workThreads[0]!.status, "active");
  assert.deepEqual(f.service.snapshot().workspaces.map((item) => item.id), ["two", "main"]);
  const records = f.service.snapshot().workThreads[0]!.workspaceChanges!;
  assert.equal(records.find((record) => record.workspaceId === "one")?.outcome, "deleted");
  assert.equal(records.find((record) => record.workspaceId === "two")?.outcome, "failed");
  assert.match(records.find((record) => record.workspaceId === "two")?.error ?? "", /deletion failed/);
  f.failedDeletes.clear(); await f.service.finishWorkThread(f.input());
  assert.deepEqual(f.calls.map((item) => item.path), ["/work/one", "/work/two"]);
  assert.equal(f.service.snapshot().workThreads[0]!.status, "archived");
  const reloaded = await new JsonStore(f.statePath).load();
  assert.equal(reloaded.workThreads[0]!.workspaceChanges?.length, 3);
  assert.ok(reloaded.workThreads[0]!.workspaceChanges!.every((record) => record.outcome === "deleted" && !record.error));
});

test("deletion retains structured submodule evidence independently of Doc autosaves and archival", async () => {
  const f = await fixture();
  const changes = { baseline: { source: "created" as const, capturedAt: "start", commit: "a".repeat(40) }, submodules: [
    { path: "deps/core", hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0, initialized: true, activity: "version" as const,
      startCommit: "b".repeat(40), currentCommit: "c".repeat(40), files: ["core.ts"], commits: [{ hash: "c".repeat(40), subject: "Completed work" }] }
  ] };
  f.risks.set("/work/one", { hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0, submodules: changes.submodules, changes });
  const before = f.service.snapshot();
  const preview = await f.service.inspectWorkspaceDeletion("one");
  assert.deepEqual(f.service.snapshot(), before);
  assert.deepEqual(preview.changes, changes);
  const deleted = await f.service.deleteWorkspace("one", true);
  assert.equal(deleted.outcome, "deleted");
  assert.deepEqual(deleted.changes, changes);
  await f.service.saveWorkThreadDocument({ id: f.threadId, content: "An unrelated Doc edit" });
  await f.service.finishWorkThread(f.input());
  const loaded = await new JsonStore(f.statePath).load();
  const record = loaded.workThreads[0]!.workspaceChanges!.find((item) => item.workspaceId === "one")!;
  assert.deepEqual(record.changes, changes);
  assert.equal(loaded.workThreads[0]!.document, "An unrelated Doc edit");
  assert.equal(loaded.workThreads[0]!.status, "archived");
});

test("confirmation cannot delete an added, omitted or foreign workspace", async () => {
  const f = await fixture();
  for (const workspaceIds of [["one", "two"], ["one", "two", "main", "foreign"]]) await assert.rejects(() => f.service.finishWorkThread({ ...f.input(), workspaceIds }), /Workspaces changed/);
  const approved = f.input();
  await f.store.update((draft) => { draft.workspaces.push({ ...draft.workspaces[0]!, id: "added", name: "added" }); });
  await assert.rejects(() => f.service.finishWorkThread(approved), /Workspaces changed/);
  assert.equal(f.calls.length + f.killed.length, 0);
});

test("finish rechecks Git risks immediately before deletion", async () => {
  const f = await fixture();
  f.afterInspection(() => { if (f.inspected() === 2) f.risks.set("/work/one", { hasUncommittedChanges: true, hasUntrackedFiles: false, unmergedCommitCount: 0 }); });
  await assert.rejects(() => f.service.finishWorkThread(f.input()), /Workspace delete blocked/);
  assert.equal(f.calls.length + f.killed.length, 0);
});

test("running finish excludes competing finish, archive, delete, and workspace/session creation", async () => {
  const f = await fixture(); let release!: () => void;
  await f.store.update((draft) => { draft.sessions[0]!.status = "exited"; });
  f.hold(new Promise<void>((resolve) => { release = resolve; }));
  const finishing = f.service.finishWorkThread(f.input());
  try {
    await assert.rejects(() => f.service.finishWorkThread(f.input()), /finish is in progress/);
    await assert.rejects(() => f.service.archiveWorkThread(f.threadId), /finish is in progress/);
    await assert.rejects(() => f.service.deleteWorkThread(f.threadId), /finish is in progress/);
    await assert.rejects(() => f.service.deleteWorkspace("one"), /finish is in progress/);
    await assert.rejects(() => f.service.createWorkspace({ workThreadId: f.threadId, projectId: "project", deviceId: "dev_local", name: "new", kind: "main" }), /finish is in progress/);
    await assert.rejects(() => f.service.createSession({ workspaceId: "one" }), /finish is in progress/);
    await assert.rejects(() => f.service.resumeSession("session-one"), /finish is in progress/);
  } finally { release(); await finishing; }
});

test("empty threads finish; archived threads and creating workspaces cannot finish", async () => {
  const f = await fixture();
  await f.store.update((draft) => { draft.workspaces[1]!.status = "creating"; });
  assert.match((await f.service.inspectWorkThreadFinish(f.threadId)).workspaces[1]!.error!, /creation/);
  await assert.rejects(() => f.service.finishWorkThread(f.input()), /creation/);
  assert.equal(f.calls.length, 0);
  const id = await f.service.createWorkThread({ name: "Empty" });
  await f.service.finishWorkThread({ id, workspaceIds: [], forceWorkspaceIds: [] });
  assert.equal(f.service.snapshot().workThreads.find((item) => item.id === id)!.status, "archived");
  await assert.rejects(() => f.service.finishWorkThread({ id, workspaceIds: [], forceWorkspaceIds: [] }), /Restore/);
});

test("legacy failed workspaces and base-directory aliases retain their directories and never run Git delete", async () => {
  const f = await fixture();
  await f.store.update((draft) => {
    draft.workspaces[0]!.path = ""; draft.workspaces[0]!.status = "error";
    draft.workspaces[1]!.path = "/repo";
  });
  await f.service.finishWorkThread(f.input());
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.snapshot().workThreads[0]!.status, "archived");
});

test("failed archival after successful deletion can retry an empty thread without deleting again", async () => {
  const f = await fixture();
  const update = f.store.update.bind(f.store);
  let failArchive = true;
  f.store.update = (mutator) => update((draft) => {
    mutator(draft);
    if (failArchive && draft.workThreads[0]!.status === "archived") throw new Error("archive save failed");
  });
  await assert.rejects(() => f.service.finishWorkThread(f.input()), /3 workspace\(s\) deleted/);
  assert.equal(f.service.snapshot().workThreads[0]!.status, "active");
  assert.equal(f.service.snapshot().workspaces.length, 0);
  failArchive = false;
  await f.service.finishWorkThread(f.input());
  assert.equal(f.calls.length, 2);
  assert.equal(f.service.snapshot().workThreads[0]!.status, "archived");
});

test("finish leaves standalone workspaces and other work threads untouched", async () => {
  const f = await fixture();
  const other = await f.service.createWorkThread({ name: "Other", content: "Other Doc" });
  await f.store.update((draft) => {
    draft.workspaces.push({ ...draft.workspaces[0]!, id: "standalone", name: "standalone", workThreadId: undefined });
    draft.workspaces.push({ ...draft.workspaces[1]!, id: "other", name: "other", workThreadId: other });
  });
  await f.service.finishWorkThread(f.input());
  assert.deepEqual(f.service.snapshot().workspaces.map((item) => item.id), ["standalone", "other"]);
  assert.equal(f.service.snapshot().workThreads.find((item) => item.id === other)!.status, "active");
});

test("finish cannot race an already running standalone workspace deletion", async () => {
  const f = await fixture(); let release!: () => void;
  f.hold(new Promise<void>((resolve) => { release = resolve; }));
  const deleting = f.service.deleteWorkspace("one");
  try {
    await assert.rejects(() => f.service.finishWorkThread(f.input()), /Deletion of one is already in progress/);
    assert.equal(f.calls.length, 0);
  } finally { release(); await deleting; }
  await f.service.finishWorkThread(f.input());
  assert.deepEqual(f.calls.map((item) => item.path), ["/work/one", "/work/two"]);
  assert.equal(f.service.snapshot().workThreads[0]!.status, "archived");
});


test("deletion stops a live PTY even if its session metadata has not reconciled yet", async () => {
  const f = await fixture();
  await f.store.update((draft) => { draft.sessions[0]!.status = "exited"; });
  f.terminals.has = (id) => id === "session-one";
  await f.service.finishWorkThread(f.input());
  assert.ok(f.killed.includes("session-one"));
});
