import assert from "node:assert/strict";
import test from "node:test";
import { workspaceChangesMarkdown, type WorkspaceChangeRecord } from "../src/shared/workspace-changes";

test("Markdown summaries retain outcomes, versions and code details while escaping repository-provided text", () => {
  const record: WorkspaceChangeRecord = {
    workspaceId: "one", name: "Workspace <script>", projectName: "Project", deviceName: "Mac", path: "/work/one", branch: "work/one", checkedAt: "2026-11-18T01:00:00Z",
    keepsDirectory: false, risks: ["Submodule warning"], outcome: "failed", updatedAt: "now", error: "Git failed",
    changes: { baseline: { source: "inferred", capturedAt: "start", commit: "a".repeat(40), warning: "Original point unknown" }, repository: { currentCommit: "d".repeat(40), commits: [{ hash: "d".repeat(40), subject: "期间工作 <script> [link](bad)" }], warning: "History rewritten" }, submodules: [
      { path: "deps/<core>", activity: "version", initialized: true, hasUncommittedChanges: true, hasUntrackedFiles: true, unmergedCommitCount: 2,
        startCommit: "b".repeat(40), currentCommit: "c".repeat(40), files: ["file\n# Heading"], commits: [{ hash: "c".repeat(40), subject: "Code [link](bad)" }], detailsTruncated: true }
    ] }
  };
  const text = workspaceChangesMarkdown(record);
  for (const value of ["Result: Failed", "Git failed", "Original point unknown", "Version changed", "Uncommitted changes", "Untracked files", "2 commit(s)", "bbbbbbbb", "cccccccc", "Details truncated"]) assert.ok(text.includes(value), value);
  assert.equal(text.includes("<script>"), false);
  assert.equal(text.includes("\n# Heading"), false);
  assert.match(text, /not a complete history/);
  assert.ok(text.includes(`- ${"d".repeat(40)} 期间工作 \\<script\\> \\[link\\](bad)`));
  assert.match(text, /Repository commits/);
  assert.match(text, /History rewritten/);
  assert.match(workspaceChangesMarkdown({ ...record, outcome: "pending" }), /result unconfirmed/);
  const legacy = structuredClone(record);
  delete legacy.changes!.repository;
  assert.match(workspaceChangesMarkdown(legacy), /were not collected/);
  const empty = structuredClone(record);
  empty.changes!.repository = { currentCommit: "a".repeat(40), commits: [] };
  assert.match(workspaceChangesMarkdown(empty), /No commits since starting point/);
});
