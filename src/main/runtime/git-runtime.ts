import os from "node:os";
import { basename, join, posix } from "node:path";
import type { Device, DeviceConnection, WorkspaceLinkCandidate } from "../../shared/domain";
import { isWorkspaceLinkPath } from "../../shared/workspace-links";
import { projectCodeSchema } from "../../shared/project-code";
import { DeviceCommandRunner, type CommandRunner } from "./command-runner";
import { DirectoryRuntime } from "./directory-runtime";

export interface RepositoryInfo { root: string; name: string; remote?: string; defaultBranch?: string; }
export interface SubmoduleDeleteRisk {
  path: string;
  hasUncommittedChanges: boolean;
  hasUntrackedFiles: boolean;
  unmergedCommitCount: number;
  warning?: string;
}
export interface WorkspaceDeleteRisk {
  hasUncommittedChanges: boolean;
  hasUntrackedFiles: boolean;
  unmergedCommitCount: number;
  submodules?: SubmoduleDeleteRisk[];
}

export class GitRuntime {
  private readonly runner: CommandRunner;
  constructor(private readonly device: Device, private readonly connection: DeviceConnection, runner?: CommandRunner) {
    this.runner = runner ?? new DeviceCommandRunner(connection);
  }

  async inspect(repositoryPath: string): Promise<RepositoryInfo> {
    // Resolve the selected directory first: Git is optional, but an accessible directory is required.
    const root = await new DirectoryRuntime(this.device, this.connection, this.runner).resolve(repositoryPath);
    const name = (this.device.type === "remote" ? posix.basename(root) : basename(root)) || "project";
    const gitRoot = await this.runner.run("sh", ["-c", "git rev-parse --show-toplevel 2>/dev/null || :"], { cwd: root }).then((result) => result.stdout);
    // Importing a subdirectory must preserve that directory, rather than silently selecting its parent repository.
    if (gitRoot !== root) return { root, name };
    const [remote, branch] = await Promise.all([
      this.runner.run("sh", ["-c", "git remote get-url origin 2>/dev/null || :"], { cwd: root }).then((result) => result.stdout),
      this.runner.run("sh", ["-c", "git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || git branch --show-current"], { cwd: root })
        .then((result) => result.stdout.replace(/^origin\//, ""))
    ]);
    return { root, name, remote: remote || undefined, defaultBranch: branch || "HEAD" };
  }

  async clone(repositoryUrl: string, parentDirectory: string): Promise<RepositoryInfo> {
    const rawName = repositoryUrl.split(/[/:]/).at(-1)?.replace(/\.git$/, "") || "repository";
    const target = this.device.type === "remote" ? posix.join(parentDirectory, rawName) : join(parentDirectory, rawName);
    await this.runner.run("git", ["clone", repositoryUrl, target], { timeoutMs: 10 * 60_000 });
    return this.inspect(target);
  }

  async createWorktree(checkoutPath: string, projectCode: string, workspaceName: string, baseBranch: string): Promise<{ path: string; branch: string }> {
    projectCode = projectCodeSchema.parse(projectCode);
    const home = await this.homeDirectory();
    const parent = this.device.type === "remote"
      ? posix.join(home, ".superthread", "workspaces", projectCode)
      : join(home, ".superthread", "workspaces", projectCode);
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
    const [status, count, submodules] = await Promise.all([
      // Inspect submodule worktrees separately so a broken submodule cannot turn its warning into a hard failure here.
      this.git(workspacePath, ["status", "--porcelain", "--ignore-submodules=all"]),
      this.git(checkoutPath, ["rev-list", "--count", `${baseBranch}..${branch}`]),
      this.inspectSubmoduleDeleteRisks(workspacePath, baseBranch)
    ]);
    const lines = status.split("\n").filter(Boolean);
    let unmergedCommitCount = Number.parseInt(count, 10) || 0;
    if (unmergedCommitCount > 0 && await this.isMergeAlreadyIncluded(checkoutPath, branch, baseBranch)) unmergedCommitCount = 0;
    return {
      hasUncommittedChanges: lines.some((line) => !line.startsWith("??")),
      hasUntrackedFiles: lines.some((line) => line.startsWith("??")),
      unmergedCommitCount,
      ...(submodules.length ? { submodules } : {})
    };
  }

  private async inspectSubmoduleDeleteRisks(workspacePath: string, baseBranch: string): Promise<SubmoduleDeleteRisk[]> {
    const risks: SubmoduleDeleteRisk[] = [];
    try {
      // foreach visits only checked-out submodules. NUL records preserve unusual paths on local and SSH devices.
      const paths = await this.gitRecords(workspacePath, ["submodule", "foreach", "--quiet", "--recursive", 'printf \'%s\\0\' "$displaypath"']);
      if (!paths.length) return risks;
      const baseCommits = new Map<string, string | undefined>();
      const baseTrees = new Map<string, Map<string, string>>();
      for (const path of paths.sort((a, b) => a.length - b.length)) {
        const risk: SubmoduleDeleteRisk = { path, hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0 };
        risks.push(risk);
        const submodulePath = posix.join(workspacePath, path);
        try {
          const status = await this.gitRecords(submodulePath, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
          risk.hasUncommittedChanges = status.some((entry) => !entry.startsWith("??"));
          risk.hasUntrackedFiles = status.some((entry) => entry.startsWith("??"));
        } catch {
          risk.warning = "could not verify uncommitted changes or untracked files";
        }
        try {
          // Resolve nested gitlinks through the version recorded by the base, never through the workspace index.
          const parent = [...baseCommits.keys()].filter((entry) => path.startsWith(`${entry}/`)).sort((a, b) => b.length - a.length)[0];
          const parentPath = parent ? posix.join(workspacePath, parent) : workspacePath;
          const parentRef = parent ? baseCommits.get(parent) : baseBranch;
          if (!parentRef) throw new Error("No base submodule version");
          const treeKey = parent ?? "";
          let tree = baseTrees.get(treeKey);
          if (!tree) {
            tree = new Map((await this.gitRecords(parentPath, ["ls-tree", "-r", "-z", "--full-tree", parentRef])).flatMap((entry) => {
              const match = /^160000 commit ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
              return match ? [[match[2]!, match[1]!] as const] : [];
            }));
            baseTrees.set(treeKey, tree);
          }
          const baseCommit = tree.get(parent ? path.slice(parent.length + 1) : path);
          baseCommits.set(path, baseCommit);
          if (!baseCommit) throw new Error("Submodule is absent from the base");
          const count = await this.git(submodulePath, ["rev-list", "--count", `${baseCommit}..HEAD`]);
          risk.unmergedCommitCount = Number.parseInt(count, 10) || 0;
          if (risk.unmergedCommitCount > 0 && await this.isMergeAlreadyIncluded(submodulePath, "HEAD", baseCommit)) risk.unmergedCommitCount = 0;
        } catch {
          if (!baseCommits.has(path)) baseCommits.set(path, undefined);
          risk.warning = [risk.warning, "could not verify commits against the submodule version recorded by the base branch"].filter(Boolean).join("; ");
        }
      }
    } catch {
      // An incomplete submodule check is a warning users can approve, rather than a permanent deletion block.
      risks.push({ path: ".", hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0, warning: "could not inspect submodules; they may contain uncommitted changes or unmerged commits" });
    }
    return risks;
  }

  private async gitRecords(cwd: string, args: string[]): Promise<string[]> {
    const { stdout } = await this.runner.run("git", ["-C", cwd, ...args], { preserveOutput: true });
    return stdout.split("\0").filter(Boolean);
  }

  private async isMergeAlreadyIncluded(checkoutPath: string, branch: string, baseBranch: string): Promise<boolean> {
    try {
      // Squash merges lose ancestry. A clean merge that leaves the base tree unchanged
      // proves the workspace adds no content, even if the base has since advanced.
      // merge-tree writes only Git objects, leaving both worktrees and indexes untouched.
      const [mergedTree, baseTree] = await Promise.all([
        this.git(checkoutPath, ["merge-tree", "--write-tree", baseBranch, branch]),
        this.git(checkoutPath, ["rev-parse", `${baseBranch}^{tree}`])
      ]);
      return Boolean(baseTree) && mergedTree === baseTree;
    } catch {
      // Conflicts, older Git versions and command failures must retain the warning.
      return false;
    }
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
