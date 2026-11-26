import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MergeRequestRuntime } from "../src/main/runtime/merge-request-runtime";
import { DeviceCommandRunner, ProcessCommandRunner, type CommandRunner } from "../src/main/runtime/command-runner";
import { hostingRepositoryPath, parseGitRemote, normalizeGitHostingUrl, saveGitHostingConnectionSchema } from "../src/shared/git-hosting";
import type { Workspace } from "../src/shared/domain";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "superthread-mr-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "work tree"), remote = join(root, "remote.git");
  await mkdir(path);
  const processRunner = new ProcessCommandRunner();
  const git = async (...args: string[]) => (await processRunner.run("git", ["-C", path, ...args])).stdout;
  await git("init", "-b", "main");
  await writeFile(join(path, "file"), "base");
  const commit = async (title: string) => {
    await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false", "commit", "-m", title);
  };
  await commit("initial");
  await git("init", "--bare", remote);
  await git("remote", "add", "origin", remote);
  await git("push", "origin", "main");
  await git("switch", "-c", "work/demo");
  await writeFile(join(path, "file"), "feature");
  const title = "Fix 'quotes' $() `commands` 中文";
  await commit(title);
  const calls: string[][] = [];
  const state = { remoteUrl: "git@gitlab.company.test:team/sub/repo.git", pushError: false };
  const runner: CommandRunner = { async run(program, args, options) {
    calls.push([program, ...args]);
    assert.equal(program, "git", "MR device runtime must never run gh/glab or a shell");
    if (args[2] === "remote" && args[3] === "get-url") return { stdout: state.remoteUrl, stderr: "", exitCode: 0 };
    if (args[2] === "push") {
      if (state.pushError) throw new Error("Permission denied; secret-bearing transport details");
      assert.equal(args[args.length - 2], state.remoteUrl);
      args = args.map((arg) => arg === state.remoteUrl ? remote : arg);
    }
    return processRunner.run(program, args, options);
  } };
  const workspace: Workspace = { id: "workspace", name: "demo", projectId: "project", deviceId: "device", checkoutId: "checkout", kind: "worktree", path, branch: "stale-branch", baseBranch: "origin/main", status: "ready", createdAt: "now", updatedAt: "now" };
  return { root, path, remote, state, calls, git, commit, title, workspace, runtime: new MergeRequestRuntime(runner) };
}

test("remote parsing supports aliases, nested GitLab paths, prefixes, and different API/SSH ports", () => {
  const alias = parseGitRemote("git@gitlab-alias:team/sub/repo.git")!;
  assert.equal(alias.host, "gitlab-alias");
  assert.equal(alias.suggestedProvider, "gitlab");
  assert.equal(parseGitRemote("git@github.com:team/repo.git")?.suggestedProvider, "github");
  assert.equal(parseGitRemote("ssh://git@gitlab.test:2222/team/repo.git")?.suggestedBaseUrl, "https://gitlab.test");
  const http = parseGitRemote("https://gitlab.test:8443/gitlab/team/sub/repo.git")!;
  assert.equal(http.suggestedBaseUrl, "https://gitlab.test:8443");
  assert.equal(hostingRepositoryPath(http, "https://gitlab.test:8443/gitlab"), "team/sub/repo");
  assert.equal(hostingRepositoryPath(alias, "https://gitlab.test/gitlab"), "team/sub/repo");
  for (const value of ["/tmp/repo.git", "file:///tmp/repo.git", "https://user:password@gitlab.test/team/repo.git", "https://example.com/repo"]) assert.equal(parseGitRemote(value), undefined);
  assert.equal(normalizeGitHostingUrl("https://gitlab.test:8443/gitlab/"), "https://gitlab.test:8443/gitlab");
  for (const value of ["http://gitlab.test", "https://user:pass@gitlab.test", "https://gitlab.test?token=secret"]) assert.throws(() => normalizeGitHostingUrl(value));
  assert.equal(saveGitHostingConnectionSchema.safeParse({ provider: "github", baseUrl: "https://enterprise.test", token: "test" }).success, false);
});

test("push pins the reviewed branch and commit without staging, force, tags, or other refs", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.path, "file"), "uncommitted");
  await writeFile(join(f.path, "scratch"), "untracked");
  const prepared = await f.runtime.prepare(f.workspace);
  assert.ok(!("state" in prepared));
  assert.equal(prepared.branch, "work/demo");
  assert.equal(prepared.defaultTitle, f.title);
  assert.equal(prepared.hasUncommittedChanges, true);
  const before = await f.git("status", "--porcelain");
  await f.runtime.push(f.workspace, prepared);
  assert.equal(await f.git("--git-dir", f.remote, "rev-parse", "work/demo"), prepared.headCommit);
  assert.equal(await f.git("status", "--porcelain"), before);
  const push = f.calls.find((args) => args[3] === "push")!;
  assert.deepEqual(push.slice(4), ["--no-follow-tags", "--recurse-submodules=no", "--", f.state.remoteUrl, `${prepared.headCommit}:refs/heads/work/demo`]);
});

test("branch, HEAD, and remote changes require fresh confirmation before pushing", async (t) => {
  const f = await fixture(t);
  const prepared = await f.runtime.prepare(f.workspace);
  assert.ok(!("state" in prepared));
  await writeFile(join(f.path, "file"), "second change");
  await f.commit("second");
  await assert.rejects(f.runtime.push(f.workspace, prepared), /changed/);
  const current = await f.runtime.prepare(f.workspace);
  assert.ok(!("state" in current));
  f.state.remoteUrl = "git@another.test:team/repo.git";
  await assert.rejects(f.runtime.push(f.workspace, current), /changed/);
  await f.git("switch", "main");
  await assert.rejects(f.runtime.push(f.workspace, current), /changed/);
  assert.equal(f.calls.some((args) => args[3] === "push"), false);
});

test("push errors are actionable and do not echo credential-bearing process output", async (t) => {
  const f = await fixture(t);
  const prepared = await f.runtime.prepare(f.workspace);
  assert.ok(!("state" in prepared));
  f.state.pushError = true;
  await assert.rejects(f.runtime.push(f.workspace, prepared), (error: Error) => {
    assert.match(error.message, /repair terminal/); assert.doesNotMatch(error.message, /secret-bearing/); return true;
  });
});

test("base branch, detached HEAD, no origin, and multiple push URLs do not offer creation", async (t) => {
  const f = await fixture(t);
  f.state.remoteUrl += "\ngit@other.test:team/repo.git";
  assert.ok("state" in await f.runtime.prepare(f.workspace));
  await f.git("switch", "main");
  assert.ok("state" in await f.runtime.prepare(f.workspace));
  await f.git("switch", "--detach");
  assert.ok("state" in await f.runtime.prepare(f.workspace));
  await f.git("switch", "work/demo");
  await f.git("remote", "remove", "origin");
  assert.ok("state" in await f.runtime.prepare(f.workspace));
});

test("SSH Git commands use the selected device connection with literal arguments", async () => {
  const calls: string[][] = [];
  const runner = new DeviceCommandRunner({ deviceId: "remote", transport: "ssh", config: { host: "gpu.test", user: "builder", port: 2222 } }, {
    async run(program, args) { calls.push([program, ...args]); return { stdout: "work/demo", stderr: "", exitCode: 0 }; }
  });
  await runner.run("git", ["-C", "/home/builder/work tree", "branch", "--show-current"]);
  assert.deepEqual(calls[0]!.slice(0, -1), ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-p", "2222", "builder@gpu.test"]);
  assert.match(calls[0]!.at(-1)!, /'\/home\/builder\/work tree'/);
});
