import assert from "node:assert/strict";
import test from "node:test";
import { itermTmuxCommand } from "../src/main/runtime/iterm-runtime";
import type { Device, DeviceConnection, Workspace } from "../src/shared/domain";

const workspace: Workspace = {
  id: "workspace-1", name: "demo", workThreadId: "thread-1", projectId: "project-1", deviceId: "dev_local",
  checkoutId: "checkout-1", kind: "worktree", path: "/tmp/demo worktree", branch: "work/demo", baseBranch: "main",
  status: "ready", createdAt: "now", updatedAt: "now"
};

test("iTerm opens a local workspace tmux session through the login shell", () => {
  const device: Device = { id: "dev_local", name: "Local", type: "local", status: "online", createdAt: "now" };
  const connection: DeviceConnection = { deviceId: device.id, transport: "local", config: {} };

  const command = itermTmuxCommand(workspace, device, connection, "demo-session");

  assert.match(command, /\$\{SHELL:-\/bin\/sh\}.*-lic/);
  assert.match(command, /cd .*demo worktree/);
  assert.match(command, /tmux attach-session -t .*demo-session/);
});

test("iTerm opens a remote workspace tmux session over interactive SSH", () => {
  const device: Device = { id: "dev_remote", name: "GPU", type: "remote", status: "online", createdAt: "now" };
  const connection: DeviceConnection = { deviceId: device.id, transport: "ssh", config: { host: "gpu.example", user: "builder", port: 2222 } };

  const command = itermTmuxCommand({ ...workspace, deviceId: device.id, path: "/srv/demo worktree" }, device, connection, "demo-session");

  assert.match(command, /^'ssh' '-t'/);
  assert.match(command, /'-p' '2222' 'builder@gpu\.example'/);
  assert.match(command, /ServerAliveInterval=5/);
  assert.match(command, /tmux attach-session/);
  assert.match(command, /demo-session/);
});
