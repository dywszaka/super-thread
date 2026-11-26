import { posix } from "node:path";
import type { CommandRunner } from "./command-runner";
import type { SubmoduleChange, WorkspaceChangeInspection, WorkspaceGitBaseline } from "../../shared/workspace-changes";

const DETAIL_LIMIT = 100;
const COMMIT_LIMIT = 20;

export class SubmoduleChanges {
  constructor(private readonly runner: CommandRunner) {}

  private async git(path: string, args: string[]): Promise<string> {
    return (await this.runner.run("git", ["-C", path, ...args], { preserveOutput: true })).stdout;
  }

  private async records(path: string, args: string[]): Promise<string[]> {
    return (await this.git(path, args)).split("\0").filter(Boolean);
  }

  private initialized(path: string): Promise<string[]> {
    return this.records(path, ["submodule", "foreach", "--quiet", "--recursive", 'printf \'%s\\0\' "$displaypath"']);
  }

  private async links(path: string, ref: string | undefined, initialized: Set<string>, index = false, prefix = "", warnings = new Map<string, string>()): Promise<Map<string, string>> {
    const links = new Map<string, string>();
    try {
      const entries = await this.records(path, index ? ["ls-files", "--stage", "-z"] : ["ls-tree", "-r", "-z", "--full-tree", ref!]);
      for (const entry of entries) {
        const match = (index ? /^160000 ([0-9a-f]+) [0-3]\t([\s\S]+)$/ : /^160000 commit ([0-9a-f]+)\t([\s\S]+)$/).exec(entry);
        if (!match) continue;
        const relative = match[2]!;
        const name = prefix ? `${prefix}/${relative}` : relative;
        links.set(name, match[1]!);
        if (initialized.has(name)) {
          for (const [nested, commit] of await this.links(posix.join(path, relative), match[1], initialized, index, name, warnings)) links.set(nested, commit);
        }
      }
    } catch {
      warnings.set(prefix, "Could not read recorded submodule versions");
    }
    return links;
  }

  async capture(path: string): Promise<WorkspaceGitBaseline> {
    const capturedAt = new Date().toISOString();
    try {
      const commit = (await this.git(path, ["rev-parse", "HEAD"])).trim();
      const initialized = new Set(await this.initialized(path));
      const warnings = new Map<string, string>();
      const links = await this.links(path, commit, initialized, false, "", warnings);
      // Direct-directory workspaces can begin with a checked-out version different from their recorded gitlink.
      const dirty = new Set<string>();
      for (const name of initialized) {
        const subPath = posix.join(path, name);
        links.set(name, (await this.git(subPath, ["rev-parse", "HEAD"])).trim());
        if ((await this.git(subPath, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=all"])).length) dirty.add(name);
      }
      return { commit, capturedAt, source: "created", submodules: [...links].map(([path, commit]) => ({ path, commit, ...(dirty.has(path) ? { dirty: true } : {}) })),
        ...(warnings.size ? { warning: "Some starting submodule versions could not be read" } : {}) };
    } catch {
      return { capturedAt, source: "unknown", warning: "Could not capture the starting versions" };
    }
  }

  async inspect(path: string, baseBranch: string, baseline: WorkspaceGitBaseline | undefined,
    isIncluded: (path: string, branch: string, base: string) => Promise<boolean>): Promise<WorkspaceChangeInspection> {
    if (!baseline) {
      try {
        baseline = { commit: (await this.git(path, ["merge-base", baseBranch, "HEAD"])).trim(), source: "inferred", capturedAt: new Date().toISOString(),
          warning: "Starting point inferred from current Git history; the original creation point is not known" };
      } catch {
        baseline = { source: "unknown", capturedAt: new Date().toISOString(), warning: "The original starting point could not be determined" };
      }
    }
    const result: WorkspaceChangeInspection = { baseline: { ...baseline }, submodules: [] };
    try {
      const initialized = new Set(await this.initialized(path));
      const startWarnings = new Map<string, string>();
      const currentWarnings = new Map<string, string>();
      const baseWarnings = new Map<string, string>();
      const [start, current, base] = await Promise.all([
        baseline.commit ? this.links(path, baseline.commit, initialized, false, "", startWarnings) : Promise.resolve(new Map<string, string>()),
        this.links(path, undefined, initialized, true, "", currentWarnings),
        this.links(path, baseBranch, initialized, false, "", baseWarnings)
      ]);
      // Keep recorded gitlinks separate from captured HEADs: an existing checkout mismatch is not new work.
      const startRecorded = new Map(start);
      for (const entry of baseline.submodules ?? []) start.set(entry.path, entry.commit);
      if (startWarnings.size) result.baseline.warning = [baseline.warning, "Some starting versions are unavailable"].filter(Boolean).join("; ");
      const affected = (warnings: Map<string, string>, name: string): boolean => [...warnings.keys()].some((prefix) => !prefix || name.startsWith(`${prefix}/`));
      const paths = [...new Set([...start.keys(), ...current.keys(), ...initialized])].sort();
      for (const name of paths) {
        const subPath = posix.join(path, name);
        const sub: SubmoduleChange = { path: name, initialized: initialized.has(name), startCommit: start.get(name), currentCommit: current.get(name),
          recordedCommit: current.get(name),
          hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0, files: [], commits: [] };
        const warnings: string[] = [];
        let statusKnown = true;
        if (affected(currentWarnings, name)) warnings.push("Could not verify the current submodule version");
        const startKnown = Boolean(baseline.commit || baseline.unborn) && !affected(startWarnings, name) && baseline.source !== "unknown";
        const startedDirty = baseline.submodules?.some((entry) => entry.path === name && entry.dirty);
        if (startedDirty) warnings.push("Started with uncommitted files; file changes cannot be attributed to this workspace");
        if (!startKnown) warnings.push("Starting version is uncertain");
        if (sub.initialized) {
          try {
            sub.currentCommit = (await this.git(subPath, ["rev-parse", "HEAD"])).trim();
            // Nested modules are inspected individually; their dirtiness is not a change to this module's own files.
            const status = await this.records(subPath, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
            for (let i = 0; i < status.length; i += 1) {
              const entry = status[i]!;
              if (entry.startsWith("??")) sub.hasUntrackedFiles = true;
              else sub.hasUncommittedChanges = true;
              sub.files!.push(entry.slice(3));
              if (/^[ RC][RC]/.test(entry.slice(0, 2)) || /^[RC]/.test(entry)) i += 1;
            }
          } catch { statusKnown = false; warnings.push("could not verify uncommitted changes or untracked files"); }
          try {
            const target = base.get(name);
            if (!target || affected(baseWarnings, name)) throw new Error("No base version");
            const tips = [...new Set(["HEAD", ...(sub.recordedCommit && sub.recordedCommit !== sub.currentCommit ? [sub.recordedCommit] : [])])];
            sub.unmergedCommitCount = Number.parseInt(await this.git(subPath, ["rev-list", "--count", ...tips, "--not", target]), 10) || 0;
            if (sub.unmergedCommitCount && (await Promise.all(tips.map((tip) => isIncluded(subPath, tip, target)))).every(Boolean)) sub.unmergedCommitCount = 0;
          } catch { warnings.push("could not verify commits against the submodule version recorded by the base branch"); }
          const detailRef = sub.currentCommit !== sub.startCommit ? sub.currentCommit
            : sub.recordedCommit !== startRecorded.get(name) ? sub.recordedCommit : sub.currentCommit;
          if (sub.startCommit && detailRef && detailRef !== sub.startCommit) {
            try {
              sub.files!.push(...await this.records(subPath, ["diff", "--name-only", "-z", sub.startCommit, detailRef, "--"]));
              const log = (await this.git(subPath, ["log", `--max-count=${COMMIT_LIMIT + 1}`, "--format=%H%x00%s", "-z", `${sub.startCommit}..${detailRef}`, "--"])).split("\0");
              if (log.at(-1) === "") log.pop();
              for (let i = 0; i + 1 < log.length; i += 2) sub.commits!.push({ hash: log[i]!, subject: log[i + 1]! });
            } catch { warnings.push("Could not read all changes since the starting version"); }
          }
        } else if (sub.currentCommit !== sub.startCommit && sub.currentCommit) {
          warnings.push("Not initialized; file and commit details could not be checked");
        }
        sub.activity = !startKnown || !statusKnown || startedDirty || affected(currentWarnings, name) ? "unknown"
          : !sub.currentCommit ? "removed" : !sub.startCommit ? "added"
          : sub.hasUncommittedChanges || sub.hasUntrackedFiles ? "modified"
          : sub.currentCommit !== sub.startCommit || sub.recordedCommit !== startRecorded.get(name) ? "version" : "unchanged";
        sub.files = [...new Set(sub.files)];
        sub.detailsTruncated = sub.files.length > DETAIL_LIMIT || sub.commits!.length > COMMIT_LIMIT;
        sub.files = sub.files.slice(0, DETAIL_LIMIT);
        sub.commits = sub.commits!.slice(0, COMMIT_LIMIT);
        if (warnings.length) sub.warning = warnings.join("; ");
        result.submodules.push(sub);
      }
      if (!paths.length && (currentWarnings.size || startWarnings.size || baseWarnings.size)) throw new Error("Incomplete submodule discovery");
    } catch {
      result.submodules.push({ path: ".", activity: "unknown", hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0,
        warning: "could not inspect submodules; they may contain uncommitted changes or unmerged commits" });
    }
    return result;
  }
}
