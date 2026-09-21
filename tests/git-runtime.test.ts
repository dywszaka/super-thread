import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult, Device, DeviceConnection } from "../src/shared/domain";
import { GitRuntime } from "../src/main/runtime/git-runtime";
import type { CommandRunner } from "../src/main/runtime/command-runner";

class FakeRunner implements CommandRunner {
  calls: Array<{ program: string; args: string[]; cwd?: string }> = [];
  async run(program: string, args: string[], options: { cwd?: string } = {}): Promise<CommandResult> {
    this.calls.push({ program, args, cwd: options.cwd });
    const command = args.join(" ");
    if (command.includes("--show-toplevel")) return { stdout: "/code/demo", stderr: "", exitCode: 0 };
    if (command.includes("get-url")) return { stdout: "git@example.com:team/demo.git", stderr: "", exitCode: 0 };
    if (command.includes("symbolic-ref")) return { stdout: "origin/main", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

const local: Device = { id: "local", name: "Mac", type: "local", status: "online", createdAt: "now" };
const connection: DeviceConnection = { deviceId: "local", transport: "local", config: {} };

test("GitRuntime derives repository identity from Git, not directory input", async () => {
  const runner = new FakeRunner();
  const info = await new GitRuntime(local, connection, runner).inspect("/code/demo/subdir");
  assert.deepEqual(info, { root: "/code/demo", name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main" });
  assert.equal(runner.calls.length, 3);
});

test("GitRuntime creates an isolated worktree and work branch", async () => {
  const runner = new FakeRunner();
  const created = await new GitRuntime(local, connection, runner).createWorktree("/code/demo", "feature-x", "main");
  assert.deepEqual(created, { path: "/code/.superthread-workspaces/feature-x", branch: "work/feature-x" });
  assert.ok(runner.calls.some((call) => call.args.join(" ").includes("worktree add -b work/feature-x /code/.superthread-workspaces/feature-x main")));
});
