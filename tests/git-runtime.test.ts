import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import test, { type TestContext } from "node:test";
import type { CommandResult, Device, DeviceConnection } from "../src/shared/domain";
import { GitRuntime } from "../src/main/runtime/git-runtime";
import { DeviceCommandRunner, ProcessCommandRunner, type CommandRunner } from "../src/main/runtime/command-runner";

class FakeRunner implements CommandRunner {
  calls: Array<{ program: string; args: string[]; cwd?: string }> = [];
  async run(program: string, args: string[], options: { cwd?: string } = {}): Promise<CommandResult> {
    this.calls.push({ program, args, cwd: options.cwd });
    const command = args.join(" ");
    if (program === "pwd") return { stdout: options.cwd ?? "/home/builder", stderr: "", exitCode: 0 };
    if (command.includes("$HOME")) return { stdout: "/home/builder", stderr: "", exitCode: 0 };
    if (command.includes("--show-toplevel")) return { stdout: "/code/demo", stderr: "", exitCode: 0 };
    if (command.includes("get-url")) return { stdout: "git@example.com:team/demo.git", stderr: "", exitCode: 0 };
    if (command.includes("symbolic-ref")) return { stdout: "origin/main", stderr: "", exitCode: 0 };
    if (command.includes("rev-parse --symbolic-full-name")) return { stdout: "refs/heads/main", stderr: "", exitCode: 0 };
    if (command.includes("status --porcelain")) return { stdout: " M src/main.ts\n?? scratch.txt", stderr: "", exitCode: 0 };
    if (command.includes("rev-list --count")) return { stdout: "2", stderr: "", exitCode: 0 };
    if (command.includes("HEAD^{commit}") || command.includes("merge-base main HEAD")) return { stdout: "a".repeat(40), stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

const local: Device = { id: "local", name: "Mac", type: "local", status: "online", createdAt: "now" };
const connection: DeviceConnection = { deviceId: "local", transport: "local", config: {} };
const remote: Device = { id: "remote", name: "GPU", type: "remote", status: "online", createdAt: "now" };
const remoteConnection: DeviceConnection = { deviceId: "remote", transport: "ssh", config: { host: "gpu.example", user: "builder" } };

test("remote clone resolves the parent on its device and uses the same SSH config as fetch", async () => {
  const calls: Array<{ program: string; args: string[]; timeoutMs?: number }> = [];
  const root = "/home/builder/code with spaces/demo";
  const runner: CommandRunner = { run: async (program, args, options) => {
    calls.push({ program, args, timeoutMs: options?.timeoutMs });
    const command = args.at(-1)!;
    const stdout = command === "'pwd'" ? "/home/builder"
      : command.includes("'pwd' '-P'") ? command.includes("/demo'") ? root : "/home/builder/code with spaces"
      : command.includes("--show-toplevel") ? root
      : command.includes("get-url") ? "git@example.com:team/demo.git"
      : command.includes("symbolic-ref --short") ? "origin/main"
      : command.includes("rev-parse") ? "refs/heads/main"
      : command.endsWith("'remote'") ? "origin" : "";
    return { stdout, stderr: "", exitCode: 0 };
  } };
  const runtime = new GitRuntime(remote, remoteConnection, new DeviceCommandRunner(remoteConnection, runner));
  assert.deepEqual(await runtime.clone("git@example.com:team/demo.git", "~/code with spaces"), {
    root, name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main"
  });
  await runtime.inspectWorkspaceDeleteRisk(root, "/work/demo", "work/demo", "main");
  const clone = calls.find((call) => call.args.at(-1)?.includes("'clone'"))!;
  const fetch = calls.find((call) => call.args.at(-1)?.includes("'fetch'"))!;
  assert.ok(clone);
  assert.ok(fetch);
  assert.equal(clone.args.at(-1), "'git' 'clone' '--' 'git@example.com:team/demo.git' '/home/builder/code with spaces/demo'");
  assert.equal(clone.timeoutMs, 600_000);
  // Neither operation overrides ForwardAgent or the SSH config file; OpenSSH owns agent forwarding.
  assert.deepEqual(clone.args.slice(0, -1), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "builder@gpu.example"]);
  assert.deepEqual(fetch.args.slice(0, -1), clone.args.slice(0, -1));
  assert.ok(calls.every((call) => call.program === "ssh"));
});

test("clone failures propagate before repository inspection", async () => {
  const calls: string[] = [];
  const runner: CommandRunner = { run: async (program) => {
    calls.push(program);
    if (program === "git") throw new Error("Permission denied (publickey)");
    return { stdout: "/srv", stderr: "", exitCode: 0 };
  } };
  await assert.rejects(() => new GitRuntime(remote, remoteConnection, runner).clone("git@example.com:demo.git", "/srv"), /Permission denied/);
  assert.deepEqual(calls, ["pwd", "git"]);
});

test("GitRuntime records Git metadata for a project directory", async () => {
  const runner = new FakeRunner();
  const info = await new GitRuntime(local, connection, runner).inspect("/code/demo");
  assert.deepEqual(info, { root: "/code/demo", name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main" });
  assert.equal(runner.calls.length, 4);
});

test("GitRuntime creates an isolated worktree and work branch", async () => {
  const runner = new FakeRunner();
  const created = await new GitRuntime(local, connection, runner).createWorktree("/code/demo", "demo-code", "feature-x", "main");
  const expectedPath = `${homedir()}/.superthread/workspaces/demo-code/feature-x`;
  assert.deepEqual(created, { path: expectedPath, branch: "work/feature-x" });
  assert.ok(runner.calls.some((call) => call.args.join(" ").includes(`worktree add -b work/feature-x ${expectedPath} main`)));
  assert.equal(runner.calls.some((call) => call.args.includes("fetch")), false);
});

test("GitRuntime creates remote worktrees from the imported checkout without accessing origin", async () => {
  const runner = new FakeRunner();
  const created = await new GitRuntime(remote, remoteConnection, runner).createWorktree("/srv/demo", "demo-code", "feature-x", "main");
  assert.deepEqual(created, { path: "/home/builder/.superthread/workspaces/demo-code/feature-x", branch: "work/feature-x" });
  assert.ok(runner.calls.some((call) => call.program === "sh" && call.args.includes("printf %s \"$HOME\"")));
  assert.ok(runner.calls.some((call) => call.args.join(" ").includes("-C /srv/demo worktree add -b work/feature-x /home/builder/.superthread/workspaces/demo-code/feature-x main")));
  assert.equal(runner.calls.some((call) => call.args.includes("fetch")), false);
});

test("GitRuntime reports workspace deletion risk and removes worktree plus branch", async () => {
  const runner = new FakeRunner();
  const runtime = new GitRuntime(local, connection, runner);

  const risk = await runtime.inspectWorkspaceDeleteRisk("/code/demo", "/work/demo", "work/feature-x", "main");
  await runtime.deleteWorktree("/code/demo", "/work/demo", "work/feature-x", true);

  assert.equal(risk.hasUncommittedChanges, true);
  assert.equal(risk.hasUntrackedFiles, true);
  assert.equal(risk.unmergedCommitCount, 2);
  assert.deepEqual(risk.changes?.repository, { currentCommit: "a".repeat(40), commits: [] });
  assert.equal(runner.calls.some((call) => call.args.includes("fetch")), false);
  assert.ok(runner.calls.some((call) => call.args.join(" ").includes("worktree remove --force /work/demo")));
  assert.ok(runner.calls.some((call) => call.args.join(" ").includes("branch -D work/feature-x")));
});

for (const [device, deviceConnection] of [[local, connection], [remote, remoteConnection]] as const) {
  test(`GitRuntime refuses to remove the base checkout on ${device.type} devices`, async () => {
    const runner = new FakeRunner();
    const runtime = new GitRuntime(device, deviceConnection, runner);
    for (const force of [false, true]) {
      await assert.rejects(() => runtime.deleteWorktree("/code/demo", "/code/demo/./", "main", force), /Cannot delete the base checkout/);
    }
    assert.deepEqual(runner.calls, []);
  });
}

async function submoduleFixture(t: TestContext, nested = false) {
  const temporary = await mkdtemp(join(tmpdir(), "superthread-submodule-delete-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const processRunner = new ProcessCommandRunner();
  const runner: CommandRunner = { run: (program, args, options) => processRunner.run(program, program === "git"
    ? ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args] : args, options) };
  const git = (cwd: string, ...args: string[]) => runner.run("git", ["-C", cwd, ...args]).then((result) => result.stdout);
  const init = async (name: string) => {
    const path = join(root, name);
    await mkdir(path);
    await git(path, "init", "-b", "main");
    await writeFile(join(path, "file.txt"), "initial\n");
    await git(path, "add", ".");
    await git(path, "commit", "-m", "Initial");
    return path;
  };
  const child = await init("child");
  if (nested) {
    const leaf = await init("leaf");
    await git(child, "submodule", "add", leaf, "inner module");
    await git(child, "commit", "-am", "Add nested submodule");
  }
  const repo = await init("repo");
  const submoduleName = "deps/child ' 模块";
  await git(repo, "submodule", "add", child, submoduleName);
  await git(repo, "commit", "-am", "Add submodule");
  const work = join(root, "workspace");
  await git(repo, "worktree", "add", "-b", "work/test", work, "main");
  return { repo, work, submoduleName, git, runner, runtime: new GitRuntime(local, connection, runner) };
}

test("clean initialized submodules need Git force removal even without changes", async (t) => {
  const f = await submoduleFixture(t);
  assert.equal((await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main")).submodules?.[0]?.initialized, false);
  await f.git(f.work, "submodule", "update", "--init");
  assert.equal(await f.git(f.work, "status", "--porcelain"), "");
  const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main");
  assert.equal(risk.submodules?.[0]?.activity, "unchanged");
  assert.equal(risk.submodules?.[0]?.initialized, true);
  assert.equal(risk.submodules?.[0]?.unmergedCommitCount, 0);
  await assert.rejects(() => f.runtime.deleteWorktree(f.repo, f.work, "work/test", false), /containing submodules/);
  await f.runtime.deleteWorktree(f.repo, f.work, "work/test", true);
  await assert.rejects(() => access(f.work));
  await access(join(f.repo, "file.txt"));
  await assert.rejects(() => f.git(f.repo, "rev-parse", "--verify", "refs/heads/work/test"));
});

test("a parent version update does not attribute an existing nested version mismatch to new changes", async (t) => {
  const f = await submoduleFixture(t, true);
  await f.git(f.work, "submodule", "update", "--init", "--recursive");
  const child = join(f.work, f.submoduleName);
  const leaf = join(child, "inner module");
  await writeFile(join(leaf, "file.txt"), "existing nested version\n");
  await f.git(leaf, "commit", "-am", "Existing dependency version");
  const baseline = await f.runtime.captureWorkspaceBaseline(f.work);
  // Commit only the parent's own file, leaving its existing nested gitlink mismatch untouched.
  await writeFile(join(child, "file.txt"), "parent work\n");
  await f.git(child, "add", "file.txt");
  await f.git(child, "commit", "-m", "Parent work");
  const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main", baseline);
  const [parent, nested] = risk.submodules!;
  assert.equal(parent!.activity, "version");
  assert.equal(parent!.hasUncommittedChanges, false);
  assert.equal(parent!.unmergedCommitCount, 1);
  assert.equal(nested!.activity, "unchanged");
  assert.equal(nested!.currentCommit, nested!.startCommit);
  assert.equal(nested!.unmergedCommitCount, 1);
  assert.equal(nested!.warning, undefined);
  assert.deepEqual(nested!.files, []);
  assert.deepEqual(nested!.commits, []);
});

test("nested untracked files warn only on the module that owns them", async (t) => {
  const f = await submoduleFixture(t, true);
  const baseline = await f.runtime.captureWorkspaceBaseline(f.work);
  await f.git(f.work, "submodule", "update", "--init", "--recursive");
  await writeFile(join(f.work, f.submoduleName, "inner module", "scratch.txt"), "nested work\n");
  const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main", baseline);
  const [parent, nested] = risk.submodules!;
  assert.equal(parent!.activity, "unchanged");
  assert.equal(parent!.hasUncommittedChanges, false);
  assert.equal(parent!.hasUntrackedFiles, false);
  assert.equal(nested!.activity, "modified");
  assert.equal(nested!.hasUntrackedFiles, true);
  assert.deepEqual(nested!.files, ["scratch.txt"]);
});

test("recursive submodule checks find dirty files and commits even with ignored or committed gitlinks", async (t) => {
  const f = await submoduleFixture(t, true);
  await f.git(f.work, "submodule", "update", "--init", "--recursive");
  const child = join(f.work, f.submoduleName);
  const leaf = join(child, "inner module");
  await writeFile(join(leaf, "file.txt"), "unmerged nested code\n");
  await f.git(leaf, "commit", "-am", "Nested work");
  await f.git(child, "commit", "-am", "Record nested work");
  await f.git(f.work, "commit", "-am", "Record child work");
  await writeFile(join(child, "file.txt"), "uncommitted code\n");
  await writeFile(join(leaf, "scratch.txt"), "untracked code\n");
  await f.git(f.work, "config", "diff.ignoreSubmodules", "all");
  await f.git(child, "config", "status.showUntrackedFiles", "no");
  await f.git(leaf, "config", "status.showUntrackedFiles", "no");
  assert.equal(await f.git(f.work, "status", "--porcelain"), "");
  const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main");
  assert.equal(risk.submodules?.length, 2);
  assert.equal(risk.submodules[0]!.path, f.submoduleName);
  assert.equal(risk.submodules[0]!.hasUncommittedChanges, true);
  assert.equal(risk.submodules[0]!.unmergedCommitCount, 1);
  assert.equal(risk.submodules[1]?.path, `${f.submoduleName}/inner module`);
  assert.equal(risk.submodules[1]?.hasUncommittedChanges, false);
  assert.equal(risk.submodules[1]?.hasUntrackedFiles, true);
  assert.equal(risk.submodules[1]?.unmergedCommitCount, 1);
  assert.equal(risk.submodules[1]?.activity, "modified");
  assert.deepEqual(new Set(risk.submodules[1]?.files), new Set(["file.txt", "scratch.txt"]));
  assert.equal(risk.submodules[1]?.commits?.[0]?.subject, "Nested work");
  await f.runtime.deleteWorktree(f.repo, f.work, "work/test", true);
  await assert.rejects(() => access(f.work));
});

for (const base of ["local", "remote"]) {
  test(`a fixed creation baseline retains submodule changes after the ${base} base branch incorporates them`, async (t) => {
    const f = await submoduleFixture(t, true);
    if (base === "remote") {
      const origin = `${f.repo}-origin.git`;
      await f.git(f.repo, "init", "--bare", origin);
      await f.git(f.repo, "remote", "add", "origin", origin);
      await f.git(f.repo, "push", "-u", "origin", "main");
    }
    const baseline = await f.runtime.captureWorkspaceBaseline(f.work);
    assert.equal(baseline.source, "created");
    await f.git(f.work, "submodule", "update", "--init", "--recursive");
    const child = join(f.work, f.submoduleName);
    const nested = join(child, "inner module");
    await writeFile(join(nested, "file.txt"), "completed nested development\n");
    await f.git(nested, "commit", "-am", "Nested completed work");
    await f.git(child, "commit", "-am", "Record completed nested work");
    await f.git(f.work, "commit", "-am", "Record completed submodule work");
    if (base === "remote") await f.git(f.work, "push", "origin", "HEAD:refs/heads/main");
    else await f.git(f.repo, "merge", "--ff-only", "work/test");
    const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main", baseline);
    assert.equal(risk.unmergedCommitCount, 0);
    assert.equal(risk.changes?.baseline.commit, baseline.commit);
    if (base === "remote") assert.equal(await f.git(f.repo, "rev-parse", "main"), baseline.commit);
    assert.equal(risk.submodules?.length, 2);
    for (const sub of risk.submodules!) {
      assert.equal(sub.unmergedCommitCount, 0);
      assert.equal(sub.activity, "version");
      assert.notEqual(sub.currentCommit, sub.startCommit);
      assert.equal(sub.commits?.length, 1);
    }
  });
}

test("removed submodules and uncertain historical starting versions are explicitly labelled", async (t) => {
  const f = await submoduleFixture(t);
  const baseline = await f.runtime.captureWorkspaceBaseline(f.work);
  await f.git(f.work, "rm", f.submoduleName);
  await f.git(f.work, "commit", "-m", "Remove dependency");
  const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main", baseline);
  assert.equal(risk.submodules?.[0]?.activity, "removed");
  assert.equal(risk.submodules?.[0]?.currentCommit, undefined);
  const unknown = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main", { ...baseline, source: "unknown", commit: "1".repeat(40), submodules: [] });
  assert.equal(unknown.submodules?.[0]?.activity, "unknown");
  assert.match(unknown.changes?.baseline.warning ?? "", /unavailable/);
  await assert.rejects(() => f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main", { ...baseline, commit: "1".repeat(40), submodules: [] }), /Could not collect repository commits/);
});

test("staged submodule version updates remain visible when its checked-out HEAD has not changed", async (t) => {
  const f = await submoduleFixture(t);
  const baseline = await f.runtime.captureWorkspaceBaseline(f.work);
  await f.git(f.work, "submodule", "update", "--init");
  const child = join(f.work, f.submoduleName);
  const start = await f.git(child, "rev-parse", "HEAD");
  await writeFile(join(child, "file.txt"), "new module code\n");
  await f.git(child, "commit", "-am", "Staged module update");
  const update = await f.git(child, "rev-parse", "HEAD");
  await f.git(child, "checkout", start);
  await f.git(f.work, "update-index", "--cacheinfo", `160000,${update},${f.submoduleName}`);
  const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main", baseline);
  const sub = risk.submodules![0]!;
  assert.equal(sub.activity, "version");
  assert.equal(sub.currentCommit, start);
  assert.equal(sub.recordedCommit, update);
  assert.equal(sub.unmergedCommitCount, 1);
  assert.equal(sub.commits?.[0]?.subject, "Staged module update");
});

test("pre-existing dirty submodules are marked as uncertain rather than attributed to new workspace work", async (t) => {
  const f = await submoduleFixture(t);
  await f.git(f.work, "submodule", "update", "--init");
  await writeFile(join(f.work, f.submoduleName, "file.txt"), "pre-existing work\n");
  const baseline = await f.runtime.captureWorkspaceBaseline(f.work);
  assert.equal(baseline.submodules?.[0]?.dirty, true);
  const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main", baseline);
  assert.equal(risk.submodules?.[0]?.activity, "unknown");
  assert.equal(risk.submodules?.[0]?.hasUncommittedChanges, true);
  assert.match(risk.submodules?.[0]?.warning ?? "", /Started with uncommitted files/);
});

test("missing submodule base objects produce a confirmable warning instead of failing inspection", async (t) => {
  const f = await submoduleFixture(t);
  await f.git(f.work, "submodule", "update", "--init");
  await f.git(f.repo, "update-index", "--cacheinfo", `160000,${"1".repeat(40)},${f.submoduleName}`);
  await f.git(f.repo, "commit", "-m", "Unavailable submodule version");
  const risk = await f.runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main");
  assert.match(risk.submodules?.[0]?.warning ?? "", /could not verify commits/);
  await f.runtime.deleteWorktree(f.repo, f.work, "work/test", true);
});

test("failed submodule status checks warn without preventing confirmed deletion", async (t) => {
  const f = await submoduleFixture(t);
  await f.git(f.work, "submodule", "update", "--init");
  const submodulePath = join(f.work, f.submoduleName);
  const runner: CommandRunner = { run: (program, args, options) => {
    if (args[1] === submodulePath && args.includes("status")) throw new Error("Submodule status unavailable");
    return f.runner.run(program, args, options);
  } };
  const runtime = new GitRuntime(local, connection, runner);
  const risk = await runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main");
  assert.match(risk.submodules?.[0]?.warning ?? "", /could not verify uncommitted changes or untracked files/);
  await runtime.deleteWorktree(f.repo, f.work, "work/test", true);
});

test("failed submodule discovery is a confirmable warning", async (t) => {
  const f = await submoduleFixture(t);
  await f.git(f.work, "submodule", "update", "--init");
  const runner: CommandRunner = { run: (program, args, options) => {
    if (args.includes("foreach")) throw new Error("Submodule discovery unavailable");
    return f.runner.run(program, args, options);
  } };
  const runtime = new GitRuntime(local, connection, runner);
  const risk = await runtime.inspectWorkspaceDeleteRisk(f.repo, f.work, "work/test", "main");
  assert.match(risk.submodules?.[0]?.warning ?? "", /could not inspect submodules/);
  await runtime.deleteWorktree(f.repo, f.work, "work/test", true);
});

test("GitRuntime imports ordinary folders and resolves symlinks without accepting files or missing paths", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "superthread-import-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const folder = join(temporary, "notes");
  await mkdir(folder);
  await symlink(folder, join(temporary, "alias"));
  await writeFile(join(temporary, "file.txt"), "notes");
  const runtime = new GitRuntime(local, connection);
  const root = await realpath(folder);
  assert.deepEqual(await runtime.inspect(folder), { root, name: "notes" });
  assert.deepEqual(await runtime.inspect(join(temporary, "alias")), { root, name: "notes" });
  await assert.rejects(() => runtime.inspect(join(temporary, "missing")));
  await assert.rejects(() => runtime.inspect(join(temporary, "file.txt")));
});

test("GitRuntime supports Git without origin and preserves selected subdirectories", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "superthread-git-import-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  await new ProcessCommandRunner().run("git", ["init", "-b", "main", root]);
  const runtime = new GitRuntime(local, connection);
  assert.deepEqual(await runtime.inspect(root), { root, name: root.split("/").at(-1), remote: undefined, defaultBranch: "main" });
  await mkdir(join(root, "notes"));
  assert.deepEqual(await runtime.inspect(join(root, "notes")), { root: join(root, "notes"), name: "notes" });
});

test("GitRuntime imports a remote folder even when Git is unavailable, but propagates connection failures", async () => {
  const calls: Array<{ program: string; args: string[]; cwd?: string }> = [];
  let disconnected = false;
  const runner: CommandRunner = {
    run: async (program, args, options) => {
      calls.push({ program, args, cwd: options?.cwd });
      if (disconnected) throw new Error("SSH connection failed");
      return { stdout: program === "pwd" ? "/srv/notes" : "", stderr: "", exitCode: 0 };
    }
  };
  const runtime = new GitRuntime(remote, remoteConnection, runner);
  assert.deepEqual(await runtime.inspect("/srv/notes"), { root: "/srv/notes", name: "notes" });
  assert.ok(calls.some((call) => call.program === "sh" && call.cwd === "/srv/notes"));
  disconnected = true;
  await assert.rejects(() => runtime.inspect("/srv/notes"), /SSH connection failed/);
});

for (const [device, deviceConnection] of [[local, connection], [remote, remoteConnection]] as const) {
  test(`GitRuntime rejects unsafe project codes before creating directories on ${device.type}`, async () => {
    const runner = new FakeRunner();
    for (const code of ["", "..", "../escape", "a/b", "a\\b", "a\0b"]) {
      await assert.rejects(() => new GitRuntime(device, deviceConnection, runner).createWorktree("/code/demo", code, "feature", "main"));
    }
    assert.deepEqual(runner.calls, []);
  });
}
