import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import type { CommandResult, Device, DeviceConnection } from "../src/shared/domain";
import { GitRuntime } from "../src/main/runtime/git-runtime";
import type { CommandRunner } from "../src/main/runtime/command-runner";

class FakeRunner implements CommandRunner {
  calls: Array<{ program: string; args: string[]; cwd?: string }> = [];
  async run(program: string, args: string[], options: { cwd?: string } = {}): Promise<CommandResult> {
    this.calls.push({ program, args, cwd: options.cwd });
    const command = args.join(" ");
    if (program === "sh") return { stdout: "/home/builder", stderr: "", exitCode: 0 };
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

test("GitRuntime derives repository identity from Git, not directory input", async () => {
  const runner = new FakeRunner();
  const info = await new GitRuntime(local, connection, runner).inspect("/code/demo/subdir");
  assert.deepEqual(info, { root: "/code/demo", name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main" });
  assert.equal(runner.calls.length, 3);
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
  assert.ok(runner.calls.some((call) => call.args.join(" ").includes("worktree remove --force /work/demo")));
  assert.ok(runner.calls.some((call) => call.args.join(" ").includes("branch -D work/feature-x")));
});
