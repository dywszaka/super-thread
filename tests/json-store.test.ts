import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStore } from "../src/main/persistence/json-store";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/domain";

test("JsonStore creates, updates, and reloads an atomic snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-store-"));
  const path = join(directory, "state.json");
  const store = new JsonStore(path);
  const initial = await store.load();
  assert.equal(initial.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(initial.projects, []);

  await store.update((draft) => {
    draft.projects.push({ id: "p1", name: "demo", repositoryUrl: "git@example/demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
  });

  const reloaded = new JsonStore(path);
  assert.equal((await reloaded.load()).projects[0]?.name, "demo");
  const persisted = await readFile(path, "utf8");
  assert.doesNotThrow(() => JSON.parse(persisted));
});

test("JsonStore migrates older snapshots without clearing user data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-legacy-store-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: CURRENT_SCHEMA_VERSION - 1,
    projects: [{ id: "legacy-project", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "then", updatedAt: "then" }],
    sessions: [{ id: "session-1", workspaceId: "workspace-1", name: "Terminal 1", status: "running", shell: "/bin/zsh", createdAt: "then" }]
  }), "utf8");

  const snapshot = await new JsonStore(path).load();

  assert.equal(snapshot.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(snapshot.projects[0]?.id, "legacy-project");
  assert.equal(snapshot.sessions[0]?.kind, "shell");
  assert.equal(snapshot.sessions[0]?.activityStatus, "idle");
});
