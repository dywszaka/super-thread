import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitRuntime } from "../src/main/runtime/git-runtime";
import { ProcessCommandRunner, type CommandRunner } from "../src/main/runtime/command-runner";
import type { Device, DeviceConnection } from "../src/shared/domain";

const local: Device = { id: "local", name: "Mac", type: "local", status: "online", createdAt: "now" };
const connection: DeviceConnection = { deviceId: "local", transport: "local", config: {} };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "superthread-delete-risk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "base checkout");
  const worktree = join(root, "workspace");
  await mkdir(checkout);
  const runner = new ProcessCommandRunner();
  const git = async (path: string, ...args: string[]) => (await runner.run("git", ["-C", path, ...args])).stdout;
  const commit = async (path: string, message: string) => {
    await git(path, "add", ".");
    await git(path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false", "commit", "-m", message);
  };
  await git(checkout, "init", "-b", "master");
  await writeFile(join(checkout, "original.txt"), "original\n");
  await commit(checkout, "initial");
  await git(checkout, "worktree", "add", "-b", "work/test", worktree, "master");
  await writeFile(join(worktree, "feature.txt"), "first\n");
  await commit(worktree, "first feature commit");
  await writeFile(join(worktree, "feature.txt"), "first\nsecond\n");
  await commit(worktree, "second feature commit");
  const runtime = new GitRuntime(local, connection, runner);
  const inspect = () => runtime.inspectWorkspaceDeleteRisk(checkout, worktree, "work/test", "master");
  const squash = async () => {
    await git(checkout, "merge", "--squash", "work/test");
    await commit(checkout, "squashed feature");
  };
  return { checkout, worktree, runtime, git, commit, inspect, squash };
}

test("squashing multiple workspace commits into master permits normal worktree deletion", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.inspect()).unmergedCommitCount, 2);
  await f.squash();
  // The original commit IDs remain absent from master after a squash.
  assert.equal(await f.git(f.checkout, "rev-list", "--count", "master..work/test"), "2");
  assert.deepEqual(await f.inspect(), { hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0 });
  await f.runtime.deleteWorktree(f.checkout, f.worktree, "work/test", false);
  assert.equal(await f.git(f.checkout, "branch", "--list", "work/test"), "");
  assert.equal(await readFile(join(f.checkout, "feature.txt"), "utf8"), "first\nsecond\n");
});

test("squash detection tolerates later base commits and preserves dirty files and indexes", async (t) => {
  const f = await fixture(t);
  await f.squash();
  await writeFile(join(f.checkout, "later.txt"), "later base change\n");
  await f.commit(f.checkout, "advance master");
  await writeFile(join(f.checkout, "original.txt"), "staged checkout change\n");
  await f.git(f.checkout, "add", "original.txt");
  await writeFile(join(f.worktree, "feature.txt"), "staged workspace change\n");
  await f.git(f.worktree, "add", "feature.txt");
  await writeFile(join(f.worktree, "feature.txt"), "unstaged workspace change\n");
  await writeFile(join(f.worktree, "scratch.txt"), "untracked\n");
  const state = async (path: string) => Promise.all([
    f.git(path, "status", "--porcelain"), f.git(path, "diff"), f.git(path, "diff", "--cached"), f.git(path, "rev-parse", "HEAD")
  ]);
  const before = await Promise.all([state(f.checkout), state(f.worktree)]);
  assert.deepEqual(await f.inspect(), { hasUncommittedChanges: true, hasUntrackedFiles: true, unmergedCommitCount: 0 });
  assert.deepEqual(await Promise.all([state(f.checkout), state(f.worktree)]), before);
});

test("new workspace commits after a squash still warn about unmerged content", async (t) => {
  const f = await fixture(t);
  await f.squash();
  await writeFile(join(f.worktree, "extra.txt"), "not merged\n");
  await f.commit(f.worktree, "additional work");
  assert.equal((await f.inspect()).unmergedCommitCount, 3);
});

test("a partial squash and merge conflicts retain the deletion warning", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.checkout, "feature.txt"), "first\n");
  await f.commit(f.checkout, "only part of the feature");
  assert.equal((await f.inspect()).unmergedCommitCount, 2);
  await writeFile(join(f.checkout, "feature.txt"), "conflicting base content\n");
  await f.commit(f.checkout, "conflicting change");
  assert.equal((await f.inspect()).unmergedCommitCount, 2);
});

test("reverting a squash restores the unmerged-content warning", async (t) => {
  const f = await fixture(t);
  await f.squash();
  await f.git(f.checkout, "rm", "feature.txt");
  await f.commit(f.checkout, "revert feature");
  assert.equal((await f.inspect()).unmergedCommitCount, 2);
});

test("ordinary merges still permit deletion without a content check", async (t) => {
  const f = await fixture(t);
  await f.git(f.checkout, "merge", "--ff-only", "work/test");
  assert.equal((await f.inspect()).unmergedCommitCount, 0);
});

for (const type of ["local", "remote"] as const) {
  test(`squash checks use the ${type} device runner and retain warnings when unsupported`, async () => {
    let unsupported = false;
    const runner: CommandRunner = { run: async (program, args) => {
      assert.equal(program, "git");
      if (args.includes("merge-tree")) {
        assert.deepEqual(args, ["-C", "/base checkout", "merge-tree", "--write-tree", "master", "work/test"]);
        if (unsupported) throw new Error("unknown option: write-tree");
      }
      return { stdout: args.includes("rev-list") ? "2" : args.includes("status") ? "" : "tree-id", stderr: "", exitCode: 0 };
    } };
    const runtime = new GitRuntime({ ...local, type }, connection, runner);
    const inspect = () => runtime.inspectWorkspaceDeleteRisk("/base checkout", "/workspace", "work/test", "master");
    assert.equal((await inspect()).unmergedCommitCount, 0);
    unsupported = true;
    assert.equal((await inspect()).unmergedCommitCount, 2);
  });
}
