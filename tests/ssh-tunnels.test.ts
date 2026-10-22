import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceConnection, SshTunnelConfig } from "../src/shared/domain";
import { tunnelConflicts } from "../src/shared/ssh-tunnels";

const mapping: SshTunnelConfig = { direction: "local-to-remote", sourcePort: 3000, destinationHost: "127.0.0.1", destinationPort: 8000 };
const connection = (deviceId: string, host: string, tunnels: SshTunnelConfig[], port?: number): DeviceConnection => ({ deviceId, transport: "ssh", config: { host, port, tunnels } });

test("local source ports conflict across devices, regardless of destination", () => {
  const other = connection("other", "different-host", [mapping]);
  const draft = connection("editing", "gpu", [{ ...mapping, destinationPort: 9000 }]);
  assert.deepEqual(tunnelConflicts(draft, [other]), [{ index: 0, deviceId: "other" }]);
  assert.deepEqual(tunnelConflicts(draft, [draft]), []);
});

test("reverse source ports share an SSH endpoint across users but not distinct hosts or SSH ports", () => {
  const reverse: SshTunnelConfig = { ...mapping, direction: "remote-to-local" };
  const other = connection("other", "GPU", [reverse]);
  other.config.user = "first-user";
  const draft = connection("editing", "gpu", [reverse], 22);
  draft.config.user = "second-user";
  assert.deepEqual(tunnelConflicts(draft, [other]), [{ index: 0, deviceId: "other" }]);
  assert.deepEqual(tunnelConflicts({ ...draft, config: { ...draft.config, port: 2200 } }, [other]), []);
  assert.deepEqual(tunnelConflicts(connection("editing", "another-host", [reverse]), [other]), []);
});

test("both directions can reuse a number and duplicate bindings are rejected within a device", () => {
  const draft = connection("editing", "gpu", [mapping, { ...mapping, direction: "remote-to-local" }, { ...mapping, destinationPort: 9000 }]);
  assert.deepEqual(tunnelConflicts(draft, []), [{ index: 0, deviceId: "editing" }, { index: 2, deviceId: "editing" }]);
});
