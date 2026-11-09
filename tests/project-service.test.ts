import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceService, type WorkspaceDirectoryRuntime, type WorkspaceGitRuntime } from "../src/main/application/workspace-service";
import { JsonStore } from "../src/main/persistence/json-store";
import type { Device, DirectoryListing } from "../src/shared/domain";

async function setup(
  gitFactory: (device: Device) => WorkspaceGitRuntime,
  directoryFactory?: (device: Device) => WorkspaceDirectoryRuntime
): Promise<{ service: WorkspaceService; store: JsonStore }> {
  const directory = await mkdtemp(join(tmpdir(), "superthread-project-"));
  const store = new JsonStore(join(directory, "state.json"));
  const service = new WorkspaceService(
    store,
    undefined,
    (device) => gitFactory(device),
    directoryFactory ? (device) => directoryFactory(device) : undefined
  );
  await service.initialize();
  await store.update((draft) => {
    draft.devices.push({ id: "dev_remote", name: "GPU host", type: "remote", status: "online", createdAt: "now" });
    draft.connections.push({ deviceId: "dev_remote", transport: "ssh", config: { host: "gpu.example", user: "builder", port: 22 } });
  });
  return { service, store };
}

function fakeGit(overrides: Partial<WorkspaceGitRuntime> = {}): WorkspaceGitRuntime {
  return {
    inspect: async (path) => ({ root: path, name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main" }),
    clone: async (_repositoryUrl, parentDirectory) => ({ root: join(parentDirectory, "demo"), name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main" }),
    listWorkspaceLinkCandidates: async () => [],
    linkWorktreePaths: async () => {},
    createWorktree: async () => ({ path: "", branch: "" }),
    inspectWorkspaceDeleteRisk: async () => ({ hasUncommittedChanges: false, hasUntrackedFiles: false, unmergedCommitCount: 0 }),
    deleteWorktree: async () => {},
    ...overrides
  };
}

test("AddProject import records a checkout on the selected remote device", async () => {
  const inspected: Array<{ deviceId: string; path: string }> = [];
  const { service } = await setup((device) => fakeGit({
    inspect: async (path) => {
      inspected.push({ deviceId: device.id, path });
      return { root: "/srv/demo", name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main" };
    }
  }));

  await service.addProject({ mode: "import", deviceId: "dev_remote", path: "/srv/demo" });

  assert.deepEqual(inspected, [{ deviceId: "dev_remote", path: "/srv/demo" }]);
  assert.equal(service.snapshot().projects[0]?.repositoryUrl, "git@example.com:team/demo.git");
  assert.equal(service.snapshot().checkouts[0]?.deviceId, "dev_remote");
  assert.equal(service.snapshot().checkouts[0]?.path, "/srv/demo");
});

test("AddProject clone always runs against the local device", async () => {
  const clonedOn: string[] = [];
  const { service } = await setup((device) => fakeGit({
    clone: async (_repositoryUrl, parentDirectory) => {
      clonedOn.push(device.id);
      return { root: join(parentDirectory, "demo"), name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main" };
    }
  }));

  await service.addProject({ mode: "clone", repositoryUrl: "git@example.com:team/demo.git", parentDirectory: "/Users/me/code" });

  assert.deepEqual(clonedOn, ["dev_local"]);
  assert.equal(service.snapshot().checkouts[0]?.deviceId, "dev_local");
});

test("AddProject allows identical names and remotes at different paths on one device", async () => {
  const { service } = await setup(() => fakeGit());
  await service.addProject({ mode: "import", deviceId: "dev_local", path: "/code/demo" });
  await service.addProject({ mode: "import", deviceId: "dev_local", path: "/other/demo" });
  await service.addProject({ mode: "clone", repositoryUrl: "git@example.com:team/demo.git", parentDirectory: "/cloned" });
  assert.equal(service.snapshot().projects.length, 3);
  assert.deepEqual(service.snapshot().projects.map((project) => project.name), ["demo", "demo", "demo"]);
  assert.deepEqual(service.snapshot().checkouts.map((checkout) => checkout.path), ["/code/demo", "/other/demo", "/cloned/demo"]);
});

test("AddProject rejects duplicate device paths atomically, including concurrent imports", async () => {
  const { service } = await setup(() => fakeGit());
  const input = { mode: "import" as const, deviceId: "dev_local", path: "/code/demo" };
  const results = await Promise.allSettled([service.addProject(input), service.addProject(input)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(service.snapshot().projects.length, 1);
  assert.equal(service.snapshot().checkouts.length, 1);
  await assert.rejects(() => service.addProject({ ...input, path: "/code/demo/./" }), /already exists on this device/);
  await service.addProject({ ...input, deviceId: "dev_remote" });
  assert.equal(service.snapshot().projects.length, 2);
});

test("AddProject accepts plain folders and optional custom names without Git metadata", async () => {
  const { service } = await setup(() => fakeGit({ inspect: async (path) => ({ root: path, name: "demo" }) }));
  await service.addProject({ mode: "import", deviceId: "dev_remote", path: "/srv/demo", projectName: "Notes" });
  assert.equal(service.snapshot().projects[0]?.name, "Notes");
  assert.equal(service.snapshot().projects[0]?.repositoryUrl, undefined);
  assert.equal(service.snapshot().projects[0]?.defaultBranch, undefined);
  assert.equal(service.snapshot().checkouts[0]?.isGit, false);
  await assert.rejects(() => service.setupProject({ projectId: service.snapshot().projects[0]!.id, deviceId: "dev_local", mode: "clone", parentDirectory: "/code" }), /no Git remote/);
  await service.setupProject({ projectId: service.snapshot().projects[0]!.id, deviceId: "dev_local", mode: "import", path: "/code/notes" });
  assert.equal(service.snapshot().checkouts[1]?.isGit, false);
});

test("SetupProject can clone a known project on a remote device", async () => {
  const clonedOn: string[] = [];
  const { service, store } = await setup((device) => fakeGit({
    clone: async (_url, parentDirectory) => {
      clonedOn.push(device.id);
      return { root: `${parentDirectory}/demo`, name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main" };
    }
  }));
  await store.update((draft) => {
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:team/demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
  });

  await service.setupProject({ projectId: "project-1", deviceId: "dev_remote", mode: "clone", parentDirectory: "/srv" });

  assert.deepEqual(clonedOn, ["dev_remote"]);
  assert.equal(service.snapshot().checkouts[0]?.path, "/srv/demo");
});

test("SetupProject import can add an existing remote checkout for a known project", async () => {
  const { service, store } = await setup(() => fakeGit({
    inspect: async () => ({ root: "/srv/demo", name: "demo", remote: "git@example.com:team/demo.git", defaultBranch: "main" })
  }));
  await store.update((draft) => {
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:team/demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
  });

  await service.setupProject({ projectId: "project-1", deviceId: "dev_remote", mode: "import", path: "/srv/demo" });

  assert.equal(service.snapshot().checkouts[0]?.projectId, "project-1");
  assert.equal(service.snapshot().checkouts[0]?.deviceId, "dev_remote");
  assert.equal(service.snapshot().checkouts[0]?.path, "/srv/demo");
});

test("projects can be renamed to duplicate display names while preserving safe names", async () => {
  const { service, store } = await setup(() => fakeGit());
  await store.update((draft) => {
    draft.projects.push(
      { id: "project-1", name: "demo", repositoryUrl: "git@example.com:team/demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" },
      { id: "project-2", name: "runtime", repositoryUrl: "git@example.com:team/runtime.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" }
    );
  });

  await service.updateProject({ id: "project-1", name: "Demo Core" });
  assert.equal(service.snapshot().projects.find((project) => project.id === "project-1")?.name, "Demo Core");
  await service.updateProject({ id: "project-1", name: "RUNTIME" });
  assert.equal(service.snapshot().projects[0]?.name, "RUNTIME");
  await assert.rejects(() => service.updateProject({ id: "project-1", name: "../runtime" }), /path separators/);
});

test("projects can only be deleted after their workspaces are removed", async () => {
  const { service, store } = await setup(() => fakeGit());
  await store.update((draft) => {
    draft.projects.push({ id: "project-1", name: "demo", repositoryUrl: "git@example.com:team/demo.git", defaultBranch: "main", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout-1", projectId: "project-1", deviceId: "dev_local", path: "/code/demo", createdAt: "now" });
    draft.workspaces.push({
      id: "workspace-1", name: "feature", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local",
      checkoutId: "checkout-1", path: "/code/demo-feature", branch: "work/feature", baseBranch: "main",
      status: "ready", createdAt: "now", updatedAt: "now"
    });
  });

  await assert.rejects(() => service.deleteProject("project-1"), /workspaces before deleting/);
  await store.update((draft) => { draft.workspaces = []; });
  await service.deleteProject("project-1");

  assert.equal(service.snapshot().projects.some((project) => project.id === "project-1"), false);
  assert.equal(service.snapshot().checkouts.some((checkout) => checkout.projectId === "project-1"), false);
});

test("WorkspaceService browses directories through the selected device runtime", async () => {
  const expected: DirectoryListing = {
    deviceId: "dev_remote",
    path: "/srv",
    parentPath: "/",
    entries: [{ name: "demo", path: "/srv/demo" }]
  };
  const browsed: Array<{ deviceId: string; path?: string }> = [];
  const { service } = await setup(
    () => fakeGit(),
    (device) => ({
      list: async (path) => {
        browsed.push({ deviceId: device.id, path });
        return expected;
      }
    })
  );

  const listing = await service.browseDirectory({ deviceId: "dev_remote", path: "/srv" });

  assert.deepEqual(browsed, [{ deviceId: "dev_remote", path: "/srv" }]);
  assert.deepEqual(listing, expected);
});

test("SetupProject cannot reuse a directory already registered to another project", async () => {
  const { service } = await setup(() => fakeGit());
  await service.addProject({ mode: "import", deviceId: "dev_local", path: "/code/demo" });
  await service.addProject({ mode: "import", deviceId: "dev_remote", path: "/srv/demo" });
  const project = service.snapshot().projects[0]!;
  await assert.rejects(() => service.setupProject({ projectId: project.id, deviceId: "dev_remote", mode: "import", path: "/srv/demo" }), /already exists on this device/);
  assert.equal(service.snapshot().checkouts.length, 2);
});
