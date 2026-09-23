import type { AppSnapshot } from "../../shared/domain";

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export function vscodeWorkspaceUrl(snapshot: AppSnapshot, workspaceId: string): string {
  const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  if (workspace.status !== "ready" || !workspace.path) throw new Error("Workspace is not ready");

  const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
  if (!device) throw new Error("Workspace device not found");

  const path = `${encodePath(workspace.path).replace(/\/$/, "")}/`;
  if (device.type === "local") return `vscode://file${path}`;

  const connection = snapshot.connections.find((item) => item.deviceId === device.id && item.transport === "ssh");
  const host = connection?.config.host;
  const user = connection?.config.user;
  if (!host || !user) throw new Error("Remote workspace SSH connection is incomplete");

  const port = connection.config.port;
  const target = `${user}@${host}${port && port !== 22 ? `:${port}` : ""}`;
  return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(target)}${path}`;
}
