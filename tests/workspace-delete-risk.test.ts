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
  return { root, checkout, worktree, runtime, git, commit, inspect, squash };
}

async function remoteFixture(t: { after(fn: () => Promise<void>): void }, remote = "origin", remoteBranch = "master") {
  const f = await fixture(t);
  const repository = join(f.root, "remote repository.git");
  const publisher = join(f.root, "publisher");
  await f.git(f.checkout, "init", "--bare", repository);
  await f.git(f.checkout, "remote", "add", remote, repository);
  await f.git(f.checkout, "push", "-u", remote, `master:refs/heads/${remoteBranch}`);
  await f.git(f.checkout, "clone", "--no-local", f.checkout, publisher);
  await f.git(publisher, "remote", "rename", "origin", "source");
  await f.git(publisher, "remote", "add", "publish", repository);
  const publish = () => f.git(publisher, "push", "publish", `HEAD:refs/heads/${remoteBranch}`);
  const initial = await f.git(f.checkout, "rev-parse", "master");
  return { ...f, repository, publisher, publish, initial };
}

for (const merge of ["squash", "ordinary"] as const) {
  test(`deletion fetches a remote ${merge} merge while preserving local branches, files and indexes`, async (t) => {
    const f = await remoteFixture(t);
    const baseline = await f.runtime.captureWorkspaceBaseline(f.worktree);
    await f.git(f.publisher, "merge", merge === "squash" ? "--squash" : "--ff-only", "source/work/test");
    if (merge === "squash") await f.commit(f.publisher, "squash on remote");
    await f.publish();
    assert.equal(await f.git(f.checkout, "rev-parse", "origin/master"), f.initial);
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
    const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.checkout, f.worktree, "work/test", "master", baseline);
    assert.equal(risk.unmergedCommitCount, 0);
    assert.equal(risk.hasUncommittedChanges, true);
    assert.equal(risk.hasUntrackedFiles, true);
    assert.deepEqual(risk.changes?.baseline, baseline);
    assert.equal(await f.git(f.checkout, "rev-parse", "master"), f.initial);
    assert.equal(await f.git(f.checkout, "rev-parse", "origin/master"), await f.git(f.publisher, "rev-parse", "HEAD"));
    assert.deepEqual(await Promise.all([state(f.checkout), state(f.worktree)]), before);
  });
}

test("deletion follows the base branch's configured remote and differently named upstream branch", async (t) => {
  const f = await remoteFixture(t, "upstream", "release/stable");
  // An unrelated origin must not override the explicitly configured upstream.
  await f.git(f.checkout, "remote", "add", "origin", join(f.root, "unavailable.git"));
  await f.git(f.publisher, "merge", "--ff-only", "source/work/test");
  await f.publish();
  assert.equal((await f.inspect()).unmergedCommitCount, 0);
  assert.equal(await f.git(f.checkout, "rev-parse", "master"), f.initial);
});

test("a base without an upstream fetches the same branch from origin", async (t) => {
  const f = await remoteFixture(t);
  await f.git(f.checkout, "branch", "--unset-upstream", "master");
  await f.git(f.publisher, "merge", "--ff-only", "source/work/test");
  await f.publish();
  assert.equal((await f.inspect()).unmergedCommitCount, 0);
});

for (const base of ["origin/master", "refs/remotes/origin/master", "origin/HEAD", "HEAD"]) {
  test(`deletion refreshes the remote base selected as ${base}`, async (t) => {
    const f = await remoteFixture(t);
    await f.git(f.checkout, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
    await f.git(f.publisher, "merge", "--ff-only", "source/work/test");
    await f.publish();
    assert.equal((await f.runtime.inspectWorkspaceDeleteRisk(f.checkout, f.worktree, "work/test", base)).unmergedCommitCount, 0);
  });
}

test("refreshing after a remote rewind restores the unmerged warning", async (t) => {
  const f = await remoteFixture(t);
  await f.git(f.publisher, "merge", "--ff-only", "source/work/test");
  await f.publish();
  assert.equal((await f.inspect()).unmergedCommitCount, 0);
  await f.git(f.publisher, "push", "--force", "publish", `${f.initial}:refs/heads/master`);
  assert.equal((await f.inspect()).unmergedCommitCount, 2);
});

for (const failure of ["unavailable remote", "deleted branch"]) {
  test(`${failure} fails the deletion check instead of trusting a stale merged base`, async (t) => {
    const f = await remoteFixture(t);
    await f.git(f.publisher, "merge", "--ff-only", "source/work/test");
    await f.publish();
    assert.equal((await f.inspect()).unmergedCommitCount, 0);
    if (failure === "unavailable remote") await f.git(f.checkout, "remote", "set-url", "origin", join(f.root, "missing.git"));
    else await f.git(f.publisher, "push", "publish", ":refs/heads/master");
    await assert.rejects(f.inspect, /Unable to refresh base branch "master" from "origin"/);
    assert.equal(await f.git(f.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "work/test");
  });
}

test("squashing multiple workspace commits into master permits normal worktree deletion", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.inspect()).unmergedCommitCount, 2);
  await f.squash();
  // The original commit IDs remain absent from master after a squash.
  assert.equal(await f.git(f.checkout, "rev-list", "--count", "master..work/test"), "2");
  const risk = await f.inspect();
  assert.equal(risk.hasUncommittedChanges, false);
  assert.equal(risk.hasUntrackedFiles, false);
  assert.equal(risk.unmergedCommitCount, 0);
  assert.deepEqual(risk.changes?.repository?.commits.map((commit) => commit.subject), ["second feature commit", "first feature commit"]);
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
  const risk = await f.inspect();
  assert.equal(risk.hasUncommittedChanges, true);
  assert.equal(risk.hasUntrackedFiles, true);
  assert.equal(risk.unmergedCommitCount, 0);
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
  test(`deletion fetches and pins the upstream commit through the ${type} device runner`, async () => {
    const commit = "a".repeat(40);
    let fetched = false;
    const runner: CommandRunner = { run: async (program, args, options) => {
      assert.equal(program, "git");
      let stdout = "";
      if (args.includes("--symbolic-full-name")) stdout = "refs/heads/master";
      else if (args.includes("for-each-ref")) stdout = "refs/heads/master\0upstream\0refs/heads/release\0refs/remotes/upstream/release";
      else if (args.includes("fetch")) {
        assert.deepEqual(args, ["-C", "/base checkout", "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--", "upstream", "+refs/heads/release:refs/remotes/upstream/release"]);
        assert.equal(options?.timeoutMs, 30_000);
        fetched = true;
      } else if (args.includes("--verify")) {
        assert.equal(fetched, true);
        assert.ok(["refs/remotes/upstream/release^{commit}", "HEAD^{commit}"].includes(args.at(-1)!));
        stdout = commit;
      } else if (args.includes("rev-list")) {
        assert.equal(fetched, true);
        assert.equal(args.at(-1), `${commit}..work/test`);
        stdout = "0";
      } else if (args.includes("ls-tree")) {
        assert.equal(args.at(-1), commit);
      }
      return { stdout, stderr: "", exitCode: 0 };
    } };
    const runtime = new GitRuntime({ ...local, type }, connection, runner);
    assert.equal((await runtime.inspectWorkspaceDeleteRisk("/base checkout", "/workspace", "work/test", "master")).unmergedCommitCount, 0);
    assert.equal(fetched, true);
  });

  test(`squash checks use the ${type} device runner and retain warnings when unsupported`, async () => {
    let unsupported = false;
    const runner: CommandRunner = { run: async (program, args) => {
      assert.equal(program, "git");
      if (args.includes("merge-tree")) {
        assert.deepEqual(args, ["-C", "/base checkout", "merge-tree", "--write-tree", "master", "work/test"]);
        if (unsupported) throw new Error("unknown option: write-tree");
      }
      return { stdout: args.includes("rev-list") ? "2" : args.some((arg) => ["status", "log", "submodule", "ls-tree", "ls-files"].includes(arg)) ? "" : "tree-id", stderr: "", exitCode: 0 };
    } };
    const runtime = new GitRuntime({ ...local, type }, connection, runner);
    const inspect = () => runtime.inspectWorkspaceDeleteRisk("/base checkout", "/workspace", "work/test", "master");
    assert.equal((await inspect()).unmergedCommitCount, 0);
    unsupported = true;
    assert.equal((await inspect()).unmergedCommitCount, 2);
  });
}
