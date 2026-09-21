import { basename, dirname, join, posix } from "node:path";
import type { Device, DeviceConnection } from "../../shared/domain";
import { DeviceCommandRunner, type CommandRunner } from "./command-runner";

export interface RepositoryInfo { root: string; name: string; remote: string; defaultBranch: string; }

export class GitRuntime {
  private readonly runner: CommandRunner;
  constructor(private readonly device: Device, connection: DeviceConnection, runner?: CommandRunner) {
    this.runner = runner ?? new DeviceCommandRunner(connection);
  }

  async inspect(repositoryPath: string): Promise<RepositoryInfo> {
    const [root, remote, branch] = await Promise.all([
      this.git(repositoryPath, ["rev-parse", "--show-toplevel"]),
      this.git(repositoryPath, ["remote", "get-url", "origin"]),
      this.git(repositoryPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .then((value) => value.replace(/^origin\//, ""))
        .catch(() => this.git(repositoryPath, ["branch", "--show-current"]))
    ]);
    return { root, name: this.device.type === "remote" ? posix.basename(root) : basename(root), remote, defaultBranch: branch || "main" };
  }

  async clone(repositoryUrl: string, parentDirectory: string): Promise<RepositoryInfo> {
    const rawName = repositoryUrl.split(/[/:]/).at(-1)?.replace(/\.git$/, "") || "repository";
    const target = this.device.type === "remote" ? posix.join(parentDirectory, rawName) : join(parentDirectory, rawName);
    await this.runner.run("git", ["clone", repositoryUrl, target], { timeoutMs: 10 * 60_000 });
    return this.inspect(target);
  }

  async createWorktree(checkoutPath: string, name: string, baseBranch: string): Promise<{ path: string; branch: string }> {
    const parent = this.device.type === "remote"
      ? posix.join(posix.dirname(checkoutPath), ".superthread-workspaces")
      : join(dirname(checkoutPath), ".superthread-workspaces");
    const workspacePath = this.device.type === "remote" ? posix.join(parent, name) : join(parent, name);
    const branch = `work/${name}`;
    await this.runner.run("mkdir", ["-p", parent]);
    await this.git(checkoutPath, ["fetch", "--prune"], 10 * 60_000);
    await this.git(checkoutPath, ["worktree", "add", "-b", branch, workspacePath, baseBranch], 10 * 60_000);
    return { path: workspacePath, branch };
  }

  async hasChanges(workspacePath: string): Promise<boolean> {
    return (await this.git(workspacePath, ["status", "--porcelain"])).length > 0;
  }

  async deleteWorktree(checkoutPath: string, workspacePath: string, force: boolean): Promise<void> {
    await this.git(checkoutPath, ["worktree", "remove", ...(force ? ["--force"] : []), workspacePath]);
  }

  private git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
    return this.runner.run("git", ["-C", cwd, ...args], { timeoutMs }).then((result) => result.stdout);
  }
}
