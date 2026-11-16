import assert from "node:assert/strict";
import test from "node:test";
import type { WorkThread, Workspace } from "../src/shared/domain";
import { filterWorkThreads, workThreadTimeCutoff } from "../src/renderer/src/features/workspace/work-thread-filters";
import { WorkThreadSearch } from "../src/renderer/src/features/workspace/work-thread-search";

const thread = (id: string, overrides: Partial<WorkThread> = {}): WorkThread => ({
  id, name: id, status: "active", pinned: false, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z", ...overrides
});

test("project filters include multiple projects/devices, archived threads and retained history without duplicates", () => {
  const threads = [thread("multi"), thread("archived", { status: "archived" }), thread("finished", { projectIds: ["p1", "p2"] }), thread("empty")];
  const workspaces = [
    { workThreadId: "multi", projectId: "p1" }, { workThreadId: "multi", projectId: "p1" },
    { workThreadId: "multi", projectId: "p2" }, { workThreadId: "archived", projectId: "p1" }, { projectId: "p1" }
  ] as Workspace[];
  const ids = (projectId: string) => filterWorkThreads(threads, workspaces, projectId, null).map((item) => item.id);
  assert.deepEqual(ids(""), ["multi", "archived", "finished", "empty"]);
  assert.deepEqual(ids("p1"), ["multi", "archived", "finished"]);
  assert.deepEqual(ids("p2"), ["multi", "finished"]);
  assert.deepEqual(ids("missing"), []);
});

test("time filters use saved document time or creation time, with an inclusive cutoff", () => {
  const cutoff = Date.parse("2026-11-09T00:00:00Z");
  const threads = [
    thread("old"), thread("recent", { documentUpdatedAt: "2026-11-10T00:00:00Z" }),
    thread("boundary", { documentUpdatedAt: "2026-11-09T00:00:00Z" }),
    thread("before", { documentUpdatedAt: "2026-11-08T23:59:59.999Z" }),
    thread("new", { createdAt: "2026-11-11T00:00:00Z" }), thread("invalid", { createdAt: "invalid" })
  ];
  assert.deepEqual(filterWorkThreads(threads, [], "", cutoff).map((item) => item.id), ["recent", "boundary", "new"]);
  assert.equal(filterWorkThreads(threads, [], "", null).length, threads.length);
});

test("recent weeks are rolling seven-day windows; months clamp local month ends and leap years", () => {
  const now = new Date(2026, 10, 16, 15, 30).getTime();
  assert.equal(workThreadTimeCutoff("all", 1, now), null);
  assert.equal(workThreadTimeCutoff("weeks", 2, now), now - 14 * 24 * 60 * 60 * 1000);
  for (const [year, months, expectedYear, expectedMonth, expectedDay] of [[2026, 1, 2026, 1, 28], [2024, 1, 2024, 1, 29], [2026, 3, 2025, 11, 31]]) {
    const result = new Date(workThreadTimeCutoff("months", months!, new Date(year!, 2, 31, 15, 30).getTime())!);
    assert.equal(result.getTime(), new Date(expectedYear!, expectedMonth!, expectedDay!, 15, 30).getTime());
  }
});

test("project, time, and document search combine before status counts and preserve global ordering", () => {
  const threads = [
    thread("archived", { status: "archived", projectIds: ["p1"], document: "needle", documentUpdatedAt: "2026-11-15T00:00:00Z" }),
    thread("active", { projectIds: ["p1"], name: "Needle", documentUpdatedAt: "2026-11-14T00:00:00Z" }),
    thread("other-project", { projectIds: ["p2"], document: "needle", documentUpdatedAt: "2026-11-16T00:00:00Z" }),
    thread("old", { projectIds: ["p1"], document: "needle" }),
    thread("other-text", { projectIds: ["p1"], documentUpdatedAt: "2026-11-16T00:00:00Z" })
  ];
  const filtered = filterWorkThreads(threads, [], "p1", Date.parse("2026-11-09T00:00:00Z"));
  const results = new WorkThreadSearch().search(filtered, "needle");
  assert.deepEqual(results.all.map(({ thread }) => thread.id), ["archived", "active"]);
  assert.equal(results.active.length, 1);
  assert.equal(results.archived.length, 1);
});
