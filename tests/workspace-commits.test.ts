import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GitRuntime } from "../src/main/runtime/git-runtime";
import { ProcessCommandRunner, DeviceCommandRunner, type CommandRunner } from "../src/main/runtime/command-runner";
import type { Device, DeviceConnection } from "../src/shared/domain";

const local: Device = { id: "local", name: "Mac", type: "local", status: "online", createdAt: "now" };
const connection: DeviceConnection = { deviceId: "local", transport: "local", config: {} };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "superthread-commits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo ' 中文");
  await mkdir(repo);
  const runner = new ProcessCommandRunner();
  const git = async (path: string, ...args: string[]) => (await runner.run("git", ["-C", path, ...args])).stdout;
  await git(repo, "init", "-b", "main");
  const commit = (path: string, subject: string) => git(path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", subject);
  const runtime = new GitRuntime(local, connection, runner);
  return { root, repo, runner, git, commit, runtime };
}

for (const merge of ["ordinary", "squash"]) {
  test(`fixed creation history retains all commits after ${merge} merge, without a 20-commit limit`, async (t) => {
    const f = await fixture(t);
    await f.commit(f.repo, "Before workspace");
    const work = join(f.root, "work");
    await f.git(f.repo, "worktree", "add", "-b", "work/test", work, "main");
    const baseline = await f.runtime.captureWorkspaceBaseline(work);
    for (let i = 0; i < 23; i++) await f.commit(work, `期间提交 ${i} <tag> [link]`);
    if (merge === "ordinary") await f.git(f.repo, "merge", "--ff-only", "work/test");
    else { await f.git(f.repo, "merge", "--squash", "work/test"); await f.commit(f.repo, "Squashed work"); }
    const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, work, "work/test", "main", baseline);
    assert.equal(risk.unmergedCommitCount, 0);
    const repository = risk.changes!.repository!;
    assert.equal(repository.commits.length, 23);
    assert.equal(repository.commits[0]!.hash, repository.currentCommit);
    assert.equal(repository.commits[0]!.subject, "期间提交 22 <tag> [link]");
    assert.equal(repository.commits.at(-1)!.subject, "期间提交 0 <tag> [link]");
    assert.equal(repository.warning, undefined);
    assert.ok(repository.commits.every((commit) => commit.hash !== baseline.commit));
  });
}

test("main-directory history handles empty repositories, first commits, detached HEAD, and no new commits", async (t) => {
  const f = await fixture(t);
  const empty = await f.runtime.captureWorkspaceBaseline(f.repo);
  assert.equal(empty.unborn, true);
  assert.deepEqual((await f.runtime.inspectWorkspaceChanges(f.repo, "main", empty)).repository, { commits: [] });
  await f.commit(f.repo, "First commit");
  assert.equal((await f.runtime.inspectWorkspaceChanges(f.repo, "main", empty)).repository!.commits[0]!.subject, "First commit");
  const baseline = await f.runtime.captureWorkspaceBaseline(f.repo);
  assert.deepEqual((await f.runtime.inspectWorkspaceChanges(f.repo, "main", baseline)).repository!.commits, []);
  await f.git(f.repo, "checkout", "--detach");
  await f.commit(f.repo, "Detached work");
  assert.deepEqual((await f.runtime.inspectWorkspaceChanges(f.repo, "main", baseline)).repository!.commits.map((commit) => commit.subject), ["Detached work"]);
});

test("inferred, unknown and rewritten starting histories remain explicitly distinguishable", async (t) => {
  const f = await fixture(t);
  await f.commit(f.repo, "Original");
  const baseline = await f.runtime.captureWorkspaceBaseline(f.repo);
  await f.git(f.repo, "checkout", "-b", "work/test");
  await f.commit(f.repo, "Work");
  const inferred = await f.runtime.inspectWorkspaceChanges(f.repo, "main");
  assert.equal(inferred.baseline.source, "inferred");
  assert.deepEqual(inferred.repository!.commits.map((commit) => commit.subject), ["Work"]);
  const unknown = await f.runtime.inspectWorkspaceChanges(f.repo, "main", { source: "unknown", capturedAt: "then" });
  assert.match(unknown.repository!.warning!, /starting commit is unknown/);
  await f.git(f.repo, "checkout", "--orphan", "rewritten");
  await f.commit(f.repo, "Rewritten");
  const rewritten = await f.runtime.inspectWorkspaceChanges(f.repo, "main", baseline);
  assert.match(rewritten.repository!.warning!, /no longer descends/);
  assert.deepEqual(rewritten.repository!.commits.map((commit) => commit.subject), ["Rewritten"]);
});

test("missing objects and failed log reads block cleanup instead of returning an empty history", async (t) => {
  const f = await fixture(t);
  await f.commit(f.repo, "Initial");
  const baseline = await f.runtime.captureWorkspaceBaseline(f.repo);
  await assert.rejects(() => f.runtime.inspectWorkspaceChanges(f.repo, "main", { ...baseline, commit: "1".repeat(40) }), /Could not collect repository commits/);
  const runner: CommandRunner = { run: (program, args, options) => {
    if (args.includes("log")) throw new Error("SSH disconnected");
    return f.runner.run(program, args, options);
  } };
  await assert.rejects(() => new GitRuntime(local, connection, runner).inspectWorkspaceDeleteRisk(f.repo, f.repo, "main", "main", baseline), /Could not collect repository commits.*SSH disconnected/);
  assert.equal(await f.git(f.repo, "rev-parse", "HEAD"), baseline.commit);
});

test("commit history uses the SSH device runner with quoted paths and preserves Unicode subjects", async () => {
  const start = "a".repeat(40), end = "b".repeat(40);
  let readLog = false;
  const runner = new DeviceCommandRunner({ deviceId: "remote", transport: "ssh", config: { host: "example.invalid", user: "builder" } }, { run: async (program, args, options) => {
    assert.equal(program, "ssh");
    assert.ok(args.at(-1)!.includes("'/srv/repo '\\'' 中文'"));
    const command = args.at(-1)!;
    if (command.includes("'log'")) {
      readLog = true;
      assert.ok(command.includes(`'${start}..${end}'`));
      assert.equal(options?.preserveOutput, true);
      return { stdout: `${end}\0远程提交 中文\0`, stderr: "", exitCode: 0 };
    }
    return { stdout: command.includes("'rev-parse'") ? end : "", stderr: "", exitCode: 0 };
  } });
  const changes = await new GitRuntime({ ...local, type: "remote" }, connection, runner).inspectWorkspaceChanges("/srv/repo ' 中文", "main", { commit: start, source: "created", capturedAt: "then" });
  assert.equal(readLog, true);
  assert.deepEqual(changes.repository!.commits, [{ hash: end, subject: "远程提交 中文" }]);
});
