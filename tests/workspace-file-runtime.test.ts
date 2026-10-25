import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { BinaryProcessRunner } from "../src/main/runtime/binary-command-runner";
import { WorkspaceFileRuntime, remoteFileHelper } from "../src/main/runtime/workspace-file-runtime";
import { previewFileType } from "../src/shared/file-preview";

const local = { deviceId: "local", transport: "local" as const, config: {} };
const runner = new BinaryProcessRunner();

test("local browsing preserves filenames, resolves in-root links, and excludes escaping links", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "workspace-files-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  await mkdir(join(root, "docs"), { recursive: true });
  const name = "中文 ' \" $ `\nreport.MD";
  await writeFile(join(root, name), "\n# Heading\n");
  await writeFile(join(root, "ignore.ts"), "code");
  await writeFile(join(base, "secret.pdf"), "secret");
  await symlink(join(base, "secret.pdf"), join(root, "escape.pdf"));
  await symlink(join(root, name), join(root, "alias.md"));
  const files = new WorkspaceFileRuntime(root, local);
  const location = await files.inspect("");
  assert.equal(location.path, ".");
  assert.equal(location.parentPath, null);
  assert.equal(location.entries?.[0]?.name, "docs");
  assert.deepEqual(new Set(location.entries?.map((entry) => entry.name)), new Set(["docs", name, "alias.md"]));
  assert.equal((await files.inspect(join(root, name))).path, name);
  assert.equal((await files.inspect("alias.md")).path, name);
  assert.equal((await files.inspect("docs")).parentPath, ".");
  assert.equal((await files.read(name)).toString(), "\n# Heading\n");
  await assert.rejects(files.read("escape.pdf"), /inside this workspace/);
  await assert.rejects(files.inspect("../secret.pdf"), /inside this workspace/);
  await assert.rejects(files.read(join(base, "secret.pdf")), /inside this workspace/);
  await assert.rejects(files.read("docs"), /regular files/);
});

test("binary reads preserve every byte and reject limits, special files, and cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  await writeFile(join(root, "bytes.pdf"), bytes);
  const files = new WorkspaceFileRuntime(root, local);
  assert.deepEqual(await files.read("bytes.pdf", 256), bytes);
  await assert.rejects(files.read("bytes.pdf", 255), /size limit/);
  await assert.rejects(files.read("bytes.pdf", 256, AbortSignal.abort()), /cancelled/);
  await promisify(execFile)("mkfifo", [join(root, "pipe.pdf")]);
  await assert.rejects(files.read("pipe.pdf"), /regular files/);
  assert.equal((await files.inspect("")).entries?.some((entry) => entry.name === "pipe.pdf"), false);
  assert.equal(previewFileType("FILE.HTML"), "html");
  assert.equal(previewFileType("FILE.MarkDown"), "markdown");
});

test("SSH passes connection settings and filenames through JSON, while Python implements the same boundary", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "workspace-remote-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  await mkdir(root);
  const path = "quotes'\"$`\n中文.pdf";
  const bytes = Buffer.from([0, 10, 13, 128, 255]);
  await writeFile(join(root, path), bytes);
  await writeFile(join(base, "outside.pdf"), "secret");
  await symlink(join(base, "outside.pdf"), join(root, "escape.pdf"));
  let calls = 0;
  const remote = new WorkspaceFileRuntime(root, { deviceId: "ssh", transport: "ssh", config: { host: "my-ssh-alias", user: "tester", port: 2222 } }, {
    async run(program, args, options) {
      calls++;
      assert.equal(program, "ssh");
      assert.deepEqual(args.slice(0, -1), ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-p", "2222", "--", "tester@my-ssh-alias"]);
      assert.equal(args.at(-1)?.includes(path), false);
      return runner.run("python3", ["-c", remoteFileHelper], options);
    }
  });
  assert.equal((await remote.inspect("")).entries?.[0]?.name, path);
  assert.deepEqual(await remote.read(path, 5), bytes);
  await assert.rejects(remote.read(path, 4), /size limit/);
  await assert.rejects(remote.read("escape.pdf"), /inside this workspace/);
  await assert.rejects(remote.read("../outside.pdf"), /inside this workspace/);
  assert.equal(calls, 5);
});

test("binary subprocess enforces timeout, cancellation, stdout limits, and reports missing Python", async () => {
  await assert.rejects(runner.run(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { maxBytes: 100, timeoutMs: 20 }), /timed out/);
  const controller = new AbortController();
  const pending = runner.run(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { maxBytes: 100, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(runner.run(process.execPath, ["-e", "process.stdout.write('too much')"], { maxBytes: 2 }), /limit/);
  await assert.rejects(runner.run(process.execPath, ["-e", "process.stderr.write('python3: command not found');process.exit(127)"], { maxBytes: 100 }), /Python 3 is required/);
});
