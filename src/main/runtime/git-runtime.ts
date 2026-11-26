import os from "node:os";
import { lstat, realpath } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import type { Device, DeviceConnection, WorkspaceLinkCandidate } from "../../shared/domain";
import { isWorkspaceLinkPath } from "../../shared/workspace-links";
import { projectCodeSchema } from "../../shared/project-code";
import { DeviceCommandRunner, type CommandRunner } from "./command-runner";
import { DirectoryRuntime } from "./directory-runtime";
import { SubmoduleChanges } from "./submodule-changes";
import type { SubmoduleChange, WorkspaceChangeInspection, WorkspaceGitBaseline } from "../../shared/workspace-changes";

export interface RepositoryInfo { root: string; name: string; remote?: string; defaultBranch?: string; }
export type SubmoduleDeleteRisk = SubmoduleChange;
export interface WorkspaceDeleteRisk {
  hasUncommittedChanges: boolean;
  hasUntrackedFiles: boolean;
  unmergedCommitCount: number;
  submodules?: SubmoduleDeleteRisk[];
  changes?: WorkspaceChangeInspection;
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
    const parent = await new DirectoryRuntime(this.device, this.connection, this.runner).resolve(parentDirectory);
    const target = this.device.type === "remote" ? posix.join(parent, rawName) : join(parent, rawName);
    await this.runner.run("git", ["clone", "--", repositoryUrl, target], { timeoutMs: 10 * 60_000 });
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

  async inspectWorkspaceDeleteRisk(checkoutPath: string, workspacePath: string, branch: string, baseBranch: string, baseline?: WorkspaceGitBaseline): Promise<WorkspaceDeleteRisk> {
    const base = await this.refreshDeletionBase(checkoutPath, baseBranch);
    const [status, count, changes] = await Promise.all([
      // Inspect submodule worktrees separately so a broken submodule cannot turn its warning into a hard failure here.
      this.git(workspacePath, ["status", "--porcelain", "--ignore-submodules=all"]),
      this.git(checkoutPath, ["rev-list", "--count", `${base}..${branch}`]),
      this.inspectWorkspaceChanges(workspacePath, base, baseline)
    ]);
    const lines = status.split("\n").filter(Boolean);
    let unmergedCommitCount = Number.parseInt(count, 10) || 0;
    if (unmergedCommitCount > 0 && await this.isMergeAlreadyIncluded(checkoutPath, branch, base)) unmergedCommitCount = 0;
    return {
      hasUncommittedChanges: lines.some((line) => !line.startsWith("??")),
      hasUntrackedFiles: lines.some((line) => line.startsWith("??")),
      unmergedCommitCount,
      submodules: changes.submodules, changes
    };
  }

  private async refreshDeletionBase(checkoutPath: string, baseBranch: string): Promise<string> {
    const ref = await this.git(checkoutPath, ["rev-parse", "--symbolic-full-name", baseBranch]);
    if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/remotes/")) return baseBranch;
    let remote: string | undefined;
    let source: string | undefined;
    let target: string | undefined;
    if (ref.startsWith("refs/heads/")) {
      const branches = await this.git(checkoutPath, ["for-each-ref", "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)", ref]);
      const upstream = branches.split("\n").map((line) => line.split("\0")).find(([name]) => name === ref);
      if (upstream?.[1]) {
        [, remote, source, target] = upstream;
        // A local upstream has no remote to refresh.
        if (remote === ".") return baseBranch;
      }
    }
    if (!remote) {
      const remotes = (await this.git(checkoutPath, ["remote"])).split("\n").filter(Boolean);
      if (ref.startsWith("refs/remotes/")) {
        const name = ref.slice("refs/remotes/".length);
        remote = remotes.sort((a, b) => b.length - a.length).find((item) => name.startsWith(`${item}/`));
        if (!remote) throw new Error(`Cannot resolve the remote for base branch "${baseBranch}"`);
        source = `refs/heads/${name.slice(remote.length + 1)}`;
        target = ref;
      } else if (remotes.includes("origin")) {
        remote = "origin";
        source = ref;
        target = `refs/remotes/origin/${ref.slice("refs/heads/".length)}`;
      } else return baseBranch;
    }
    if (!source || !target?.startsWith("refs/remotes/")) throw new Error(`Cannot resolve the remote base branch "${baseBranch}"`);
    try {
      // Fetch refs only: never pull into the checkout or change either index.
      // Pin one commit so concurrent inspections cannot change this comparison's base.
      await this.git(checkoutPath, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--", remote, `+${source}:${target}`], 30_000);
      return await this.git(checkoutPath, ["rev-parse", "--verify", `${target}^{commit}`]);
    } catch (error) {
      throw new Error(`Unable to refresh base branch "${baseBranch}" from "${remote}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async captureWorkspaceBaseline(workspacePath: string): Promise<WorkspaceGitBaseline> {
    if (!await this.workspaceHead(workspacePath)) return { source: "created", unborn: true, capturedAt: new Date().toISOString(), submodules: [] };
    return new SubmoduleChanges(this.runner).capture(workspacePath);
  }

  private async workspaceHead(path: string): Promise<string | undefined> {
    try { return await this.git(path, ["rev-parse", "--verify", "HEAD^{commit}"]); }
    catch (error) {
      // Distinguish a valid, empty repository from inaccessible or corrupt Git data.
      if (await this.git(path, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw error;
      const ref = await this.git(path, ["symbolic-ref", "--quiet", "HEAD"]);
      if (await this.git(path, ["for-each-ref", "--format=%(refname)", ref])) throw error;
      return undefined;
    }
  }

  async inspectWorkspaceChanges(workspacePath: string, baseBranch: string, baseline?: WorkspaceGitBaseline): Promise<WorkspaceChangeInspection> {
    // Pin HEAD before reading history so the saved range describes one specific endpoint.
    const currentCommit = await this.workspaceHead(workspacePath);
    if (!currentCommit && baseline?.unborn) return { baseline: { ...baseline }, repository: { commits: [] }, submodules: [] };
    const changes = await new SubmoduleChanges(this.runner).inspect(workspacePath, baseBranch, baseline, (path, branch, base) => this.isMergeAlreadyIncluded(path, branch, base));
    const repository: NonNullable<WorkspaceChangeInspection["repository"]> = { currentCommit, commits: [] };
    changes.repository = repository;
    if ((!changes.baseline.commit && !changes.baseline.unborn) || changes.baseline.source === "unknown") {
      repository.warning = "The starting commit is unknown; commits from this workspace's lifetime cannot be determined.";
      return changes;
    }
    if (!currentCommit) {
      if (changes.baseline.commit) throw new Error("Could not collect repository commits: HEAD no longer has a commit.");
      return changes;
    }
    try {
      // Keep the full list independently of today's merge/deletion risks. Missing objects or
      // failed history reads must block cleanup rather than save a misleading empty list.
      const range = changes.baseline.unborn ? currentCommit : `${changes.baseline.commit}..${currentCommit}`;
      const { stdout } = await this.runner.run("git", ["-C", workspacePath, "log", "--no-color", "--no-decorate", "--no-show-signature", "--no-notes", "--encoding=UTF-8", "--format=%H%x00%s", "-z", range, "--"], { preserveOutput: true });
      const fields = stdout.split("\0");
      if (fields.at(-1) === "") fields.pop();
      if (fields.length % 2) throw new Error("Incomplete commit history output");
      for (let i = 0; i < fields.length; i += 2) repository.commits.push({ hash: fields[i]!, subject: fields[i + 1]! });
    } catch (error) {
      throw new Error(`Could not collect repository commits: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (changes.baseline.commit) {
      try { await this.git(workspacePath, ["merge-base", "--is-ancestor", changes.baseline.commit, currentCommit]); }
      catch { repository.warning = "Current history no longer descends from the starting commit. Rebased or switched history may include earlier work; commits no longer reachable from HEAD are excluded."; }
    }
    return changes;
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
    await this.deleteBranchIfPresent(checkoutPath, branch);
  }

  private async removalRegistration(checkoutPath: string, workspacePath: string, canonicalPath: string, branch: string): Promise<boolean> {
    const listing = await this.git(checkoutPath, ["worktree", "list", "--porcelain", "-z"]);
    const paths = new Set([posix.resolve(workspacePath), canonicalPath]);
    const entry = listing.split("\0\0").map((record) => record.split("\0")).find((fields) => fields[0]?.startsWith("worktree ") && paths.has(posix.resolve(fields[0].slice(9))));
    if (entry && !entry.includes(`branch refs/heads/${branch}`)) throw new Error("The worktree registration has changed. Review this directory before deleting it.");
    return Boolean(entry);
  }

  async inspectWorktreeRemoval(checkoutPath: string, workspacePath: string, branch: string): Promise<"intact" | "directory" | "missing"> {
    return (await this.worktreeRemovalState(checkoutPath, workspacePath, branch)).state;
  }

  private async worktreeRemovalState(checkoutPath: string, workspacePath: string, branch: string): Promise<{ state: "intact" | "directory" | "missing"; registered: boolean }> {
    const containsCheckout = (path: string, checkout: string): boolean => path === checkout || checkout.startsWith(`${path.replace(/\/$/, "")}/`);
    if (!posix.isAbsolute(workspacePath) || containsCheckout(posix.resolve(workspacePath), posix.resolve(checkoutPath))) {
      throw new Error("Cannot delete the base checkout as a workspace worktree");
    }
    let state: { exists: boolean; git: boolean; symbolic: boolean; path: string; checkout: string };
    if (this.connection.transport === "local") {
      const stat = async (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const resolvePath = async (path: string): Promise<string> => realpath(path).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return join(await resolvePath(posix.dirname(path)), basename(path));
      });
      const directory = await stat(workspacePath);
      state = { exists: Boolean(directory), symbolic: Boolean(directory?.isSymbolicLink()),
        git: Boolean(directory && !directory.isSymbolicLink() && await stat(join(workspacePath, ".git"))),
        path: await resolvePath(workspacePath), checkout: await realpath(checkoutPath) };
    } else {
      // lstat distinguishes a removed directory from permission and connection errors. Never
      // interpret a failed SSH/stat command as evidence that cleanup has already succeeded.
      const result = await this.runner.run("python3", ["-c", `
import json, os, stat, sys
def probe(path):
    try: return os.lstat(path)
    except FileNotFoundError: return None
path, checkout = sys.argv[1:]
info = probe(path)
symbolic = info is not None and stat.S_ISLNK(info.st_mode)
print(json.dumps(dict(exists=info is not None, symbolic=symbolic,
    git=bool(info is not None and not symbolic and probe(os.path.join(path, '.git'))),
    path=os.path.realpath(path), checkout=os.path.realpath(checkout))))
`, workspacePath, checkoutPath], { timeoutMs: 15_000 });
      state = JSON.parse(result.stdout);
      if (typeof state.exists !== "boolean" || typeof state.git !== "boolean" || typeof state.symbolic !== "boolean" || typeof state.checkout !== "string" || typeof state.path !== "string") throw new Error("Could not verify the remaining workspace directory");
    }
    if (state.symbolic || containsCheckout(state.path, state.checkout)) throw new Error("Refusing to clean up a symlink or the base checkout directory");
    const registered = await this.removalRegistration(checkoutPath, workspacePath, state.path, branch);
    return { state: !state.exists ? "missing" : registered && state.git ? "intact" : "directory", registered };
  }

  async resumeWorktreeDeletion(checkoutPath: string, workspacePath: string, branch: string): Promise<void> {
    const { state, registered } = await this.worktreeRemovalState(checkoutPath, workspacePath, branch);
    if (state === "intact") throw new Error("The worktree is available again. Refresh the deletion checks before retrying.");
    try {
      if (registered) {
        await this.git(checkoutPath, ["worktree", "remove", "--force", workspacePath]);
      } else if (state === "directory") {
        await this.runner.run("rm", ["-rf", "--", workspacePath]);
      }
      if (await this.inspectWorktreeRemoval(checkoutPath, workspacePath, branch) !== "missing") throw new Error("The workspace directory still exists");
      await this.deleteBranchIfPresent(checkoutPath, branch);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}. Cleanup is incomplete. If directory removal needs elevated permissions, remove "${workspacePath}" on this device, then refresh and retry deletion or Finish.`);
    }
  }

  private async deleteBranchIfPresent(checkoutPath: string, branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`;
    const refs = await this.git(checkoutPath, ["for-each-ref", "--format=%(refname)", ref]);
    if (refs.split("\n").includes(ref)) await this.git(checkoutPath, ["branch", "-D", "--", branch]);
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
