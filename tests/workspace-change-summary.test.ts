import assert from "node:assert/strict";
import test from "node:test";
import { workspaceChangesMarkdown, type WorkspaceChangeRecord } from "../src/shared/workspace-changes";

test("Markdown summaries retain outcomes, versions and code details while escaping repository-provided text", () => {
  const record: WorkspaceChangeRecord = {
    workspaceId: "one", name: "Workspace <script>", projectName: "Project", deviceName: "Mac", path: "/work/one", branch: "work/one", checkedAt: "2026-11-18T01:00:00Z",
    keepsDirectory: false, risks: ["Submodule warning"], outcome: "failed", updatedAt: "now", error: "Git failed",
    changes: { baseline: { source: "inferred", capturedAt: "start", commit: "a".repeat(40), warning: "Original point unknown" }, submodules: [
      { path: "deps/<core>", activity: "version", initialized: true, hasUncommittedChanges: true, hasUntrackedFiles: true, unmergedCommitCount: 2,
        startCommit: "b".repeat(40), currentCommit: "c".repeat(40), files: ["file\n# Heading"], commits: [{ hash: "c".repeat(40), subject: "Code [link](bad)" }], detailsTruncated: true }
    ] }
  };
  const text = workspaceChangesMarkdown(record);
  for (const value of ["Result: Failed", "Git failed", "Original point unknown", "Version changed", "Uncommitted changes", "Untracked files", "2 commit(s)", "bbbbbbbb", "cccccccc", "Details truncated"]) assert.ok(text.includes(value), value);
  assert.equal(text.includes("<script>"), false);
  assert.equal(text.includes("\n# Heading"), false);
  assert.match(text, /not a complete history/);
  assert.match(workspaceChangesMarkdown({ ...record, outcome: "pending" }), /result unconfirmed/);
});
