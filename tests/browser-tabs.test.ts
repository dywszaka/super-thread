import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";
import type { TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import { normalizeBrowserUrl, isBrowserUrl } from "../src/shared/browser-url";
import { browserCommandSchema, browserLayoutSchema, createBrowserSchema, navigateBrowserSchema, reorderWorkspaceTabsSchema } from "../src/shared/contract";
import { emptySnapshot } from "../src/shared/domain";

async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), "superthread-browser-")), "state.json");
  const snapshot = emptySnapshot();
  snapshot.workThreads.push({ id: "thread", name: "Browser", status: "active", pinned: false, createdAt: "then", updatedAt: "then" });
  snapshot.workspaces.push({ id: "workspace", workThreadId: "thread", name: "browser", projectId: "project", deviceId: "dev_local", checkoutId: "checkout", kind: "main", path: "/tmp", branch: "main", baseBranch: "main", status: "ready", createdAt: "then", updatedAt: "then" });
  snapshot.sessions.push({ id: "terminal", workspaceId: "workspace", name: "Terminal", order: 0, status: "exited", shell: "zsh", createdAt: "then" });
  await writeFile(path, JSON.stringify(snapshot));
  const terminals = Object.assign(new EventEmitter(), { has: () => false }) as unknown as TerminalRuntime;
  const store = new JsonStore(path);
  const service = new WorkspaceService(store, terminals, undefined, undefined, { sync() {}, reconnectAll() {}, stop() {} });
  await service.initialize();
  return { service, path, store };
}

test("browser addresses allow only network pages and normalize local addresses", () => {
  for (const [input, expected] of [
    ["example.com/path?q=one#two", "https://example.com/path?q=one#two"],
    [" localhost:3000 ", "http://localhost:3000/"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/"],
    ["127.1:8080", "http://127.0.0.1:8080/"],
    ["[0:0:0:0:0:0:0:1]:8000", "http://[::1]:8000/"],
    ["[::1]:8000/page", "http://[::1]:8000/page"],
    ["HTTPS://example.com", "https://example.com/"]
  ]) assert.equal(normalizeBrowserUrl(input!), expected);
  for (const input of ["", "file:///tmp", "javascript:alert(1)", "data:text/html,hi", "ftp://example.com", "https://user:pass@example.com", "https://", "example.com\\evil"]) {
    assert.throws(() => normalizeBrowserUrl(input));
  }
  assert.equal(isBrowserUrl("example.com"), false);
  assert.equal(isBrowserUrl("file:///tmp"), false);
});

test("browser IPC validates addresses, commands, bounds and duplicate IDs", () => {
  assert.equal(createBrowserSchema.parse({ workspaceId: "workspace", url: "example.com" }).url, "https://example.com/");
  assert.equal(navigateBrowserSchema.safeParse({ id: "b", url: "file:///tmp" }).success, false);
  assert.equal(browserCommandSchema.safeParse({ id: "b", command: "execute" }).success, false);
  assert.equal(browserLayoutSchema.safeParse({ id: "b", bounds: { x: -1, y: 0, width: 100, height: 100 } }).success, false);
  assert.equal(browserLayoutSchema.safeParse({ id: "b", bounds: { x: 0, y: 0, width: Infinity, height: 100 } }).success, false);
  assert.equal(reorderWorkspaceTabsSchema.safeParse({ workspaceId: "workspace", tabIds: ["b", "b"] }).success, false);
});

test("multiple browser tabs preserve independent addresses, titles and mixed order across restart", async () => {
  const { service, path } = await fixture();
  const [first, second] = await Promise.all([
    service.createBrowser({ workspaceId: "workspace", url: "example.com" }),
    service.createBrowser({ workspaceId: "workspace" })
  ]);
  assert.deepEqual([first.order, second.order], [1, 2]);
  await service.navigateBrowser({ id: second.id, url: "localhost:3000" });
  assert.equal(service.snapshot().browserTabs[1]?.url, "http://localhost:3000/");
  await service.updateBrowserPage(first.id, { url: "https://example.com/redirect#hash", title: "Latest page" });
  await service.reorderWorkspaceTabs({ workspaceId: "workspace", tabIds: [second.id, "terminal", first.id] });
  const restored = await new JsonStore(path).load();
  assert.equal(restored.browserTabs[0]?.url, "https://example.com/redirect#hash");
  assert.equal(restored.browserTabs[0]?.title, "Latest page");
  assert.equal(restored.browserTabs[0]?.order, 2);
  assert.equal(restored.browserTabs[1]?.order, 0);
  assert.equal(restored.sessions[0]?.order, 1);
  assert.equal(restored.sessions[0]?.status, "exited");
  assert.equal(restored.sessions.length, 1);
});

test("mixed tab order rejects missing, duplicate and foreign tabs atomically", async () => {
  const { service } = await fixture();
  const browser = await service.createBrowser({ workspaceId: "workspace" });
  for (const tabIds of [["terminal"], ["terminal", "terminal"], [browser.id, "foreign"]]) {
    await assert.rejects(service.reorderWorkspaceTabs({ workspaceId: "workspace", tabIds }), /every tab/);
  }
  assert.equal(service.snapshot().sessions[0]?.order, 0);
  assert.equal(service.snapshot().browserTabs[0]?.order, 1);
  await assert.rejects(service.createBrowser({ workspaceId: "missing" }), /not found/);
});

test("closing removes a browser and stale navigation cannot recreate it; deleting workspace cleans both kinds", async () => {
  const { service, path } = await fixture();
  const first = await service.createBrowser({ workspaceId: "workspace", url: "example.com" });
  const second = await service.createBrowser({ workspaceId: "workspace", url: "localhost:3000" });
  await service.closeBrowser(first.id);
  await service.updateBrowserPage(first.id, { url: "https://example.com/stale" });
  await assert.rejects(service.navigateBrowser({ id: first.id, url: "example.com" }), /no longer exists/);
  assert.deepEqual((await new JsonStore(path).load()).browserTabs.map((tab) => tab.id), [second.id]);
  await service.deleteWorkspace("workspace");
  const restored = await new JsonStore(path).load();
  assert.deepEqual(restored.browserTabs, []);
  assert.deepEqual(restored.sessions, []);
  assert.deepEqual(restored.workspaces, []);
});

test("legacy snapshots gain browser collection and retain terminal ordering", async () => {
  const { path } = await fixture();
  const snapshot = await new JsonStore(path).load();
  const { browserTabs: _browserTabs, ...legacy } = snapshot;
  legacy.schemaVersion = 10;
  legacy.sessions.push({ ...legacy.sessions[0]!, id: "terminal-2", order: 0 });
  await writeFile(path, JSON.stringify(legacy));
  const restored = await new JsonStore(path).load();
  assert.deepEqual(restored.browserTabs, []);
  assert.deepEqual(restored.sessions.map((session) => session.order), [0, 1]);
});
