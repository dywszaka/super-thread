import assert from "node:assert/strict";
import test from "node:test";
import { resolveSelectionId } from "../src/renderer/src/features/workspace/selection";

test("workspace selection adopts the first project added after the dialog mounts", () => {
  assert.equal(resolveSelectionId("", null, []), "");
  assert.equal(resolveSelectionId("", null, [{ id: "project-1" }]), "project-1");
});

test("workspace selection preserves valid choices and replaces stale ones", () => {
  const items = [{ id: "project-1" }, { id: "project-2" }];
  assert.equal(resolveSelectionId("project-2", "project-1", items), "project-2");
  assert.equal(resolveSelectionId("missing", "project-1", items), "project-1");
  assert.equal(resolveSelectionId("missing", "also-missing", items), "project-1");
});
