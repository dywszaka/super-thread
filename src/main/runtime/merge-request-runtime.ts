import type { Workspace } from "../../shared/domain";
import type { MergeRequestContext, WorkspaceMergeRequest, WorkspaceMergeRequestResult } from "../../shared/merge-request";
import type { CommandRunner } from "./command-runner";
import { interactiveLoginShellCommand, quoteShellArgument } from "./login-shell";

export function mergeRequestRepository(remote: string): { provider: "github" | "gitlab"; repository: string } | undefined {
  let url: URL;
  try {
    const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(remote);
    url = new URL(remote.includes("://") ? remote : scp ? `ssh://${scp[1]}/${scp[2]}` : remote);
  } catch { return undefined; }
  if (!["ssh:", "http:", "https:"].includes(url.protocol) || !url.hostname) return undefined;
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!path.includes("/") || path.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  const provider = url.hostname === "github.com" ? "github" : "gitlab";
  // SSH ports address Git transport, not the provider's HTTP API.
  const host = url.protocol === "ssh:" ? url.hostname : url.host;
  return { provider, repository: `https://${host}/${path}` };
}

export class MergeRequestRuntime {
  constructor(private readonly runner: CommandRunner) {}

  async inspect(workspace: Workspace): Promise<WorkspaceMergeRequest> {
    const branch = await this.git(workspace.path, ["branch", "--show-current"]);
    if (!branch) return { state: "unavailable", reason: "Check out a branch before creating an MR." };
    let targetBranch = workspace.baseBranch.replace(/^refs\/heads\//, "").replace(/^(?:refs\/remotes\/)?origin\//, "");
    if (targetBranch === "HEAD") {
      targetBranch = (await this.git(workspace.path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(/^origin\//, "");
    }
    if (!targetBranch || branch === targetBranch) return { state: "unavailable", reason: "Switch to a development branch to create an MR." };
    await this.git(workspace.path, ["check-ref-format", "--branch", targetBranch]);
    const remotes = (await this.git(workspace.path, ["remote"])).split("\n");
    if (!remotes.includes("origin")) return { state: "unavailable", reason: "This repository has no origin remote." };
    const remoteUrl = await this.git(workspace.path, ["remote", "get-url", "--push", "--all", "origin"]);
    if (remoteUrl.includes("\n")) return { state: "unavailable", reason: "MR creation requires a single origin push URL." };
    const repository = mergeRequestRepository(remoteUrl);
    if (!repository) return { state: "unavailable", reason: "MR creation requires a GitHub or GitLab remote." };
    const context: MergeRequestContext = { branch, targetBranch, remoteUrl, provider: repository.provider };
    const url = await this.existing(workspace.path, context);
    return url ? { state: "existing", url } : { state: "available", context };
  }

  async create(workspace: Workspace, expected: MergeRequestContext): Promise<WorkspaceMergeRequestResult> {
    const inspection = await this.inspect(workspace);
    if (inspection.state === "existing") return { url: inspection.url, created: false };
    if (inspection.state === "unavailable") throw new Error(inspection.reason);
    const context = inspection.context;
    if (Object.keys(context).some((key) => context[key as keyof MergeRequestContext] !== expected[key as keyof MergeRequestContext])) {
      throw new Error("The workspace branch or remote changed. Reopen Workspace actions and try again.");
    }
    const [branch, remoteUrl] = await Promise.all([
      this.git(workspace.path, ["branch", "--show-current"]),
      this.git(workspace.path, ["remote", "get-url", "--push", "--all", "origin"])
    ]);
    if (branch !== context.branch || remoteUrl !== context.remoteUrl) throw new Error("The workspace branch or remote changed. Reopen Workspace actions and try again.");
    const commit = await this.git(workspace.path, ["rev-parse", "--verify", `refs/heads/${context.branch}^{commit}`]);
    const title = await this.git(workspace.path, ["log", "-1", "--format=%s", commit]);
    // Pin the reviewed HEAD and use an explicit refspec: push.default and remote push
    // configuration must not publish other branches. Never force or stage files.
    await this.git(workspace.path, ["push", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", `${commit}:refs/heads/${context.branch}`], 120_000);
    try {
      const repository = mergeRequestRepository(context.remoteUrl)!.repository;
      const args = context.provider === "github"
        ? ["pr", "create", "--repo", repository, "--head", context.branch, "--base", context.targetBranch, "--title", title, "--body", ""]
        : ["mr", "create", "--repo", repository, "--source-branch", context.branch, "--target-branch", context.targetBranch, "--title", title, "--description", "", "--yes", "--push=false"];
      const output = await this.cli(workspace.path, context.provider, args);
      const url = output.split(/\s+/).findLast((word) => this.isRequestUrl(word, context.provider));
      if (!url) throw new Error("The provider did not return an MR URL.");
      return { url, created: true };
    } catch (error) {
      // Another client may have created it, or creation may have succeeded before a
      // network timeout. Reconcile against the provider before offering a retry.
      const url = await this.existing(workspace.path, context).catch(() => undefined);
      if (url) return { url, created: false };
      throw new Error(`Branch pushed, but MR creation failed. Retry to create the MR. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async existing(path: string, context: MergeRequestContext): Promise<string | undefined> {
    const repository = mergeRequestRepository(context.remoteUrl)!.repository;
    for (let page = 1; ; page++) {
      const limit = page * 100;
      const args = context.provider === "github"
        ? ["pr", "list", "--repo", repository, "--head", context.branch, "--state", "all", "--limit", String(limit), "--json", "url,isCrossRepository"]
        : ["mr", "list", "--repo", repository, "--source-branch", context.branch, "--all", "--per-page", "100", "--page", String(page), "--output", "json"];
      const entries: unknown = JSON.parse(await this.cli(path, context.provider, args));
      if (!Array.isArray(entries)) throw new Error("Invalid MR lookup response; creation is unavailable.");
      for (const entry of entries) {
        if (!entry || (context.provider === "github" ? typeof entry.isCrossRepository !== "boolean" : typeof entry.source_project_id !== "number" || typeof entry.target_project_id !== "number")) {
          throw new Error("Invalid MR source repository in lookup response.");
        }
        // A fork can use the same branch name. Only requests originating from
        // this push repository suppress its creation action.
        if (context.provider === "github" ? entry.isCrossRepository : entry.source_project_id !== entry.target_project_id) continue;
        const url = context.provider === "github" ? entry.url : entry.web_url;
        if (typeof url !== "string" || !this.isRequestUrl(url, context.provider)) throw new Error("Invalid MR URL in lookup response.");
        return url;
      }
      if (entries.length < (context.provider === "github" ? limit : 100)) return undefined;
    }
  }

  private isRequestUrl(value: string, provider: MergeRequestContext["provider"]): boolean {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && (provider === "github" ? /\/pull\/\d+$/.test(url.pathname) : /\/-\/merge_requests\/\d+$/.test(url.pathname));
    } catch { return false; }
  }

  private async cli(path: string, provider: MergeRequestContext["provider"], args: string[]): Promise<string> {
    const tool = provider === "github" ? "gh" : "glab";
    // GUI apps and non-interactive SSH shells may lack developer tools and auth
    // environment. Resolve both in the same login shell as embedded terminals.
    const marker = "__SUPERTHREAD_MR_OUTPUT__\n";
    const command = `command -v ${tool} >/dev/null || { printf '%s\\n' ${quoteShellArgument(`Install ${tool} and run ${tool} auth login on this device to use MR creation.`)} >&2; exit 127; }; printf '%s' ${quoteShellArgument(marker)}; exec ${[tool, ...args].map(quoteShellArgument).join(" ")}`;
    const result = await this.runner.run("sh", ["-lc", interactiveLoginShellCommand(command)], { cwd: path, timeoutMs: 30_000 });
    const start = result.stdout.indexOf(marker);
    return start < 0 ? result.stdout : result.stdout.slice(start + marker.length);
  }

  private git(path: string, args: string[], timeoutMs = 15_000): Promise<string> {
    return this.runner.run("git", ["-C", path, ...args], { timeoutMs }).then((result) => result.stdout);
  }
}
