import os from "node:os";
import { basename, join, posix } from "node:path";
import type { Device, DeviceConnection } from "../../shared/domain";
import { DeviceCommandRunner, type CommandRunner } from "./command-runner";

export interface RepositoryInfo { root: string; name: string; remote: string; defaultBranch: string; }
export interface WorkspaceDeleteRisk { hasUncommittedChanges: boolean; hasUntrackedFiles: boolean; unmergedCommitCount: number; }

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

  async createWorktree(checkoutPath: string, projectName: string, workspaceName: string, baseBranch: string): Promise<{ path: string; branch: string }> {
    const home = await this.homeDirectory();
    const parent = this.device.type === "remote"
      ? posix.join(home, ".superthread", "workspaces", projectName)
      : join(home, ".superthread", "workspaces", projectName);
    const workspacePath = this.device.type === "remote" ? posix.join(parent, workspaceName) : join(parent, workspaceName);
    const branch = `work/${workspaceName}`;
    await this.runner.run("mkdir", ["-p", parent]);
    await this.git(checkoutPath, ["fetch", "--prune"], 10 * 60_000);
    await this.git(checkoutPath, ["worktree", "add", "-b", branch, workspacePath, baseBranch], 10 * 60_000);
    return { path: workspacePath, branch };
  }

  async inspectWorkspaceDeleteRisk(checkoutPath: string, workspacePath: string, branch: string, baseBranch: string): Promise<WorkspaceDeleteRisk> {
    await this.git(checkoutPath, ["fetch", "--prune"], 10 * 60_000);
    const [status, count] = await Promise.all([
      this.git(workspacePath, ["status", "--porcelain"]),
      this.git(checkoutPath, ["rev-list", "--count", `${baseBranch}..${branch}`])
    ]);
    const lines = status.split("\n").filter(Boolean);
    return {
      hasUncommittedChanges: lines.some((line) => !line.startsWith("??")),
      hasUntrackedFiles: lines.some((line) => line.startsWith("??")),
      unmergedCommitCount: Number.parseInt(count, 10) || 0
    };
  }

  async deleteWorktree(checkoutPath: string, workspacePath: string, branch: string, force: boolean): Promise<void> {
    await this.git(checkoutPath, ["worktree", "remove", ...(force ? ["--force"] : []), workspacePath]);
    await this.git(checkoutPath, ["branch", "-D", branch]);
  }

  private git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
    return this.runner.run("git", ["-C", cwd, ...args], { timeoutMs }).then((result) => result.stdout);
  }

  private async homeDirectory(): Promise<string> {
    if (this.device.type === "local") return os.homedir();
    const home = await this.runner.run("sh", ["-lc", "printf %s \"$HOME\""]);
    if (!home.stdout) throw new Error("Unable to resolve the remote home directory");
    return home.stdout;
  }
}
