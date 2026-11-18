export interface WorkspaceGitBaseline {
  commit?: string;
  source: "created" | "inferred" | "unknown";
  capturedAt: string;
  submodules?: Array<{ path: string; commit: string; dirty?: boolean }>;
  warning?: string;
}

export interface SubmoduleChange {
  path: string;
  hasUncommittedChanges: boolean;
  hasUntrackedFiles: boolean;
  unmergedCommitCount: number;
  warning?: string;
  activity?: "unchanged" | "modified" | "version" | "added" | "removed" | "unknown";
  initialized?: boolean;
  startCommit?: string;
  currentCommit?: string;
  recordedCommit?: string;
  files?: string[];
  commits?: Array<{ hash: string; subject: string }>;
  detailsTruncated?: boolean;
}

export interface WorkspaceChangeInspection {
  baseline: WorkspaceGitBaseline;
  submodules: SubmoduleChange[];
}

export interface WorkspaceChangeRecord {
  workspaceId: string;
  name: string;
  projectName: string;
  deviceName: string;
  path: string;
  branch: string;
  checkedAt: string;
  keepsDirectory: boolean;
  risks: string[];
  changes?: WorkspaceChangeInspection;
  outcome: "pending" | "deleted" | "failed";
  updatedAt: string;
  error?: string;
}

export const submoduleActivityLabel = (activity: SubmoduleChange["activity"]): string => ({
  unchanged: "No changes found", modified: "Changes involved", version: "Version changed",
  added: "Added", removed: "Removed", unknown: "Cannot determine"
})[activity ?? "unknown"];

export function submoduleStateLabel(change: SubmoduleChange): string {
  if (change.activity === "removed") return "Removed from workspace";
  const parts: string[] = [];
  if (change.initialized === false) parts.push("Not initialized");
  if (change.hasUncommittedChanges) parts.push("Uncommitted changes");
  if (change.hasUntrackedFiles) parts.push("Untracked files");
  if (change.unmergedCommitCount) parts.push(`${change.unmergedCommitCount} commit(s) not included in current base`);
  if (!parts.length) parts.push(change.warning ? "Check incomplete" : "Clean · included in current base");
  return parts.join(" · ");
}

const plain = (text: string): string => text.replace(/[\r\n]/g, " ").replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");

export function workspaceChangesMarkdown(record: Omit<WorkspaceChangeRecord, "outcome" | "updatedAt" | "checkedAt"> & { checkedAt?: string; outcome?: WorkspaceChangeRecord["outcome"] }): string {
  const lines = [`## Workspace changes: ${plain(record.name)}`, "",
    `- Project: ${plain(record.projectName)}`, `- Device: ${plain(record.deviceName)}`,
    `- Workspace: ${plain(record.path)}`, `- Branch: ${plain(record.branch)}`,
    `- Checked: ${record.checkedAt ?? "Unknown"}`,
    `- Directory: ${record.keepsDirectory ? "Kept" : "Removed on successful deletion"}`,
    `- Result: ${record.outcome === "deleted" ? "Deleted" : record.outcome === "failed" ? "Failed" : record.outcome === "pending" ? "Deletion started; result unconfirmed" : "Preview"}`];
  if (record.error) lines.push(`- Error: ${plain(record.error)}`);
  const changes = record.changes;
  if (changes) {
    lines.push(`- Starting point: ${changes.baseline.source} · ${changes.baseline.commit ?? "unknown"}`);
    if (changes.baseline.warning) lines.push(`- Starting point warning: ${plain(changes.baseline.warning)}`);
    lines.push("", "This is a change summary, not a complete history of edits that were later reverted.");
    for (const sub of changes.submodules) {
      lines.push("", `### ${plain(sub.path)} — ${submoduleActivityLabel(sub.activity)}`,
        `- State: ${submoduleStateLabel(sub)}`,
        `- Version: ${sub.startCommit ?? "unknown / absent"} → ${sub.currentCommit ?? "unknown / absent"}`);
      if (sub.recordedCommit && sub.recordedCommit !== sub.currentCommit) lines.push(`- Version recorded in parent index: ${sub.recordedCommit}`);
      if (sub.warning) lines.push(`- Warning: ${plain(sub.warning)}`);
      if (sub.files?.length) lines.push("- Files:", ...sub.files.map((path) => `  - ${plain(path)}`));
      if (sub.commits?.length) lines.push("- Commits since starting point:", ...sub.commits.map((commit) => `  - ${commit.hash.slice(0, 12)} ${plain(commit.subject)}`));
      if (sub.detailsTruncated) lines.push("- Details truncated; totals and warnings still apply.");
    }
    if (!changes.submodules.length) lines.push("", "No submodules found.");
  }
  if (record.risks.length) lines.push("", "### Deletion warnings", ...record.risks.map((risk) => `- ${plain(risk)}`));
  return `${lines.join("\n")}\n`;
}
