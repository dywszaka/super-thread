import os from "node:os";
import { basename, join, posix } from "node:path";
import type { Device, DeviceConnection, WorkspaceLinkCandidate } from "../../shared/domain";
import { isWorkspaceLinkPath } from "../../shared/workspace-links";
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
    await this.git(checkoutPath, ["worktree", "add", "-b", branch, workspacePath, baseBranch], 10 * 60_000);
    return { path: workspacePath, branch };
  }

  async listWorkspaceLinkCandidates(checkoutPath: string): Promise<WorkspaceLinkCandidate[]> {
    // Without exclude flags, Git includes ignored entries and collapses entirely untracked directories.
    const { stdout } = await this.runner.run("git", ["-C", checkoutPath, "ls-files", "--others", "--directory", "-z"], { preserveOutput: true });
    return stdout.split("\0").filter(Boolean).map((entry): WorkspaceLinkCandidate => ({
      path: entry.replace(/\/$/, ""), kind: entry.endsWith("/") ? "directory" : "file"
    })).filter((entry) => isWorkspaceLinkPath(entry.path)).sort((left, right) => left.path.localeCompare(right.path));
  }

  async linkWorktreePaths(checkoutPath: string, workspacePath: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    if (paths.length > 256 || paths.some((path) => !isWorkspaceLinkPath(path)) || new Set(paths).size !== paths.length) {
      throw new Error("Invalid workspace link selection");
    }
    const available = new Set((await this.listWorkspaceLinkCandidates(checkoutPath)).map((entry) => entry.path));
    for (const path of paths) {
      if (!available.has(path)) throw new Error(`Cannot link ${path}: it is no longer an untracked checkout entry`);
      if (paths.some((other) => path.startsWith(`${other}/`))) throw new Error(`Overlapping workspace link paths: ${path}`);
    }
    for (const path of paths) {
      // Positional arguments preserve filenames on both local and SSH devices. Never follow a target parent symlink.
      await this.runner.run("sh", ["-c", `
set -eu
source_path="$1/$3"
target_path="$2/$3"
if [ ! -e "$source_path" ] && [ ! -L "$source_path" ]; then
  printf 'Cannot link missing checkout entry: %s\\n' "$3" >&2; exit 1
fi
parent="$2"
remaining="$3"
while [ "\${remaining#*/}" != "$remaining" ]; do
  parent="$parent/\${remaining%%/*}"
  remaining="\${remaining#*/}"
  if [ -L "$parent" ] || { [ -e "$parent" ] && [ ! -d "$parent" ]; }; then
    printf 'Cannot link through existing file or symlink: %s\\n' "$parent" >&2; exit 1
  fi
  if [ ! -d "$parent" ]; then mkdir "$parent"; fi
done
if [ -e "$target_path" ] || [ -L "$target_path" ]; then
  printf 'Workspace link destination already exists: %s\\n' "$3" >&2; exit 1
fi
ln -s "$source_path" "$target_path"
`, "workspace-link", checkoutPath, workspacePath, path]);
    }
  }

  async inspectWorkspaceDeleteRisk(checkoutPath: string, workspacePath: string, branch: string, baseBranch: string): Promise<WorkspaceDeleteRisk> {
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
    if (posix.resolve(checkoutPath) === posix.resolve(workspacePath)) {
      throw new Error("Cannot delete the base checkout as a workspace worktree");
    }
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
