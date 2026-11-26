import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MergeRequestRuntime, mergeRequestRepository } from "../src/main/runtime/merge-request-runtime";
import { DeviceCommandRunner, ProcessCommandRunner, type CommandRunner } from "../src/main/runtime/command-runner";
import { createWorkspaceMergeRequestSchema } from "../src/shared/contract";
import type { Workspace } from "../src/shared/domain";
import type { MergeRequestContext } from "../src/shared/merge-request";

async function fixture(t: TestContext, provider: "github" | "gitlab" = "gitlab") {
  const root = await mkdtemp(join(tmpdir(), "superthread-mr-"));
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
  const remoteUrl = provider === "github" ? "git@github.com:team/repo.git" : "ssh://git@gitlab.company.test:2222/team/sub/repo.git";
  const url = provider === "github" ? "https://github.com/team/repo/pull/1" : "https://gitlab.company.test/team/sub/repo/-/merge_requests/1";
  const state = { existing: false, lookupError: false, createError: false, pushError: false, malformed: false,
    branchChangedDuringLookup: false, createdOnFailure: false, forkOnly: false, creates: 0, lookups: 0, cli: [] as string[], calls: [] as string[][] };
  const runner: CommandRunner = { async run(program, args, options) {
    state.calls.push([program, ...args]);
    if (program === "git" && args[2] === "remote" && args[3] === "get-url") return { stdout: remoteUrl, stderr: "", exitCode: 0 };
    if (program === "git" && args[2] === "push" && state.pushError) throw new Error("push rejected");
    if (program === "sh") {
      const command = args.join(" ");
      state.cli.push(command);
      let stdout: string;
      if (command.includes("'list'")) {
        state.lookups++;
        if (state.lookupError) throw new Error("authentication failed");
        if (state.branchChangedDuringLookup) await git("switch", "main");
        stdout = state.malformed ? "not json" : JSON.stringify(state.existing || state.forkOnly ? [provider === "github"
          ? { url, isCrossRepository: state.forkOnly }
          : { web_url: url, source_project_id: state.forkOnly ? 2 : 1, target_project_id: 1 }] : []);
      } else {
        state.creates++;
        if (state.createError) {
          if (state.createdOnFailure) state.existing = true;
          throw new Error("API unavailable");
        }
        state.existing = true;
        stdout = `Created request\n${url}`;
      }
      return { stdout, stderr: "", exitCode: 0 };
    }
    return processRunner.run(program, args, options);
  } };
  const workspace: Workspace = { id: "workspace", name: "demo", projectId: "project", deviceId: "device", checkoutId: "checkout", kind: "worktree", path, branch: "stale-branch", baseBranch: "origin/main", status: "ready", createdAt: "now", updatedAt: "now" };
  const context: MergeRequestContext = { branch: "work/demo", targetBranch: "main", remoteUrl, provider };
  const runtime = new MergeRequestRuntime(runner);
  return { root, path, remote, remoteUrl, url, state, runner, git, commit, title, workspace, context, runtime };
}

test("provider parsing supports GitHub, nested/self-hosted GitLab, and HTTP API ports", () => {
  assert.deepEqual(mergeRequestRepository("git@github.com:team/repo.git"), { provider: "github", repository: "https://github.com/team/repo" });
  assert.deepEqual(mergeRequestRepository("ssh://git@gitlab.test:2222/team/sub/repo.git"), { provider: "gitlab", repository: "https://gitlab.test/team/sub/repo" });
  assert.equal(mergeRequestRepository("https://gitlab.test:8443/team/repo.git")?.repository, "https://gitlab.test:8443/team/repo");
  for (const value of ["/tmp/repo.git", "file:///tmp/repo.git", "https://example.com/repo"]) assert.equal(mergeRequestRepository(value), undefined);
});

for (const provider of ["github", "gitlab"] as const) {
  test(`${provider}: another fork's identically named branch does not hide creation`, async (t) => {
    const f = await fixture(t, provider);
    f.state.forkOnly = true;
    assert.equal((await f.runtime.inspect(f.workspace)).state, "available");
  });

  test(`${provider}: inspects the actual branch, pushes only committed work, creates once, and hides existing requests`, async (t) => {
    const f = await fixture(t, provider);
    assert.deepEqual(await f.runtime.inspect(f.workspace), { state: "available", context: f.context });
    assert.match(f.state.cli[0]!, provider === "github" ? /--state.*all/ : /--all/);
    await writeFile(join(f.path, "file"), "uncommitted");
    await writeFile(join(f.path, "untracked"), "keep");
    const before = await f.git("status", "--porcelain");
    const head = await f.git("rev-parse", "HEAD");
    assert.deepEqual(await f.runtime.create(f.workspace, f.context), { created: true, url: f.url });
    assert.equal(await f.git("--git-dir", f.remote, "rev-parse", "work/demo"), head);
    assert.equal(await f.git("status", "--porcelain"), before);
    assert.equal(await f.git("branch", "--show-current"), "work/demo");
    assert.deepEqual(await f.runtime.inspect(f.workspace), { state: "existing", url: f.url });
    assert.deepEqual(await f.runtime.create(f.workspace, f.context), { created: false, url: f.url });
    assert.equal(f.state.creates, 1);
    assert.equal(f.state.calls.filter((args) => args[3] === "push").length, 1);
    assert.match(f.state.cli.find((command) => command.includes("'create'"))!, /--title/);
  });
}

test("failed or malformed lookups never push, and stale branch expectations are rejected", async (t) => {
  const f = await fixture(t);
  f.state.lookupError = true;
  await assert.rejects(f.runtime.create(f.workspace, f.context), /authentication failed/);
  f.state.lookupError = false;
  f.state.malformed = true;
  await assert.rejects(f.runtime.create(f.workspace, f.context));
  f.state.malformed = false;
  await assert.rejects(f.runtime.create(f.workspace, { ...f.context, branch: "old-branch" }), /changed/);
  f.state.branchChangedDuringLookup = true;
  await assert.rejects(f.runtime.create(f.workspace, f.context), /changed/);
  assert.equal(f.state.calls.some((args) => args[3] === "push"), false);
});

test("push failures stop MR creation; creation failures preserve the pushed branch and allow retry", async (t) => {
  const f = await fixture(t);
  f.state.pushError = true;
  await assert.rejects(f.runtime.create(f.workspace, f.context), /push rejected/);
  assert.equal(f.state.creates, 0);
  f.state.pushError = false;
  f.state.createError = true;
  await assert.rejects(f.runtime.create(f.workspace, f.context), /Branch pushed, but MR creation failed/);
  assert.equal(await f.git("--git-dir", f.remote, "rev-parse", "work/demo"), await f.git("rev-parse", "HEAD"));
  f.state.createError = false;
  assert.equal((await f.runtime.create(f.workspace, f.context)).created, true);
});

test("a request created despite a timeout is reconciled without creating a duplicate", async (t) => {
  const f = await fixture(t);
  f.state.createError = true;
  f.state.createdOnFailure = true;
  assert.deepEqual(await f.runtime.create(f.workspace, f.context), { url: f.url, created: false });
  await f.runtime.create(f.workspace, f.context);
  assert.equal(f.state.creates, 1);
});

test("base branches, detached HEAD, and repositories without origin do not offer creation", async (t) => {
  const f = await fixture(t);
  await f.git("switch", "main");
  assert.equal((await f.runtime.inspect(f.workspace)).state, "unavailable");
  await f.git("switch", "--detach");
  assert.equal((await f.runtime.inspect(f.workspace)).state, "unavailable");
  await f.git("switch", "work/demo");
  await f.git("remote", "remove", "origin");
  assert.equal((await f.runtime.inspect(f.workspace)).state, "unavailable");
  assert.equal(f.state.lookups, 0);
});

test("the typed create input rejects unknown fields and invalid providers", () => {
  const context = { branch: "work/demo", targetBranch: "main", remoteUrl: "git@github.com:team/repo.git", provider: "github" };
  assert.equal(createWorkspaceMergeRequestSchema.safeParse({ workspaceId: "workspace", context }).success, true);
  assert.equal(createWorkspaceMergeRequestSchema.safeParse({ workspaceId: "workspace", context: { ...context, provider: "unknown" } }).success, false);
  assert.equal(createWorkspaceMergeRequestSchema.safeParse({ workspaceId: "workspace", context, force: true }).success, false);
});

test("SSH lookups run through the device's configured connection with shell quoting", async () => {
  const calls: string[][] = [];
  const runner = new DeviceCommandRunner({ deviceId: "remote", transport: "ssh", config: { host: "gpu.test", user: "builder", port: 2222 } }, {
    async run(program, args) { calls.push([program, ...args]); return { stdout: "work/demo", stderr: "", exitCode: 0 }; }
  });
  await runner.run("git", ["-C", "/home/builder/work tree", "branch", "--show-current"]);
  assert.deepEqual(calls[0]!.slice(0, -1), ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-p", "2222", "builder@gpu.test"]);
  assert.match(calls[0]!.at(-1)!, /'\/home\/builder\/work tree'/);
});
