import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitRuntime } from "../src/main/runtime/git-runtime";
import { ProcessCommandRunner, type CommandRunner } from "../src/main/runtime/command-runner";
import type { Device, DeviceConnection } from "../src/shared/domain";

const local: Device = { id: "local", name: "Mac", type: "local", status: "online", createdAt: "now" };
const connection: DeviceConnection = { deviceId: "local", transport: "local", config: {} };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "superthread-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "base checkout");
  const worktree = join(root, "worktree");
  await mkdir(checkout);
  const runner = new ProcessCommandRunner();
  const git = (args: string[]) => runner.run("git", ["-C", checkout, ...args]);
  await git(["init", "-b", "main"]);
  await mkdir(join(checkout, "config"));
  await writeFile(join(checkout, "config/tracked.txt"), "tracked");
  await writeFile(join(checkout, ".gitignore"), "node_modules/\n.env\n");
  await git(["add", "."]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
  await git(["worktree", "add", "-b", "work/test", worktree, "main"]);
  await mkdir(join(checkout, "node_modules"));
  await writeFile(join(checkout, "node_modules/dependency"), "dependency");
  await writeFile(join(checkout, ".env"), "local config");
  await writeFile(join(checkout, "config/local file"), "local nested config");
  await mkdir(join(checkout, "empty"));
  return { checkout, worktree, runtime: new GitRuntime(local, connection, runner) };
}

test("link candidates include ignored and empty directories, keeping tracked siblings out", async (t) => {
  const { checkout, runtime } = await fixture(t);
  await writeFile(join(checkout, " leading\nfile '$(literal)"), "special");
  assert.deepEqual(await runtime.listWorkspaceLinkCandidates(checkout), [
    { path: " leading\nfile '$(literal)", kind: "file" },
    { path: ".env", kind: "file" },
    { path: "config/local file", kind: "file" },
    { path: "empty", kind: "directory" },
    { path: "node_modules", kind: "directory" }
  ]);
});

test("links preserve names and share original contents; removing a worktree preserves the sources", async (t) => {
  const { checkout, worktree, runtime } = await fixture(t);
  const special = " leading\nfile '$(literal)";
  await writeFile(join(checkout, special), "special");
  await runtime.linkWorktreePaths(checkout, worktree, ["node_modules", ".env", "config/local file", "empty", special]);
  for (const path of ["node_modules", ".env", "config/local file", "empty", special]) {
    assert.equal(await readlink(join(worktree, path)), join(checkout, path));
  }
  await writeFile(join(worktree, ".env"), "updated");
  assert.equal(await readFile(join(checkout, ".env"), "utf8"), "updated");
  await runtime.deleteWorktree(checkout, worktree, "work/test", true);
  assert.equal(await readFile(join(checkout, ".env"), "utf8"), "updated");
  assert.equal(await readFile(join(checkout, "node_modules/dependency"), "utf8"), "dependency");
});

test("linking rejects tracked, missing, unsafe and overlapping paths", async (t) => {
  const { checkout, worktree, runtime } = await fixture(t);
  for (const paths of [["config"], ["config/tracked.txt"], ["missing"], ["../escape"], [".git"], [".env", ".env"], ["node_modules", "node_modules/dependency"]]) {
    await assert.rejects(() => runtime.linkWorktreePaths(checkout, worktree, paths), /Cannot link|Invalid|Overlapping/);
  }
  await rm(join(checkout, ".env"));
  await assert.rejects(() => runtime.linkWorktreePaths(checkout, worktree, [".env"]), /no longer/);
});

test("links never overwrite existing files, directories, dangling links or symlink parents", async (t) => {
  const { checkout, worktree, runtime } = await fixture(t);
  await writeFile(join(worktree, ".env"), "keep me");
  await mkdir(join(worktree, "node_modules"));
  await symlink(join(worktree, "missing"), join(worktree, "empty"));
  for (const path of [".env", "node_modules", "empty"]) {
    await assert.rejects(() => runtime.linkWorktreePaths(checkout, worktree, [path]), /destination already exists/);
  }
  await rm(join(worktree, "config"), { recursive: true });
  await symlink(join(checkout, "config"), join(worktree, "config"));
  await assert.rejects(() => runtime.linkWorktreePaths(checkout, worktree, ["config/local file"]), /existing file or symlink/);
  assert.equal(await readFile(join(checkout, "config/local file"), "utf8"), "local nested config");
  assert.equal(await readFile(join(worktree, ".env"), "utf8"), "keep me");
});

test("remote link operations run on the device with literal positional paths", async () => {
  const calls: Array<{ program: string; args: string[] }> = [];
  const runner: CommandRunner = { run: async (program, args) => {
    calls.push({ program, args });
    return { stdout: program === "git" ? ".env\0node_modules/\0" : "", stderr: "", exitCode: 0 };
  } };
  const runtime = new GitRuntime({ ...local, id: "remote", type: "remote" }, { deviceId: "remote", transport: "ssh", config: { host: "remote" } }, runner);
  await runtime.linkWorktreePaths("/srv/base checkout", "/home/user/worktree", [".env", "node_modules"]);
  assert.deepEqual(calls.filter((call) => call.program === "sh").map((call) => call.args.slice(-3)), [
    ["/srv/base checkout", "/home/user/worktree", ".env"], ["/srv/base checkout", "/home/user/worktree", "node_modules"]
  ]);
});
