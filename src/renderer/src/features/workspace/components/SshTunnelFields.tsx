import { ArrowRightLeft, ChevronDown, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { DeviceConnection, Device, SshTunnelConfig, SshTunnelRuntime } from "@/shared/domain";
import { sameTunnel, tunnelConflicts } from "@/shared/ssh-tunnels";
import { Field } from "./Modal";

export function TunnelMapping({ tunnel }: { tunnel: SshTunnelConfig }): ReactNode {
  const local = tunnel.direction === "local-to-remote";
  return <span className="tunnel-mapping"><strong>{local ? "Local" : "Remote"} :{tunnel.sourcePort}</strong><span aria-hidden="true">→</span><span>{local ? "Remote" : "Local"} {tunnel.destinationHost}:{tunnel.destinationPort}</span></span>;
}

export function TunnelStatus({ runtime, pending = false }: { runtime?: SshTunnelRuntime; pending?: boolean }): ReactNode {
  const status = pending ? "pending" : runtime?.status ?? "connecting";
  const label = { pending: "Unsaved", connecting: "Connecting…", active: "Active", retrying: "Retrying", paused: "Paused" }[status];
  return <span className={`tunnel-status ${status}`} title={pending ? "Save to apply this mapping" : runtime?.error ?? (status === "active" ? "SSH listener established. The destination service must be running separately." : label)}><i />{label}</span>;
}

export function SshTunnelFields({ value, onChange, connection, connections = [], devices = [], saved = [], runtimes = [] }: {
  value: SshTunnelConfig[];
  onChange(value: SshTunnelConfig[]): void;
  connection?: DeviceConnection;
  connections?: DeviceConnection[];
  devices?: Device[];
  saved?: SshTunnelConfig[];
  runtimes?: SshTunnelRuntime[];
}): ReactNode {
  const [expanded, setExpanded] = useState<number | null>(null);
  const section = useRef<HTMLElement>(null);
  const draft: DeviceConnection = { deviceId: connection?.deviceId ?? "new-device", transport: "ssh", config: { ...connection?.config, tunnels: value } };
  const conflicts = tunnelConflicts(draft, connections);
  const update = (index: number, patch: Partial<SshTunnelConfig>): void => {
    onChange(value.map((tunnel, candidate) => candidate === index ? { ...tunnel, ...patch } : tunnel));
  };
  const add = (): void => {
    const used = new Set([...value, ...connections.filter((other) => other.deviceId !== draft.deviceId).flatMap((other) => other.config.tunnels ?? [])]
      .filter((tunnel) => tunnel.direction === "local-to-remote").map((tunnel) => tunnel.sourcePort));
    let port = 3000;
    while (used.has(port)) port += 1;
    onChange([{ direction: "local-to-remote", sourcePort: port, destinationHost: "127.0.0.1", destinationPort: port }, ...value]);
    setExpanded(0);
    requestAnimationFrame(() => {
      const input = section.current?.querySelector<HTMLInputElement>(".tunnel-grid input");
      input?.focus(); input?.select();
    });
  };

  return (
    <section className="tunnel-section" ref={section}>
      <div className="tunnel-heading">
        <div><strong>SSH tunnels · {value.length}/32</strong><span>Save to connect automatically. Active means the SSH listener is ready.</span></div>
        <button type="button" className="button" onClick={add} disabled={value.length >= 32}><Plus size={13} /> Add tunnel</button>
      </div>
      {value.length === 0 && <div className="tunnel-empty"><ArrowRightLeft size={15} /> No port mappings configured</div>}
      {value.map((tunnel, index) => {
        const localForward = tunnel.direction === "local-to-remote";
        const open = expanded === index;
        const conflict = conflicts.find((item) => item.index === index);
        const conflictName = devices.find((device) => device.id === conflict?.deviceId)?.name ?? "this device";
        const error = conflict ? `${localForward ? "Local" : "Remote"} port ${tunnel.sourcePort} already has a tunnel on ${conflictName}.` : undefined;
        const pending = !saved.some((item) => sameTunnel(item, tunnel));
        const runtime = runtimes.find((item) => item.deviceId === draft.deviceId && sameTunnel(item.tunnel, tunnel));
        return (
          <div className={`tunnel-card ${error ? "has-conflict" : ""}`} key={index}>
            <div className="tunnel-row">
              <button type="button" className="tunnel-toggle" aria-expanded={open} aria-label={`Edit ${localForward ? "local" : "remote"} port ${tunnel.sourcePort} tunnel`} onClick={() => setExpanded(open ? null : index)}>
                <ChevronDown size={13} className={open ? "expanded" : ""} /><TunnelMapping tunnel={tunnel} />
              </button>
              <TunnelStatus runtime={runtime} pending={pending} />
              <button type="button" className="icon-button danger-button" aria-label={`Remove ${localForward ? "local" : "remote"} port ${tunnel.sourcePort} tunnel`} onClick={() => { onChange(value.filter((_, candidate) => candidate !== index)); setExpanded(expanded === index ? null : expanded !== null && expanded > index ? expanded - 1 : expanded); }}><Trash2 size={13} /></button>
            </div>
            {error && <div className="field-error" role="alert">{error}</div>}
            {!pending && runtime?.error && <div className="tunnel-error" role="status">{runtime.error}{runtime.status === "retrying" && " · Reconnects automatically"}</div>}
            {open && <div className="tunnel-editor">
              <Field label="Direction"><select value={tunnel.direction} onChange={(event) => update(index, { direction: event.target.value as SshTunnelConfig["direction"] })}>
                <option value="local-to-remote">Local → Remote</option><option value="remote-to-local">Remote → Local</option>
              </select></Field>
              <div className="tunnel-grid">
                <Field label={localForward ? "Local port" : "Remote port"} error={error}>
                  <input type="number" min="1" max="65535" value={tunnel.sourcePort} onChange={(event) => update(index, { sourcePort: Number(event.target.value) })} required />
                </Field>
                <Field label={localForward ? "Remote host" : "Local host"}><input value={tunnel.destinationHost} onChange={(event) => update(index, { destinationHost: event.target.value })} placeholder="127.0.0.1" required /></Field>
                <Field label={localForward ? "Remote port" : "Local port"}><input type="number" min="1" max="65535" value={tunnel.destinationPort} onChange={(event) => update(index, { destinationPort: Number(event.target.value) })} required /></Field>
              </div>
            </div>}
          </div>
        );
      })}
    </section>
  );
}
