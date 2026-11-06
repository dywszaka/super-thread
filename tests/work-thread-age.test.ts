import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppSettings } from "../src/shared/app-settings";
import { DAY_MS, workThreadAge } from "../src/shared/work-thread-age";

const created = Date.parse("2026-11-01T12:30:00Z");
const thread = { createdAt: new Date(created).toISOString(), status: "active" as const };
const settings = defaultAppSettings();

test("age reminders change at elapsed 24-hour thresholds, independently of midnight", () => {
  for (const [elapsed, days, level] of [
    [0, 0, "normal"], [DAY_MS - 1, 0, "normal"], [DAY_MS, 1, "normal"],
    [3 * DAY_MS - 1, 2, "normal"], [3 * DAY_MS, 3, "reminder"],
    [7 * DAY_MS - 1, 6, "reminder"], [7 * DAY_MS, 7, "strong"]
  ] as const) {
    assert.deepEqual(workThreadAge(thread, settings, created + elapsed), { days, level });
  }
});

test("custom thresholds apply immediately and do not use document or activity timestamps", () => {
  const editedThread = { ...thread, updatedAt: new Date(created + 10 * DAY_MS).toISOString(), documentUpdatedAt: new Date(created + 10 * DAY_MS).toISOString() };
  assert.deepEqual(workThreadAge(editedThread, settings, created + 10 * DAY_MS), { days: 10, level: "strong" });
  assert.deepEqual(workThreadAge(thread, { ...settings, workThreadReminderDays: 14, workThreadStrongReminderDays: 21 }, created + 10 * DAY_MS), { days: 10, level: "normal" });
});

test("archiving hides age; restoring uses the original creation time", () => {
  assert.equal(workThreadAge({ ...thread, status: "archived" }, settings, created + 10 * DAY_MS), null);
  assert.deepEqual(workThreadAge(thread, settings, created + 10 * DAY_MS), { days: 10, level: "strong" });
});

test("future timestamps clamp to zero and invalid timestamps do not show reminders", () => {
  assert.deepEqual(workThreadAge(thread, settings, created - DAY_MS), { days: 0, level: "normal" });
  assert.equal(workThreadAge({ ...thread, createdAt: "invalid" }, settings, created), null);
  assert.equal(workThreadAge(thread, settings, Number.NaN), null);
});
