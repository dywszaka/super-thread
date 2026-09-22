import assert from "node:assert/strict";
import test from "node:test";
import { addProjectSchema, addRemoteDeviceSchema, browseDirectorySchema, setupProjectSchema, updateRemoteDeviceSchema } from "../src/shared/contract";

test("AddProject import is device-scoped and clone is local-only at the contract boundary", () => {
  assert.equal(addProjectSchema.safeParse({ mode: "import", deviceId: "dev_remote", path: "/srv/demo" }).success, true);
  assert.equal(addProjectSchema.safeParse({ mode: "import", path: "/srv/demo" }).success, false);
  assert.equal(addProjectSchema.safeParse({ mode: "clone", repositoryUrl: "git@example.com:team/demo.git", parentDirectory: "/Users/me/code" }).success, true);
  assert.equal(addProjectSchema.safeParse({ mode: "clone", repositoryUrl: "git@example.com:team/demo.git", deviceId: "dev_remote", parentDirectory: "/srv" }).success, false);
});

test("SetupProject requires the path that matches the selected setup mode", () => {
  assert.equal(setupProjectSchema.safeParse({ projectId: "project-1", deviceId: "dev_remote", mode: "import", path: "/srv/demo" }).success, true);
  assert.equal(setupProjectSchema.safeParse({ projectId: "project-1", deviceId: "dev_local", mode: "clone", parentDirectory: "/Users/me/code" }).success, true);
  assert.equal(setupProjectSchema.safeParse({ projectId: "project-1", deviceId: "dev_remote", mode: "import", parentDirectory: "/srv" }).success, false);
  assert.equal(setupProjectSchema.safeParse({ projectId: "project-1", deviceId: "dev_local", mode: "clone", path: "/Users/me/code/demo" }).success, false);
});

test("BrowseDirectory accepts a selected device and optional path", () => {
  assert.deepEqual(browseDirectorySchema.parse({ deviceId: "dev_remote", path: "  /srv  " }), { deviceId: "dev_remote", path: "/srv" });
  assert.equal(browseDirectorySchema.safeParse({ path: "/srv" }).success, false);
});

test("remote device tunnels validate both forwarding directions and reject duplicate bindings", () => {
  const base = { name: "GPU", host: "gpu.example", user: "builder", port: 22 };
  const tunnels = [
    { direction: "local-to-remote", sourcePort: 3000, destinationHost: "127.0.0.1", destinationPort: 3000 },
    { direction: "remote-to-local", sourcePort: 3000, destinationHost: "127.0.0.1", destinationPort: 4000 }
  ];
  assert.equal(addRemoteDeviceSchema.safeParse({ ...base, tunnels }).success, true);
  assert.equal(updateRemoteDeviceSchema.safeParse({ ...base, id: "dev_remote", tunnels }).success, true);
  assert.equal(addRemoteDeviceSchema.safeParse({ ...base, tunnels: [...tunnels, tunnels[0]] }).success, false);
  assert.equal(addRemoteDeviceSchema.safeParse({ ...base, tunnels: [{ ...tunnels[0], sourcePort: 0 }] }).success, false);
});
