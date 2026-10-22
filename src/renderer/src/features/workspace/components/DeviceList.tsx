import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, FolderGit2, Laptop, Pencil, Plus, RefreshCw, Server, TerminalSquare, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Device, DeviceConnection, SshTunnelConfig, SshTunnelRuntime } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { Field, Modal } from "./Modal";
import { sameTunnel, tunnelConflicts } from "@/shared/ssh-tunnels";
import { SshTunnelFields, TunnelMapping, TunnelStatus } from "./SshTunnelFields";
import { SidebarReopenButton } from "./Sidebar";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function DeviceList({ snapshot }: { snapshot: AppSnapshot }): React.ReactNode {
  const client = useQueryClient();
  const { data: runtimes = [] } = useQuery({ queryKey: ["tunnel-statuses"], queryFn: () => window.desktop.tunnelStatuses() });
  const openDialog = useWorkbenchStore((state) => state.openDialog);
  const [checking, setChecking] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = snapshot.devices.find((device) => device.id === editingId && device.type === "remote");
  const editingConnection = snapshot.connections.find((connection) => connection.deviceId === editingId);

  const checkConnections = async (): Promise<void> => {
    setChecking(true);
    try {
      await window.desktop.pingDevices();
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success("Device status refreshed");
    } catch (error) { toast.error(cleanError(error)); }
    finally { setChecking(false); }
  };

  const remove = async (device: Device): Promise<void> => {
    if (!confirm(`Delete the device “${device.name}”?\n\nIts SSH connection settings will be removed.`)) return;
    setBusyId(device.id);
    try {
      await window.desktop.deleteDevice(device.id);
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success(`${device.name} deleted`);
    } catch (error) { toast.error(cleanError(error)); }
    finally { setBusyId(null); }
  };

  return (
    <main className="device-page">
      <header className="device-page-header drag">
        <SidebarReopenButton />
        <div><h1>Devices</h1><p>Manage the machines that own project checkouts, workspaces, and terminal runtimes.</p></div>
        <div className="device-header-actions no-drag">
          <button className="button" disabled={checking} onClick={() => void checkConnections()}><RefreshCw className={checking ? "spinning" : ""} size={14} /> {checking ? "Checking…" : "Check connections"}</button>
          <button className="button primary" onClick={() => openDialog("device")}><Plus size={14} /> Add Device</button>
        </div>
      </header>
      <section className="device-page-body no-drag">
        <div className="device-summary">
          <span><strong>{snapshot.devices.length}</strong> devices</span>
          <span><i className="status-dot online" /><strong>{snapshot.devices.filter((device) => device.status === "online").length}</strong> online</span>
          <span><i className="status-dot offline" /><strong>{snapshot.devices.filter((device) => device.status === "offline").length}</strong> offline</span>
        </div>
        <div className="device-cards">
          {snapshot.devices.map((device) => {
            const connection = snapshot.connections.find((item) => item.deviceId === device.id);
            const checkouts = snapshot.checkouts.filter((checkout) => checkout.deviceId === device.id);
            const workspaces = snapshot.workspaces.filter((workspace) => workspace.deviceId === device.id);
            const busy = busyId === device.id;
            const address = device.type === "local"
              ? "This Mac"
              : `${connection?.config.user ? `${connection.config.user}@` : ""}${connection?.config.host || "Not configured"}${connection?.config.port && connection.config.port !== 22 ? `:${connection.config.port}` : ""}`;
            return (
              <article className="device-card" key={device.id}>
                <div className={`device-card-icon ${device.status}`}>{device.type === "local" ? <Laptop size={19} /> : <Server size={19} />}</div>
                <div className="device-card-content">
                  <div className="device-card-title"><strong>{device.name}</strong><span className={`device-status ${device.status}`}><i />{device.status}</span>{device.type === "local" && <span className="device-kind">Local</span>}</div>
                  <code>{address}</code>
                  <div className="device-usage"><span><FolderGit2 size={12} /> {checkouts.length} {checkouts.length === 1 ? "project checkout" : "project checkouts"}</span><span><TerminalSquare size={12} /> {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}</span>{device.type === "remote" && <span><ArrowRightLeft size={12} /> {connection?.config.tunnels?.length ?? 0} {(connection?.config.tunnels?.length ?? 0) === 1 ? "tunnel" : "tunnels"}</span>}</div>
                  {device.type === "remote" && <DeviceTunnels connection={connection} runtimes={runtimes} />}
                </div>
                <div className="device-card-actions">
                  {device.type === "remote" && <button className="button" disabled={busy} onClick={() => setEditingId(device.id)}><Pencil size={13} /> Edit</button>}
                  <button className="icon-button danger-button" disabled={device.type === "local" || busy || checkouts.length > 0 || workspaces.length > 0} title={device.type === "local" ? "The local device is managed by SuperThread" : checkouts.length > 0 || workspaces.length > 0 ? "Remove project checkouts and workspaces before deleting this device" : "Delete device"} onClick={() => void remove(device)}><Trash2 size={14} /></button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      {editing && editingConnection && <EditDeviceDialog key={editing.id} device={editing} connection={editingConnection} snapshot={snapshot} runtimes={runtimes} onClose={() => setEditingId(null)} />}
    </main>
  );
}

function DeviceTunnels({ connection, runtimes }: { connection?: DeviceConnection; runtimes: SshTunnelRuntime[] }): React.ReactNode {
  const tunnels = connection?.config.tunnels ?? [];
  if (!tunnels.length) return null;
  const active = runtimes.filter((item) => item.deviceId === connection?.deviceId && item.status === "active").length;
  const retrying = runtimes.filter((item) => item.deviceId === connection?.deviceId && item.status === "retrying").length;
  return <details className="device-tunnels">
    <summary><span>{active}/{tunnels.length} tunnels active{retrying > 0 && ` · ${retrying} retrying`}</span><span className="tunnel-port-preview">{tunnels.slice(0, 4).map((tunnel, index) => <code key={index}>{tunnel.direction === "local-to-remote" ? "Local" : "Remote"} :{tunnel.sourcePort}</code>)}{tunnels.length > 4 && <span>+{tunnels.length - 4}</span>}</span></summary>
    <div className="device-tunnel-list">{tunnels.map((tunnel, index) => {
      const runtime = runtimes.find((item) => item.deviceId === connection?.deviceId && sameTunnel(item.tunnel, tunnel));
      return <div className="device-tunnel-item" key={index}><div className="tunnel-row"><TunnelMapping tunnel={tunnel} /><TunnelStatus runtime={runtime} /></div>{runtime?.error && <div className="tunnel-error">{runtime.error} · Reconnects automatically</div>}</div>;
    })}</div>
  </details>;
}

function EditDeviceDialog({ device, connection, snapshot, runtimes, onClose }: { device: Device; connection: DeviceConnection; snapshot: AppSnapshot; runtimes: SshTunnelRuntime[]; onClose(): void }): React.ReactNode {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(device.name);
  const [host, setHost] = useState(connection.config.host || "");
  const [user, setUser] = useState(connection.config.user || "");
  const [port, setPort] = useState(String(connection.config.port || 22));
  const [tunnels, setTunnels] = useState<SshTunnelConfig[]>(() => structuredClone(connection.config.tunnels ?? []));
  const draft: DeviceConnection = { ...connection, config: { host, user, port: Number(port), tunnels } };
  const conflicts = tunnelConflicts(draft, snapshot.connections);
  const destinationChanged = host !== connection.config.host || user !== connection.config.user || Number(port) !== (connection.config.port ?? 22);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (conflicts.length) return;
    setBusy(true);
    try {
      await window.desktop.updateDevice({ id: device.id, name, host, user, port: Number(port), tunnels });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      await client.invalidateQueries({ queryKey: ["tunnel-statuses"] });
      toast.success(`${name.trim()} saved. Tunnels connect automatically.`);
      onClose();
    } catch (error) { toast.error(cleanError(error)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open title="Edit remote device" description="Save changes to apply tunnels immediately. Check connections only checks SSH reachability." busy={busy} submitDisabled={conflicts.length > 0} submitLabel="Save & Connect" onClose={onClose} onSubmit={submit}>
      <div className="form-grid two"><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></Field><Field label="Host"><input value={host} onChange={(event) => setHost(event.target.value)} required /></Field></div>
      <div className="form-grid two"><Field label="SSH user"><input value={user} onChange={(event) => setUser(event.target.value)} required /></Field><Field label="Port"><input type="number" value={port} onChange={(event) => setPort(event.target.value)} min="1" max="65535" required /></Field></div>
      <SshTunnelFields value={tunnels} onChange={setTunnels} connection={draft} connections={snapshot.connections} devices={snapshot.devices} saved={destinationChanged ? [] : connection.config.tunnels} runtimes={runtimes} />
    </Modal>
  );
}
