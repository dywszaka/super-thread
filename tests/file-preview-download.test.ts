import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FilePreviewDownloader } from "../src/main/runtime/file-preview-download";
import { BinaryProcessRunner } from "../src/main/runtime/binary-command-runner";
import { WorkspaceFileRuntime, remoteFileHelper } from "../src/main/runtime/workspace-file-runtime";
import { emptySnapshot, type PreviewFileType } from "../src/shared/domain";
import { MAX_PREVIEW_FILE_BYTES, MAX_PREVIEW_TEXT_BYTES } from "../src/shared/file-preview";

async function fixture(t: TestContext, fileType: PreviewFileType = "pdf") {
  const base = await mkdtemp(join(tmpdir(), "preview-download-")), root = join(base, "workspace");
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  const name = `中文 ' \" $ \`\nreport.${fileType === "markdown" ? "md" : fileType}`;
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  await writeFile(join(root, name), bytes);
  const snapshot = emptySnapshot();
  snapshot.workspaces.push({ id: "workspace", workThreadId: "thread", projectId: "project", deviceId: "local", checkoutId: "checkout", kind: "main", path: root, name: "preview", branch: "main", baseBranch: "main", status: "ready", createdAt: "then", updatedAt: "then" });
  snapshot.filePreviewTabs.push({ id: "preview", workspaceId: "workspace", path: name, fileType, order: 0, createdAt: "then", updatedAt: "then" });
  const files = new WorkspaceFileRuntime(root, { deviceId: "local", transport: "local", config: {} });
  const service = Object.assign(new EventEmitter(), { snapshot: () => structuredClone(snapshot), workspaceFiles: (_id: string) => files });
  const downloads = new FilePreviewDownloader(service), destination = join(base, "saved file");
  return { base, root, name, bytes, files, service, snapshot, downloads, destination };
}

test("downloads preserve original bytes and filenames for all formats and read fresh content", async (t) => {
  for (const format of ["pdf", "html", "markdown"] as const) {
    const f = await fixture(t, format);
    const read = f.files.read.bind(f.files);
    f.files.read = (path, limit, signal) => {
      assert.equal(limit, format === "pdf" ? MAX_PREVIEW_FILE_BYTES : MAX_PREVIEW_TEXT_BYTES);
      return read(path, limit, signal);
    };
    assert.equal(await f.downloads.download("preview", async (name) => { assert.equal(name, f.name); return f.destination; }), true);
    assert.deepEqual(await readFile(f.destination), f.bytes);
    await writeFile(join(f.root, f.name), "updated source");
    assert.equal(await f.downloads.download("preview", async () => f.destination), true);
    assert.equal(await readFile(f.destination, "utf8"), "updated source");
    assert.equal((await readdir(f.base)).some((name) => name.startsWith(".superthread-download-")), false);
    assert.equal(f.service.listenerCount("changed"), 0);
  }
});

test("cancelled save dialogs never read files or create local output, and invalid tabs cannot open dialogs", async (t) => {
  const f = await fixture(t);
  f.files.read = async () => { throw new Error("must not read"); };
  assert.equal(await f.downloads.download("preview", async () => null), false);
  assert.equal(await f.downloads.download("preview", async () => { throw new Error("must not open"); }, AbortSignal.abort()), false);
  await assert.rejects(f.downloads.download("unknown", async () => { throw new Error("must not open"); }), /no longer exists/);
  assert.deepEqual(await readdir(f.base), ["workspace"]);
  assert.equal(f.service.listenerCount("changed"), 0);
});

test("failed, oversized or escaping source reads preserve an existing destination", async (t) => {
  const f = await fixture(t, "html");
  await writeFile(f.destination, "keep me");
  await writeFile(join(f.root, f.name), Buffer.alloc(MAX_PREVIEW_TEXT_BYTES + 1));
  await assert.rejects(f.downloads.download("preview", async () => f.destination), /size limit/);
  await rm(join(f.root, f.name));
  await assert.rejects(f.downloads.download("preview", async () => f.destination), /ENOENT/);
  await symlink(f.destination, join(f.root, f.name));
  await assert.rejects(f.downloads.download("preview", async () => f.destination), /inside this workspace/);
  assert.equal(await readFile(f.destination, "utf8"), "keep me");
  assert.equal((await readdir(f.base)).some((name) => name.startsWith(".superthread-download-")), false);
});

test("failed destination writes remove staging files and allow retry", async (t) => {
  const f = await fixture(t);
  await mkdir(f.destination);
  await assert.rejects(f.downloads.download("preview", async () => f.destination), /EISDIR|ENOTEMPTY|EEXIST/);
  assert.deepEqual(await readdir(f.destination), []);
  assert.equal((await readdir(f.base)).some((name) => name.startsWith(".superthread-download-")), false);
  await rm(f.destination, { recursive: true });
  assert.equal(await f.downloads.download("preview", async () => f.destination), true);
});

test("closing or changing the preview, deleting its workspace, or closing the owner cancels in-flight reads", async (t) => {
  for (const change of ["tab-close", "navigate", "workspace-delete", "owner-close"]) {
    const f = await fixture(t), owner = new AbortController();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    f.files.read = async (_path, _limit, signal) => {
      started();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      return f.bytes;
    };
    await writeFile(f.destination, "keep me");
    const pending = f.downloads.download("preview", async () => f.destination, owner.signal);
    await reading;
    await assert.rejects(f.downloads.download("preview", async () => null), /already being downloaded/);
    if (change === "tab-close") f.snapshot.filePreviewTabs = [];
    if (change === "navigate") f.snapshot.filePreviewTabs[0]!.path = "other.pdf";
    if (change === "workspace-delete") f.snapshot.workspaces = [];
    if (change === "owner-close") owner.abort();
    else f.service.emit("changed");
    assert.equal(await pending, false);
    assert.equal(await readFile(f.destination, "utf8"), "keep me");
    assert.equal(f.service.listenerCount("changed"), 0);
  }
});

test("a tab changed while the save dialog is open cannot download a different file", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.downloads.download("preview", async () => {
    f.snapshot.filePreviewTabs[0]!.path = "other.pdf";
    f.service.emit("changed");
    return f.destination;
  }), false);
  await assert.rejects(readFile(f.destination), /ENOENT/);
});

test("owner cancellation releases a download even if the native save dialog never settles", async (t) => {
  const f = await fixture(t), owner = new AbortController();
  const pending = f.downloads.download("preview", () => new Promise(() => {}), owner.signal);
  owner.abort();
  assert.equal(await pending, false);
  assert.equal(f.service.listenerCount("changed"), 0);
  assert.equal(await f.downloads.download("preview", async () => null), false);
});

test("remote downloads reuse the SSH binary reader with literal filenames and propagate failures", async (t) => {
  const f = await fixture(t), runner = new BinaryProcessRunner();
  const remote = new WorkspaceFileRuntime(f.root, { deviceId: "ssh", transport: "ssh", config: { host: "alias", user: "tester", port: 2222 } }, {
    async run(program, args, options) {
      assert.equal(program, "ssh");
      assert.deepEqual(args.slice(-4, -1), ["2222", "--", "tester@alias"]);
      assert.equal(JSON.parse(options.input!).path, f.name);
      assert.equal(args.at(-1)!.includes(f.name), false);
      return runner.run("python3", ["-c", remoteFileHelper], options);
    }
  });
  f.service.workspaceFiles = () => remote;
  assert.equal(await f.downloads.download("preview", async () => f.destination), true);
  assert.deepEqual(await readFile(f.destination), f.bytes);
  remote.read = async () => { throw new Error("SSH connection failed"); };
  await assert.rejects(f.downloads.download("preview", async () => f.destination), /SSH connection failed/);
  assert.deepEqual(await readFile(f.destination), f.bytes);
});
