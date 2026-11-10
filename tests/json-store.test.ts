import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStore } from "../src/main/persistence/json-store";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/domain";
import { defaultAppSettings } from "../src/shared/app-settings";

test("schema 14 gains default settings without rewriting documents, TODOs, or creation time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-settings-migration-"));
  const path = join(directory, "state.json");
  const thread = { id: "old", name: "Existing", status: "active", pinned: true, document: "\n# Keep\n", documentUpdatedAt: "2026-10-29T00:00:00Z", createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", todos: [{ id: "todo", title: "Keep", date: "2026-11-06", createdAt: "then", updatedAt: "then" }] };
  await writeFile(path, JSON.stringify({ schemaVersion: 14, workThreads: [thread] }));
  const loaded = await new JsonStore(path).load();
  assert.deepEqual(loaded.settings, defaultAppSettings());
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.workThreads[0])), thread);
  assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, CURRENT_SCHEMA_VERSION);
});

test("persisted linked and standalone workspaces keep their ownership and tabs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-workspace-ownership-"));
  const path = join(directory, "state.json");
  const workspace = { name: "demo", projectId: "project", deviceId: "device", checkoutId: "checkout", kind: "worktree", path: "/tmp/demo", branch: "work/demo", baseBranch: "main", status: "ready", createdAt: "then", updatedAt: "then" };
  const workspaces = [
    { ...workspace, id: "linked", workThreadId: "thread" },
    { ...workspace, id: "standalone" }
  ];
  const browserTabs = [{ id: "browser", workspaceId: "standalone", title: "Browser", url: "https://example.com", order: 0, createdAt: "then", updatedAt: "then" }];
  await writeFile(path, JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, workspaces, browserTabs }));
  const snapshot = await new JsonStore(path).load();
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.workspaces)), workspaces);
  assert.deepEqual(snapshot.browserTabs, browserTabs);
});

test("JsonStore creates, updates, and reloads an atomic snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-store-"));
  const path = join(directory, "state.json");
  const store = new JsonStore(path);
  const initial = await store.load();
  assert.equal(initial.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(initial.projects, []);

  await store.update((draft) => {
    draft.projects.push({ id: "p1", name: "demo", code: "demo", repositoryUrl: "git@example/demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
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
    workThreads: [
      { id: "legacy-thread", name: "Legacy", status: "active", createdAt: "then", updatedAt: "then" },
      { id: "legacy-high-thread", name: "Legacy High", status: "active", priority: "high", createdAt: "then", updatedAt: "then" }
    ],
    projects: [{ id: "legacy-project", name: "demo", repositoryUrl: "git@example.com:demo.git", defaultBranch: "main", createdAt: "then", updatedAt: "then" }],
    sessions: [{ id: "session-1", workspaceId: "workspace-1", name: "Terminal 1", status: "running", shell: "/bin/zsh", codexResultUnread: true, createdAt: "then" }]
  }), "utf8");

  const snapshot = await new JsonStore(path).load();

  assert.equal(snapshot.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(snapshot.projects[0]?.id, "legacy-project");
  assert.equal(snapshot.workThreads[0]?.pinned, false);
  assert.equal(snapshot.workThreads[1]?.pinned, true);
  assert.equal(snapshot.workThreads[0]?.document, "");
  assert.equal(snapshot.sessions[0]?.kind, "shell");
  assert.equal(snapshot.sessions[0]?.activityStatus, "waiting-input");
  assert.equal(snapshot.sessions[0]?.resultUnread, true);
  assert.equal(snapshot.sessions[0]?.codexResultUnread, undefined);
});

test("JsonStore migrates legacy embedded tmux terminals to one workspace session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-tmux-store-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: CURRENT_SCHEMA_VERSION - 1,
    workspaces: [{
      id: "workspace-1", name: "demo", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "/tmp/demo", branch: "work/demo", baseBranch: "main", status: "ready",
      createdAt: "then", updatedAt: "then"
    }],
    sessions: [
      { id: "tmux-1", workspaceId: "workspace-1", name: "tmux 1", status: "running", kind: "tmux", shell: "tmux", tmuxSessionName: "demo", createdAt: "then" },
      { id: "shell-1", workspaceId: "workspace-1", name: "Terminal 1", status: "running", kind: "shell", shell: "/bin/zsh", createdAt: "then" }
    ]
  }), "utf8");

  const snapshot = await new JsonStore(path).load();

  assert.equal(snapshot.workspaces[0]?.tmuxSessionName, "demo");
  assert.deepEqual(snapshot.sessions.map((session) => session.id), ["shell-1"]);
});

test("concurrent autosave and runtime updates preserve both changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-concurrent-store-"));
  const path = join(directory, "state.json");
  const store = new JsonStore(path);
  await store.load();
  await Promise.all([
    store.update((draft) => { draft.workThreads.push({ id: "thread", name: "Notes", status: "active", pinned: false, document: "# Notes", createdAt: "now", updatedAt: "now" }); }),
    store.update((draft) => { draft.devices.push({ id: "local", name: "Mac", type: "local", status: "online", createdAt: "now" }); }),
    store.update((draft) => { draft.workThreads[0]!.document = "# Latest notes"; })
  ]);
  const persisted = await new JsonStore(path).load();
  assert.equal(persisted.workThreads[0]?.document, "# Latest notes");
  assert.equal(persisted.devices[0]?.id, "local");
});

test("a rejected mutation does not poison subsequent saves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-retry-store-"));
  const store = new JsonStore(join(directory, "state.json"));
  await store.load();
  await assert.rejects(store.update(() => { throw new Error("Invalid update"); }), /Invalid update/);
  await store.update((draft) => { draft.devices.push({ id: "local", name: "Mac", type: "local", status: "online", createdAt: "now" }); });
  assert.equal(store.snapshot().devices[0]?.id, "local");
});

test("removed Codex tabs migrate to stopped shells without probing or losing their directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-removed-codex-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 12,
    sessions: [{ id: "old-codex", workspaceId: "workspace", name: "Keep my tab", kind: "codex", shell: "codex",
      status: "running", pid: 999, cwd: "/srv/project", codexConversationId: "saved-id", activityStatus: "busy",
      createdAt: "then", tmuxWindowKey: "legacy-key" }]
  }));
  const snapshot = await new JsonStore(path).load();
  const session = snapshot.sessions[0]!;
  assert.equal(session.id, "old-codex");
  assert.equal(session.name, "Keep my tab");
  assert.equal(session.cwd, "/srv/project");
  assert.equal(session.kind, "shell");
  assert.equal(session.status, "exited");
  assert.equal(session.pid, undefined);
  assert.equal(session.activityStatus, undefined);
  assert.equal(session.codexConversationId, "saved-id");
  assert.equal("tmuxWindowKey" in session, false);
  assert.deepEqual(JSON.parse(JSON.stringify((await new JsonStore(path).load()).sessions)), JSON.parse(JSON.stringify(snapshot.sessions)));
  assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, CURRENT_SCHEMA_VERSION);
});

test("schema 15 backfills unique project codes from remote names without changing historical workspaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "superthread-project-code-migration-"));
  const path = join(directory, "state.json");
  const project = { name: "Display name", createdAt: "then", updatedAt: "then" };
  const workspaces = [{ id: "old-workspace", projectId: "p1", checkoutId: "checkout", deviceId: "device", kind: "worktree", name: "feature", path: "/home/me/.superthread/workspaces/proj_old/feature", branch: "work/feature", baseBranch: "main", status: "ready", createdAt: "then", updatedAt: "then" }];
  await writeFile(path, JSON.stringify({ schemaVersion: 15, projects: [
    { ...project, id: "p1", repositoryUrl: "git@github.com:team/demo.git" },
    { ...project, id: "p2", repositoryUrl: "https://example.com/team/demo.git/" },
    { ...project, id: "p3", repositoryUrl: "ssh://git@example.com/team/DEMO.git" },
    { ...project, id: "p4", name: "Notes" },
    { ...project, id: "p5", name: "../unsafe" },
    { ...project, id: "p6", code: "demo-2" }
  ], workspaces }));
  const snapshot = await new JsonStore(path).load();
  assert.deepEqual(snapshot.projects.map((item) => item.code), ["demo", "demo-3", "DEMO-4", "Notes", "..-unsafe", "demo-2"]);
  assert.equal(snapshot.projects[0]!.name, "Display name");
  assert.equal(snapshot.projects[0]!.updatedAt, "then");
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.workspaces)), workspaces);
  assert.deepEqual((await new JsonStore(path).load()).projects, snapshot.projects);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(persisted.workspaces, workspaces);
  assert.deepEqual(persisted.projects, snapshot.projects);
});
