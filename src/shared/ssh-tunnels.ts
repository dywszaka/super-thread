import type { DeviceConnection, SshTunnelConfig } from "./domain";

export const tunnelBinding = (tunnel: SshTunnelConfig): string => `${tunnel.direction}:${tunnel.sourcePort}`;
export const sameTunnel = (a: SshTunnelConfig, b: SshTunnelConfig): boolean =>
  tunnelBinding(a) === tunnelBinding(b) && a.destinationHost === b.destinationHost && a.destinationPort === b.destinationPort;

// Local listeners share this Mac. Reverse listeners share a remote SSH endpoint,
// even when its connections authenticate as different users.
export function tunnelConflicts(connection: DeviceConnection, connections: DeviceConnection[]): Array<{ index: number; deviceId: string }> {
  const seen = new Map<string, { deviceId: string; index?: number }>();
  const endpoint = (value: DeviceConnection): string => `${value.config.host?.trim().toLowerCase()}:${value.config.port ?? 22}`;
  const scope = (owner: DeviceConnection, tunnel: SshTunnelConfig): string =>
    `${tunnel.direction === "local-to-remote" ? "local" : endpoint(owner)}:${tunnelBinding(tunnel)}`;
  for (const other of connections) {
    if (other.deviceId === connection.deviceId || other.transport !== "ssh") continue;
    for (const tunnel of other.config.tunnels ?? []) seen.set(scope(other, tunnel), { deviceId: other.deviceId });
  }
  const conflicts = new Map<number, string>();
  connection.config.tunnels?.forEach((tunnel, index) => {
    const key = scope(connection, tunnel);
    const owner = seen.get(key);
    if (owner) {
      conflicts.set(index, owner.deviceId);
      if (owner.index !== undefined) conflicts.set(owner.index, owner.deviceId);
    } else seen.set(key, { deviceId: connection.deviceId, index });
  });
  return [...conflicts].sort(([a], [b]) => a - b).map(([index, deviceId]) => ({ index, deviceId }));
}
