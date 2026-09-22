import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Device, DeviceConnection } from "../src/shared/domain";
import { DirectoryRuntime } from "../src/main/runtime/directory-runtime";

const local: Device = { id: "dev_local", name: "Mac", type: "local", status: "online", createdAt: "now" };
const connection: DeviceConnection = { deviceId: "dev_local", transport: "local", config: {} };

test("DirectoryRuntime lists child directories without returning files", async () => {
  const root = await mkdir(join(tmpdir(), `superthread-directory-${Date.now()}`), { recursive: true });
  assert.ok(root);
  await mkdir(join(root, "repo-a"));
  await mkdir(join(root, "repo-b"));
  await writeFile(join(root, "README.md"), "not a directory", "utf8");
  const resolvedRoot = await realpath(root);

  const listing = await new DirectoryRuntime(local, connection).list(root);

  assert.equal(listing.deviceId, "dev_local");
  assert.equal(listing.path, resolvedRoot);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["repo-a", "repo-b"]);
  assert.deepEqual(listing.entries.map((entry) => entry.path), [join(resolvedRoot, "repo-a"), join(resolvedRoot, "repo-b")]);
});
