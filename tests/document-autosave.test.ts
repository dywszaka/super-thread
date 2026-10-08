import assert from "node:assert/strict";
import test from "node:test";
import { DocumentAutosave } from "../src/renderer/src/features/workspace/document-autosave";

const recoveryStorage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
};

test("autosave coalesces rapid edits and preserves Markdown whitespace", async () => {
  const saved: string[] = [];
  const document = new DocumentAutosave("a", "", async (content) => { saved.push(content); }, undefined, 10);
  document.edit("first");
  document.edit("# 标题\n\n  - note  \n");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(saved, ["# 标题\n\n  - note  \n"]);
  assert.equal(document.getSnapshot().status, "saved");
});

test("edits during an in-flight write are serialized and the latest content wins", async () => {
  const saved: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const document = new DocumentAutosave("a", "", async (content) => {
    saved.push(content);
    if (content === "first") await gate;
  });
  document.edit("first");
  const flush = document.flush();
  document.edit("latest");
  const secondFlush = document.flush();
  release();
  await Promise.all([flush, secondFlush]);
  assert.deepEqual(saved, ["first", "latest"]);
  assert.equal(document.getSnapshot().content, "latest");
  assert.equal(document.getSnapshot().status, "saved");
});

test("failed saves retain a recovery draft across reload and support retry", async () => {
  const storage = recoveryStorage();
  const document = new DocumentAutosave("a", "persisted", async () => { throw new Error("Disk full"); }, storage);
  document.edit("unsaved");
  await document.flush();
  assert.equal(document.getSnapshot().status, "error");
  const saved: string[] = [];
  const recovered = new DocumentAutosave("a", "persisted", async (content) => { saved.push(content); }, storage);
  assert.equal(recovered.getSnapshot().content, "unsaved");
  await recovered.flush();
  assert.deepEqual(saved, ["unsaved"]);
  assert.equal(storage.getItem("superthread-document-draft:a"), null);
});

test("switching threads flushes each document to its own destination", async () => {
  const saved = new Map<string, string>();
  const a = new DocumentAutosave("a", "", async (content) => { saved.set("a", content); });
  const b = new DocumentAutosave("b", "", async (content) => { saved.set("b", content); });
  a.edit("A notes");
  const leavingA = a.flush();
  b.edit("B notes");
  await Promise.all([leavingA, b.flush()]);
  assert.equal(saved.get("a"), "A notes");
  assert.equal(saved.get("b"), "B notes");
});
