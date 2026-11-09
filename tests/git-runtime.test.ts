import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import test from "node:test";
import type { CommandResult, Device, DeviceConnection } from "../src/shared/domain";
import { GitRuntime } from "../src/main/runtime/git-runtime";
import { ProcessCommandRunner, type CommandRunner } from "../src/main/runtime/command-runner";

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
    if (command.includes("status --porcelain")) return { stdout: " M src/main.ts\n?? scratch.txt", stderr: "", exitCode: 0 };
    if (command.includes("rev-list --count")) return { stdout: "2", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

const local: Device = { id: "local", name: "Mac", type: "local", status: "online", createdAt: "now" };
const connection: DeviceConnection = { deviceId: "local", transport: "local", config: {} };
const remote: Device = { id: "remote", name: "GPU", type: "remote", status: "online", createdAt: "now" };
const remoteConnection: DeviceConnection = { deviceId: "remote", transport: "ssh", config: { host: "gpu.example", user: "builder" } };

test("GitRuntime records Git metadata for a project directory", async () => {
  const runner = new FakeRunner();
  const info = await new GitRuntime(local, connection, runner).inspect("/code/demo");
  assert.deepEqual(info, { root: "/code/demo", name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main" });
  assert.equal(runner.calls.length, 4);
});

test("GitRuntime creates an isolated worktree and work branch", async () => {
  const runner = new FakeRunner();
  const created = await new GitRuntime(local, connection, runner).createWorktree("/code/demo", "demo", "feature-x", "main");
  const expectedPath = `${homedir()}/.superthread/workspaces/demo/feature-x`;
  assert.deepEqual(created, { path: expectedPath, branch: "work/feature-x" });
  assert.ok(runner.calls.some((call) => call.args.join(" ").includes(`worktree add -b work/feature-x ${expectedPath} main`)));
  assert.equal(runner.calls.some((call) => call.args.includes("fetch")), false);
});

test("GitRuntime creates remote worktrees from the imported checkout without accessing origin", async () => {
  const runner = new FakeRunner();
  const created = await new GitRuntime(remote, remoteConnection, runner).createWorktree("/srv/demo", "demo", "feature-x", "main");
  assert.deepEqual(created, { path: "/home/builder/.superthread/workspaces/demo/feature-x", branch: "work/feature-x" });
  assert.ok(runner.calls.some((call) => call.program === "sh" && call.args.includes("printf %s \"$HOME\"")));
  assert.ok(runner.calls.some((call) => call.args.join(" ").includes("-C /srv/demo worktree add -b work/feature-x /home/builder/.superthread/workspaces/demo/feature-x main")));
  assert.equal(runner.calls.some((call) => call.args.includes("fetch")), false);
});

test("GitRuntime reports workspace deletion risk and removes worktree plus branch", async () => {
  const runner = new FakeRunner();
  const runtime = new GitRuntime(local, connection, runner);

  const risk = await runtime.inspectWorkspaceDeleteRisk("/code/demo", "/work/demo", "work/feature-x", "main");
  await runtime.deleteWorktree("/code/demo", "/work/demo", "work/feature-x", true);

  assert.deepEqual(risk, { hasUncommittedChanges: true, hasUntrackedFiles: true, unmergedCommitCount: 2 });
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
