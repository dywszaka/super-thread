import assert from "node:assert/strict";
import test from "node:test";
import { terminalCloseOptions } from "../src/main/application/terminal-close-confirmation";

test("idle terminals close or quit without a confirmation", () => {
  for (const action of ["quit", "close"] as const) {
    assert.equal(terminalCloseOptions({ running: [], unchecked: [] }, action), undefined);
  }
});

test("confirmation identifies every terminal and program without truncating the list", () => {
  const running = Array.from({ length: 12 }, (_, i) => `workspace / Terminal ${i + 1} — node`);
  const options = terminalCloseOptions({ running, unchecked: [] }, "quit")!;
  assert.match(options.message!, /Programs are still running/);
  for (const line of running) assert.ok(options.detail!.includes(line));
  assert.deepEqual(options.buttons, ["Quit Super Thread", "Cancel"]);
  assert.equal(options.defaultId, 1);
  assert.equal(options.cancelId, 1);
  assert.deepEqual(terminalCloseOptions({ running, unchecked: [] }, "close")!.buttons, ["Close Terminal", "Cancel"]);
});

test("an inconclusive check is separated from confirmed running programs", () => {
  const unchecked = ["workspace / Terminal 1 — SSH unavailable"];
  const options = terminalCloseOptions({ running: [], unchecked }, "quit")!;
  assert.equal(options.message, "Terminal activity could not be checked");
  assert.doesNotMatch(options.detail!, /Programs still running/);
  const mixed = terminalCloseOptions({ running: ["workspace / Terminal 2 — vim"], unchecked }, "quit")!;
  assert.match(mixed.detail!, /Programs still running:[\s\S]*Terminal 2[\s\S]*Could not check these terminals:[\s\S]*Terminal 1/);
});
