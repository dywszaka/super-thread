import { Box, ChevronRight, Cpu, FolderGit2, Laptop, Plus, Server } from "lucide-react";
import type { AppSnapshot, DeviceStatus } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";

const StatusDot = ({ status }: { status: DeviceStatus }): React.ReactNode => <span className={`status-dot ${status}`} title={status} />;

export function Sidebar({ snapshot }: { snapshot: AppSnapshot }): React.ReactNode {
  const { projectFilter, deviceFilter, setProjectFilter, setDeviceFilter, openDialog } = useWorkbenchStore();
  const counts = (kind: "project" | "device", id: string): number => snapshot.workspaces.filter((workspace) => workspace[`${kind}Id`] === id).length;
  return (
    <aside className="sidebar">
      <div className="sidebar-title drag"><div className="brand no-drag"><span className="brand-mark"><Box size={14} strokeWidth={2.4} /></span><strong>SuperThread</strong></div></div>
      <nav className="sidebar-scroll no-drag">
        <button className={`scope-row all ${!projectFilter && !deviceFilter ? "selected" : ""}`} onClick={() => { setProjectFilter(null); setDeviceFilter(null); }}><span><Cpu size={15} /> All workspaces</span><b>{snapshot.workspaces.length}</b></button>
        <div className="section-heading"><span>Projects</span><button className="mini-action" onClick={() => openDialog("project")} title="Add project"><Plus size={14} /></button></div>
        <div className="scope-list">
          {snapshot.projects.length === 0 && <p className="sidebar-empty">No projects yet</p>}
          {snapshot.projects.map((project) => <button key={project.id} className={`scope-row ${projectFilter === project.id ? "selected" : ""}`} onClick={() => setProjectFilter(project.id)}><span><FolderGit2 size={15} /> <em>{project.name}</em></span><b>{counts("project", project.id)}</b></button>)}
        </div>
        <div className="sidebar-separator" />
        <div className="section-heading"><span>Devices</span><button className="mini-action" onClick={() => openDialog("device")} title="Add device"><Plus size={14} /></button></div>
        <div className="scope-list">
          {snapshot.devices.map((device) => <button key={device.id} className={`scope-row ${deviceFilter === device.id ? "selected" : ""}`} onClick={() => setDeviceFilter(device.id)}><span>{device.type === "local" ? <Laptop size={15} /> : <Server size={15} />}<StatusDot status={device.status} /><em>{device.name}</em></span><b>{counts("device", device.id)}</b></button>)}
        </div>
      </nav>
      <div className="sidebar-footer no-drag"><button onClick={() => openDialog("device")}><Server size={14} /> Manage devices <ChevronRight size={13} /></button></div>
    </aside>
  );
}
