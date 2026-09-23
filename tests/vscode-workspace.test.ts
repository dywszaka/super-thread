import assert from "node:assert/strict";
import test from "node:test";
import { vscodeWorkspaceUrl } from "../src/main/runtime/vscode-workspace";
import { emptySnapshot, type AppSnapshot, type Workspace } from "../src/shared/domain";

const workspace: Workspace = {
  id: "workspace-1",
  name: "feature-x",
  workThreadId: "thread-1",
  projectId: "project-1",
  deviceId: "device-1",
  checkoutId: "checkout-1",
  path: "/Users/alice/Project One/#demo",
  branch: "work/feature-x",
  baseBranch: "main",
  status: "ready",
  createdAt: "now",
  updatedAt: "now"
};

function snapshot(): AppSnapshot {
  const value = emptySnapshot();
  value.workspaces.push({ ...workspace });
  return value;
}

test("vscodeWorkspaceUrl opens a local workspace with an encoded file URI", () => {
  const value = snapshot();
  value.devices.push({ id: "device-1", name: "Mac", type: "local", status: "online", createdAt: "now" });
  value.connections.push({ deviceId: "device-1", transport: "local", config: {} });

  assert.equal(vscodeWorkspaceUrl(value, workspace.id), "vscode://file/Users/alice/Project%20One/%23demo/");
});

test("vscodeWorkspaceUrl opens an SSH workspace with user, host, port, and remote path", () => {
  const value = snapshot();
  value.workspaces[0] = { ...workspace, path: "/home/builder/work trees/demo" };
  value.devices.push({ id: "device-1", name: "GPU", type: "remote", status: "online", createdAt: "now" });
  value.connections.push({ deviceId: "device-1", transport: "ssh", config: { host: "gpu.example", user: "builder", port: 2222 } });

  assert.equal(
    vscodeWorkspaceUrl(value, workspace.id),
    "vscode://vscode-remote/ssh-remote+builder%40gpu.example%3A2222/home/builder/work%20trees/demo/"
  );
});

test("vscodeWorkspaceUrl omits the default SSH port and rejects unavailable workspaces", () => {
  const value = snapshot();
  value.workspaces[0] = { ...workspace, path: "/srv/demo" };
  value.devices.push({ id: "device-1", name: "GPU", type: "remote", status: "online", createdAt: "now" });
  value.connections.push({ deviceId: "device-1", transport: "ssh", config: { host: "gpu.example", user: "builder", port: 22 } });

  assert.equal(vscodeWorkspaceUrl(value, workspace.id), "vscode://vscode-remote/ssh-remote+builder%40gpu.example/srv/demo/");
  value.workspaces[0] = { ...workspace, status: "creating" };
  assert.throws(() => vscodeWorkspaceUrl(value, workspace.id), /not ready/);
});
