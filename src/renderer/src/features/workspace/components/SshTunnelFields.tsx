import { ArrowRightLeft, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { SshTunnelConfig } from "@/shared/domain";
import { Field } from "./Modal";

export function SshTunnelFields({ value, onChange }: { value: SshTunnelConfig[]; onChange(value: SshTunnelConfig[]): void }): ReactNode {
  const update = (index: number, patch: Partial<SshTunnelConfig>): void => {
    onChange(value.map((tunnel, candidate) => candidate === index ? { ...tunnel, ...patch } : tunnel));
  };
  const add = (): void => {
    const used = new Set(value.filter((tunnel) => tunnel.direction === "local-to-remote").map((tunnel) => tunnel.sourcePort));
    let port = 3000;
    while (used.has(port)) port += 1;
    onChange([...value, { direction: "local-to-remote", sourcePort: port, destinationHost: "127.0.0.1", destinationPort: port }]);
  };

  return (
    <section className="tunnel-section">
      <div className="tunnel-heading">
        <div><strong>SSH tunnels</strong><span>Forward loopback ports while SuperThread is running. Connections recover automatically.</span></div>
        <button type="button" className="button" onClick={add}><Plus size={13} /> Add tunnel</button>
      </div>
      {value.length === 0 && <div className="tunnel-empty"><ArrowRightLeft size={15} /> No port mappings configured</div>}
      {value.map((tunnel, index) => {
        const localForward = tunnel.direction === "local-to-remote";
        return (
          <div className="tunnel-card" key={`${index}-${tunnel.direction}`}>
            <div className="tunnel-card-head">
              <Field label="Direction">
                <select value={tunnel.direction} onChange={(event) => update(index, { direction: event.target.value as SshTunnelConfig["direction"] })}>
                  <option value="local-to-remote">Local → Remote</option>
                  <option value="remote-to-local">Remote → Local</option>
                </select>
              </Field>
              <button type="button" className="icon-button danger-button" title="Remove tunnel" onClick={() => onChange(value.filter((_, candidate) => candidate !== index))}><Trash2 size={13} /></button>
            </div>
            <div className="tunnel-grid">
              <Field label={localForward ? "Local port" : "Remote port"}>
                <input type="number" min="1" max="65535" value={tunnel.sourcePort} onChange={(event) => update(index, { sourcePort: Number(event.target.value) })} required />
              </Field>
              <Field label={localForward ? "Remote host" : "Local host"}>
                <input value={tunnel.destinationHost} onChange={(event) => update(index, { destinationHost: event.target.value })} placeholder="127.0.0.1" required />
              </Field>
              <Field label={localForward ? "Remote port" : "Local port"}>
                <input type="number" min="1" max="65535" value={tunnel.destinationPort} onChange={(event) => update(index, { destinationPort: Number(event.target.value) })} required />
              </Field>
            </div>
          </div>
        );
      })}
    </section>
  );
}
