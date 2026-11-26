import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkspaceService } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";
import { DeviceCommandRunner, ProcessCommandRunner, type CommandRunner } from "../src/main/runtime/command-runner";
import { GitRuntime } from "../src/main/runtime/git-runtime";
import type { TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import type { Device, DeviceConnection } from "../src/shared/domain";

async function fixture(t: TestContext, remote = false, standalone = false) {
  const temporary = await mkdtemp(join(tmpdir(), "superthread-delete-recovery-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const repo = join(root, "repo");
  const work = join(root, "work ' 中文");
  const branch = "work/test";
  await mkdir(repo);
  const processRunner = new ProcessCommandRunner();
  const git = async (cwd: string, ...args: string[]) => (await processRunner.run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args])).stdout;
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "file"), "start");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "Starting point");
  await git(repo, "worktree", "add", "-b", branch, work);
  const device: Device = { id: remote ? "remote" : "dev_local", name: "Test", type: remote ? "remote" : "local", status: "online", createdAt: "now" };
  const connection: DeviceConnection = { deviceId: device.id, transport: remote ? "ssh" : "local", config: remote ? { host: "fixture.invalid", user: "test" } : {} };
  const sshCalls: string[][] = [];
  // Execute SSH payloads locally, exercising the actual remote quoting and Python probe.
  const transport = new DeviceCommandRunner(connection, { run: (program, args, options) => {
    if (program !== "ssh") return processRunner.run(program, args, options);
    sshCalls.push(args);
    return processRunner.run("sh", ["-c", args.at(-1)!], options);
  } });
  let failure: "partial" | "before" | "directory" | "branch" | "probe" | undefined = "partial";
  const runner: CommandRunner = { run: async (program, args, options) => {
    if (program === "git" && args.includes("remove") && args.includes("worktree") && failure === "partial") {
      failure = undefined;
      const admin = await git(work, "rev-parse", "--absolute-git-dir");
      if (!remote) await rm(join(work, ".git"));
      await rm(admin, { recursive: true });
      throw new Error(`failed to delete '${work}': Permission denied`);
    }
    if (program === "git" && args.includes("remove") && args.includes("worktree") && failure === "before") throw new Error("Deletion failed before removing Git information");
    if (program === "rm" && failure === "directory") throw new Error("Permission denied");
    if (program === "git" && args.includes("branch") && args.includes("-D") && failure === "branch") throw new Error("cannot lock ref");
    if (failure === "probe") throw new Error("SSH unavailable or Permission denied");
    return transport.run(program, args, options);
  } };
  const runtime = new GitRuntime(device, connection, runner);
  const baseline = await runtime.captureWorkspaceBaseline(work);
  await writeFile(join(work, "file"), "completed");
  await git(work, "commit", "-am", "Completed work 中文");
  await git(repo, "merge", "--ff-only", branch);
  const statePath = join(root, "state.json");
  const terminals = Object.assign(new EventEmitter(), { has: () => false, kill: () => {} }) as unknown as TerminalRuntime;
  const makeService = () => new WorkspaceService(new JsonStore(statePath), terminals, () => runtime);
  let service = makeService();
  await service.initialize();
  const threadId = standalone ? undefined : await service.createWorkThread({ name: "Forward cleanup", content: "Keep my document" });
  const store = new JsonStore(statePath);
  await store.load();
  await store.update((draft) => {
    if (remote) { draft.devices.push(device); draft.connections.push(connection); }
    draft.projects.push({ id: "project", code: "repo", name: "Repo", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout", projectId: "project", deviceId: device.id, path: repo, isGit: true, defaultBranch: "main", createdAt: "now" });
    draft.workspaces.push({ id: "workspace", name: "Test", workThreadId: threadId, projectId: "project", deviceId: device.id, checkoutId: "checkout", kind: "worktree", path: work, branch, baseBranch: "main", gitBaseline: baseline, status: "ready", createdAt: "now", updatedAt: "now" });
    draft.browserTabs.push({ id: "browser", workspaceId: "workspace", url: "https://example.com", title: "Browser", order: 0, createdAt: "now", updatedAt: "now" });
  });
  service = makeService(); await service.initialize();
  return { repo, work, git, runtime, statePath, threadId, sshCalls,
    get service() { return service; },
    fail: (value: typeof failure) => { failure = value; },
    restart: async () => { service = makeService(); await service.initialize(); },
    finish: (force = true) => service.finishWorkThread({ id: threadId!, workspaceIds: ["workspace"], forceWorkspaceIds: force ? ["workspace"] : [] })
  };
}

for (const remote of [false, true]) {
  test(`${remote ? "SSH" : "local"} partial deletion survives restart and finishes after manual directory removal`, async (t) => {
    const f = await fixture(t, remote);
    await assert.rejects(() => f.finish(), /Permission denied/);
    const original = f.service.snapshot().workspaces[0]!.deletion!;
    assert.equal(original.outcome, "failed");
    assert.equal(original.changes?.repository?.commits[0]?.subject, "Completed work 中文");
    assert.equal(f.service.snapshot().workThreads[0]!.status, "active");
    await f.restart();
    const before = f.service.snapshot();
    const inspection = await f.service.inspectWorkThreadFinish(f.threadId!);
    assert.equal(inspection.workspaces[0]!.recovery, "directory");
    assert.deepEqual(inspection.workspaces[0]!.changes, original.changes);
    assert.deepEqual(f.service.snapshot(), before);
    await assert.rejects(() => f.finish(false), /explicitly approve force/);
    f.fail("directory");
    await assert.rejects(() => f.finish(), /Permission denied.*remove.*refresh and retry/s);
    assert.equal(f.service.snapshot().workspaces.length, 1);
    assert.equal(f.service.snapshot().browserTabs.length, 1);
    await f.git(f.repo, "rev-parse", "--verify", `refs/heads/work/test`);
    await rm(f.work, { recursive: true });
    f.fail(undefined);
    await f.restart();
    assert.equal((await f.service.inspectWorkspaceDeletion("workspace")).recovery, "missing");
    await f.finish();
    const saved = await new JsonStore(f.statePath).load();
    assert.equal(saved.workThreads[0]!.status, "archived");
    assert.equal(saved.workThreads[0]!.document, "Keep my document");
    assert.equal(saved.workspaces.length + saved.browserTabs.length, 0);
    assert.equal(saved.workThreads[0]!.workspaceChanges!.length, 1);
    assert.equal(saved.workThreads[0]!.workspaceChanges![0]!.outcome, "deleted");
    assert.deepEqual(saved.workThreads[0]!.workspaceChanges![0]!.changes, original.changes);
    await assert.rejects(() => f.git(f.repo, "rev-parse", "--verify", "refs/heads/work/test"));
    await access(join(f.repo, "file"));
    if (remote) assert.ok(f.sshCalls.some((args) => args.at(-1)!.startsWith("'python3'")));
  });
}

test("standalone cleanup keeps evidence across failures and an already removed branch is idempotent", async (t) => {
  const f = await fixture(t, false, true);
  await assert.rejects(() => f.service.deleteWorkspace("workspace"), /Permission denied/);
  const evidence = f.service.snapshot().workspaces[0]!.deletion!.changes;
  f.fail("branch");
  await assert.rejects(() => f.service.deleteWorkspace("workspace", true), /cannot lock ref/);
  await assert.rejects(() => access(f.work));
  assert.equal(f.service.snapshot().workspaces.length, 1);
  f.fail(undefined);
  await f.git(f.repo, "branch", "-D", "work/test");
  await f.restart();
  const record = await f.service.deleteWorkspace("workspace", true);
  assert.equal(record.outcome, "deleted");
  assert.deepEqual(record.changes, evidence);
  assert.equal(f.service.snapshot().workspaces.length, 0);
});

test("old failed and interrupted thread summaries recover without a workspace checkpoint", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.finish(), /Permission denied/);
  const store = new JsonStore(f.statePath); await store.load();
  await store.update((draft) => {
    delete draft.workspaces[0]!.deletion;
    draft.workThreads[0]!.workspaceChanges![0]!.outcome = "pending";
  });
  await f.restart();
  await f.finish();
  assert.equal(f.service.snapshot().workThreads[0]!.status, "archived");
  await assert.rejects(() => access(f.work));
});

test("connection/probe failures never count as a missing directory, and new deletions cannot skip Git checks", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(() => f.finish(), /Permission denied/);
  f.fail("probe");
  assert.match((await f.service.inspectWorkspaceDeletion("workspace")).error!, /SSH unavailable/);
  await assert.rejects(() => f.finish(), /SSH unavailable/);
  assert.equal(f.service.snapshot().workspaces.length, 1);
  f.fail(undefined);
  const store = new JsonStore(f.statePath); await store.load();
  await store.update((draft) => { delete draft.workspaces[0]!.deletion; delete draft.workThreads[0]!.workspaceChanges; });
  await f.restart();
  await assert.rejects(() => f.service.deleteWorkspace("workspace", true));
  assert.equal(f.service.snapshot().workspaces.length, 1);
});

test("recovery protects checkout aliases and refuses a replacement symlink", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.finish(), /Permission denied/);
  await rm(f.work, { recursive: true });
  await symlink(f.repo, f.work);
  await assert.rejects(() => f.runtime.resumeWorktreeDeletion(f.repo, f.work, "work/test"), /symlink|base checkout/);
  await access(join(f.repo, "file"));
});

test("a registered worktree with its directory already removed is cleaned without pruning other registrations", async (t) => {
  const f = await fixture(t);
  f.fail(undefined);
  const other = `${f.work}-other`;
  await f.git(f.repo, "worktree", "add", "-b", "work/other", other, "main");
  await rm(f.work, { recursive: true });
  await f.runtime.resumeWorktreeDeletion(f.repo, f.work, "work/test");
  assert.match(await f.git(f.repo, "worktree", "list", "--porcelain"), /work\/other/);
  await access(other);
});

test("worktree registrations are matched through parent-directory aliases even after directory removal", async (t) => {
  const f = await fixture(t);
  f.fail(undefined);
  const alias = join(f.repo, "parent-alias");
  await symlink(join(f.work, ".."), alias);
  const workAlias = join(alias, "work ' 中文");
  assert.equal(await f.runtime.inspectWorktreeRemoval(f.repo, workAlias, "work/test"), "intact");
  await rm(f.work, { recursive: true });
  await f.runtime.resumeWorktreeDeletion(f.repo, workAlias, "work/test");
  assert.doesNotMatch(await f.git(f.repo, "worktree", "list", "--porcelain"), /work\/test/);
});

test("an intact worktree still checks new changes after a previous failed attempt", async (t) => {
  const f = await fixture(t);
  f.fail("before");
  await assert.rejects(() => f.finish(), /Deletion failed before/);
  await writeFile(join(f.work, "new-work.txt"), "Do not lose new work");
  const inspection = await f.service.inspectWorkspaceDeletion("workspace");
  assert.equal(inspection.recovery, undefined);
  assert.ok(inspection.risks.some((risk) => risk.includes("untracked files")));
  await assert.rejects(() => f.finish(false), /Workspace delete blocked.*untracked files/);
  await access(join(f.work, "new-work.txt"));
  f.fail(undefined);
  await f.finish();
  assert.equal(f.service.snapshot().workThreads[0]!.status, "archived");
});
