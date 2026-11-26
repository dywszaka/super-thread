import assert from "node:assert/strict";
import test from "node:test";
import { NativePanePresentation } from "../src/renderer/src/features/workspace/native-pane-presentation";
import { nativePaneSnapshotSchema } from "../src/shared/contract";
import type { BrowserLayoutInput } from "../src/shared/domain";

const input: BrowserLayoutInput = { id: "page", bounds: { x: 10, y: 80, width: 600, height: 400 } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const events: string[] = [];
  const capture = deferred<string | null>();
  const paint = deferred<void>();
  const presentation = new NativePanePresentation({
    layout: async (layout) => { events.push(`layout:${layout.id}:${layout.bounds.width}`); },
    prepareSnapshot: async () => { events.push("capture"); return capture.promise; },
    showSnapshot: (image) => { events.push(`image:${image}`); },
    painted: () => { events.push("paint"); return paint.promise; }
  });
  return { presentation, events, capture, paint };
}

test("overlay paints a snapshot before hiding the native surface and restores without capture", async () => {
  const { presentation, events, capture, paint } = fixture();
  const opening = presentation.update(input, true);
  assert.deepEqual(events, ["capture"]);
  capture.resolve("pixels");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["capture", "image:pixels", "paint"]);
  paint.resolve();
  await opening;
  assert.equal(events.at(-1), "layout:null:600");
  await presentation.update(input, false);
  assert.deepEqual(events.slice(-2), ["layout:page:600", "image:null"]);
});

test("closing a menu during capture cannot hide the restored page", async () => {
  const { presentation, events, capture, paint } = fixture();
  const opening = presentation.update(input, true);
  await presentation.update(input, false);
  capture.resolve("stale"); paint.resolve(); await opening;
  assert.deepEqual(events, ["capture", "layout:page:600", "image:null"]);
});

test("resize during capture uses one snapshot and only applies the latest bounds", async () => {
  const { presentation, events, capture, paint } = fixture();
  const first = presentation.update(input, true);
  const latest = presentation.update({ ...input, bounds: { ...input.bounds, width: 500 } }, true);
  capture.resolve("pixels"); paint.resolve();
  await Promise.all([first, latest]);
  assert.equal(events.filter((event) => event === "capture").length, 1);
  assert.deepEqual(events.filter((event) => event.startsWith("layout:")), ["layout:null:500"]);
});

test("unmount invalidates pending captures and releases the snapshot", async () => {
  const { presentation, events, capture, paint } = fixture();
  const opening = presentation.update(input, true);
  presentation.dispose(); capture.resolve("stale"); paint.resolve(); await opening;
  assert.deepEqual(events, ["capture", "image:null", "layout:null:0"]);
  await presentation.update(input, false);
  assert.equal(events.length, 3);
});

test("capture failure still yields the native surface to the overlay", async () => {
  const layouts: BrowserLayoutInput[] = [];
  const presentation = new NativePanePresentation({
    layout: async (layout) => { layouts.push(layout); },
    prepareSnapshot: async () => { throw Error("Page closed"); },
    showSnapshot() {}, painted: async () => {}
  });
  await presentation.update(input, true);
  assert.equal(layouts[0]?.id, null);
});

test("rapid reopening discards the earlier capture and disabled panes clear their image", async () => {
  const first = deferred<string | null>(), second = deferred<string | null>();
  const images: Array<string | null> = [], layouts: Array<string | null> = [];
  let captures = 0;
  const presentation = new NativePanePresentation({
    layout: async (layout) => { layouts.push(layout.id); },
    prepareSnapshot: () => (++captures === 1 ? first : second).promise,
    showSnapshot: (image) => { images.push(image); }, painted: async () => {}
  });
  const opening = presentation.update(input, true);
  await presentation.update(input, false);
  const reopening = presentation.update(input, true);
  second.resolve("new"); await reopening;
  first.resolve("old"); await opening;
  assert.deepEqual(images, [null, "new"]);
  assert.deepEqual(layouts, ["page", null]);
  await presentation.update({ ...input, id: null }, true);
  assert.equal(images.at(-1), null);
});

test("snapshot IPC accepts only a pane id and supported kind", () => {
  for (const kind of ["browser", "preview"]) assert.equal(nativePaneSnapshotSchema.safeParse({ id: "page", kind }).success, true);
  for (const value of [{ id: "", kind: "browser" }, { id: "page", kind: "window" }, { id: "page", kind: "browser", url: "file:///tmp" }]) {
    assert.equal(nativePaneSnapshotSchema.safeParse(value).success, false);
  }
});
