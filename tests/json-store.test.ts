import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStore } from "../src/main/persistence/json-store";

test("JsonStore creates, updates, and reloads an atomic snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-store-"));
  const path = join(directory, "state.json");
  const store = new JsonStore(path);
  const initial = await store.load();
  assert.deepEqual(initial.projects, []);

  await store.update((draft) => {
    draft.projects.push({ id: "p1", name: "demo", repositoryUrl: "git@example/demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
  });

  const reloaded = new JsonStore(path);
  assert.equal((await reloaded.load()).projects[0]?.name, "demo");
  const persisted = await readFile(path, "utf8");
  assert.doesNotThrow(() => JSON.parse(persisted));
});
