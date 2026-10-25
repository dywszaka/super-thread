import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";
import { previewByteResponse, renderPreviewMarkdown, staticPreviewCsp } from "../src/main/runtime/file-preview-content";
import type { TerminalRuntime } from "../src/main/runtime/terminal-runtime";
import { workspaceFileInputSchema } from "../src/shared/contract";
import { CURRENT_SCHEMA_VERSION, emptySnapshot } from "../src/shared/domain";

test("preview tabs deduplicate canonical paths, mix ordering, restore metadata, and clean up with workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "preview-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "report.md"), "# Report");
  await symlink(join(root, "report.md"), join(root, "alias.md"));
  await writeFile(join(root, "not-supported.ts"), "text");
  const snapshot = emptySnapshot();
  snapshot.workThreads.push({ id: "thread", name: "Preview", status: "active", pinned: false, createdAt: "then", updatedAt: "then" });
  snapshot.workspaces.push({ id: "workspace", workThreadId: "thread", projectId: "project", deviceId: "dev_local", checkoutId: "checkout", kind: "main", path: root, name: "preview", branch: "main", baseBranch: "main", status: "ready", createdAt: "then", updatedAt: "then" });
  snapshot.sessions.push({ id: "terminal", workspaceId: "workspace", name: "Terminal", order: 0, status: "exited", shell: "zsh", createdAt: "then" });
  const path = join(root, "state.json");
  const { filePreviewTabs: _previews, ...legacy } = snapshot;
  await writeFile(path, JSON.stringify({ ...legacy, schemaVersion: 13 }));
  const service = new WorkspaceService(new JsonStore(path), Object.assign(new EventEmitter(), { has: () => false }) as unknown as TerminalRuntime, undefined, undefined, { sync() {}, reconnectAll() {}, setReconnectEnabled() {}, stop() {} });
  await service.initialize();
  assert.deepEqual(service.snapshot().filePreviewTabs, []);
  const [first, duplicate] = await Promise.all([service.openFilePreview({ workspaceId: "workspace", path: "report.md" }), service.openFilePreview({ workspaceId: "workspace", path: "alias.md" })]);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.order, 1);
  const browser = await service.createBrowser({ workspaceId: "workspace" });
  assert.equal(browser.order, 2);
  await service.reorderWorkspaceTabs({ workspaceId: "workspace", tabIds: [browser.id, first.id, "terminal"] });
  await assert.rejects(service.reorderWorkspaceTabs({ workspaceId: "workspace", tabIds: [browser.id, "terminal"] }), /every tab/);
  const restored = await new JsonStore(path).load();
  assert.equal(restored.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(restored.filePreviewTabs[0]?.path, "report.md");
  assert.equal(restored.filePreviewTabs[0]?.order, 1);
  assert.equal(restored.sessions[0]?.order, 2);
  await assert.rejects(service.openFilePreview({ workspaceId: "workspace", path: "not-supported.ts" }), /Select a PDF/);
  await assert.rejects(service.openFilePreview({ workspaceId: "missing", path: "report.md" }), /not found/);
  await service.closeFilePreview(first.id);
  assert.deepEqual(service.snapshot().filePreviewTabs, []);
  await service.openFilePreview({ workspaceId: "workspace", path: "report.md" });
  await service.deleteWorkspace("workspace");
  assert.deepEqual(service.snapshot().filePreviewTabs, []);
  assert.deepEqual(service.snapshot().browserTabs, []);
});

test("preview bridge keeps filenames intact and rejects untrusted root or connection input", () => {
  const path = "  filename\n.md ";
  assert.equal(workspaceFileInputSchema.parse({ workspaceId: "w", path }).path, path);
  assert.equal(workspaceFileInputSchema.safeParse({ workspaceId: "w", path: "a\0.md" }).success, false);
  assert.equal(workspaceFileInputSchema.safeParse({ workspaceId: "w", path: "x", root: "/", host: "other" }).success, false);
});

test("Markdown renders read-only tables and code while escaping raw HTML and preserving resource URLs", () => {
  const html = renderPreviewMarkdown('# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n![image](../images/chart.png)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))', false);
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /language-js/);
  assert.match(html, /src="\.\.\/images\/chart.png"/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(staticPreviewCsp, /script-src 'none'/);
  assert.match(staticPreviewCsp, /default-src 'none'/);
});

test("PDF byte responses support full, bounded, suffix, HEAD and invalid ranges", async () => {
  const bytes = Buffer.from([0, 1, 128, 255, 10]);
  const full = previewByteResponse(bytes, "application/pdf", null);
  assert.equal(full.headers.get("content-length"), "5");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  for (const [range, expected, contentRange] of [["bytes=1-2", [1, 128], "bytes 1-2/5"], ["bytes=3-", [255, 10], "bytes 3-4/5"], ["bytes=-2", [255, 10], "bytes 3-4/5"], ["bytes=4-99", [10], "bytes 4-4/5"]] as const) {
    const response = previewByteResponse(bytes, "application/pdf", range);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), contentRange);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...expected]);
  }
  for (const range of ["bytes=99-", "bytes=-0", "bytes=4-1", "bytes=0-1,3-4", "bytes=-"]) assert.equal(previewByteResponse(bytes, "application/pdf", range).status, 416);
  assert.equal((await previewByteResponse(bytes, "application/pdf", null, "HEAD").arrayBuffer()).byteLength, 0);
  assert.equal(previewByteResponse(bytes, "text/html", null).headers.get("content-security-policy"), staticPreviewCsp);
});
