import type { Workspace } from "../../shared/domain";
import { parseGitRemote } from "../../shared/git-hosting";
import type { GitMergeRequestPreparation } from "../../shared/merge-request";
import type { CommandRunner } from "./command-runner";
import { GitHostingError } from "./git-hosting-client";

/** Git runs on the workspace device; provider API calls never do. */
export class MergeRequestRuntime {
  constructor(private readonly runner: CommandRunner) {}

  async prepare(workspace: Workspace): Promise<GitMergeRequestPreparation | { state: "unavailable"; reason: string }> {
    const branch = await this.git(workspace.path, ["branch", "--show-current"]);
    if (!branch) return { state: "unavailable", reason: "Check out a development branch before creating an MR." };
    const remotes = (await this.git(workspace.path, ["remote"])).split("\n");
    if (!remotes.includes("origin")) return { state: "unavailable", reason: "This repository has no origin remote." };
    let targetBranch = workspace.baseBranch.replace(/^refs\/heads\//, "").replace(/^(?:refs\/remotes\/)?origin\//, "");
    if (targetBranch === "HEAD") targetBranch = (await this.git(workspace.path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(/^origin\//, "");
    if (!targetBranch || branch === targetBranch) return { state: "unavailable", reason: "Switch to a development branch to create an MR." };
    await this.git(workspace.path, ["check-ref-format", "--branch", targetBranch]);
    const remoteUrl = await this.git(workspace.path, ["remote", "get-url", "--push", "--all", "origin"]);
    if (remoteUrl.includes("\n")) return { state: "unavailable", reason: "MR creation requires a single origin push URL." };
    const remote = parseGitRemote(remoteUrl);
    if (!remote) return { state: "unavailable", reason: "Use a GitHub or GitLab origin URL without embedded credentials." };
    const headCommit = await this.git(workspace.path, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    const [defaultTitle, status] = await Promise.all([
      this.git(workspace.path, ["log", "-1", "--no-show-signature", "--no-notes", "--no-decorate", "--format=%s", headCommit]),
      this.git(workspace.path, ["status", "--porcelain"])
    ]);
    return { branch, targetBranch, remoteUrl, headCommit, defaultTitle, hasUncommittedChanges: Boolean(status), remote };
  }

  async push(workspace: Workspace, expected: GitMergeRequestPreparation): Promise<void> {
    const current = await this.prepare(workspace);
    if ("state" in current || ["branch", "targetBranch", "remoteUrl", "headCommit"].some((key) => current[key as keyof GitMergeRequestPreparation] !== expected[key as keyof GitMergeRequestPreparation])) {
      throw new GitHostingError("validation", "The branch, commit, target, or remote changed. Refresh and review before creating the MR.");
    }
    try {
      // Pin the URL and commit; never consume configured push refspecs or force.
      await this.git(workspace.path, ["push", "--no-follow-tags", "--recurse-submodules=no", "--", expected.remoteUrl, `${expected.headCommit}:refs/heads/${expected.branch}`], 120_000);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      const reason = /non-fast-forward|fetch first/i.test(detail) ? "the remote branch contains history that must be reconciled"
        : /permission denied|publickey|authentication failed|could not read username/i.test(detail) ? "Git authentication was denied; check the device's SSH key or credential helper"
        : /could not resolve|connection refused|timed out|network is unreachable/i.test(detail) ? "the remote could not be reached from this device"
        : /protected branch|hook declined|pre-receive/i.test(detail) ? "the remote branch policy or hook rejected the push"
        : "check the device connection, Git authentication, branch permissions, and remote history";
      throw new GitHostingError("git", `Git push failed on the workspace device: ${reason}. Open a repair terminal, then retry. No force push was attempted.`);
    }
  }

  private git(path: string, args: string[], timeoutMs = 15_000): Promise<string> {
    return this.runner.run("git", ["-C", path, ...args], { timeoutMs }).then((result) => result.stdout);
  }
}
