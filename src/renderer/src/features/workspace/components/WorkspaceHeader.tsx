import { ChevronDown, GitBranch, MoreHorizontal, Plus, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function WorkspaceHeader({ snapshot, workspace }: { snapshot: AppSnapshot; workspace: Workspace }): React.ReactNode {
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const { openDialog, setActiveWorkspace } = useWorkbenchStore();
  const workThread = snapshot.workThreads.find((item) => item.id === workspace.workThreadId);
  const project = snapshot.projects.find((item) => item.id === workspace.projectId);
  const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
  const remove = async (): Promise<void> => {
    setMenu(false);
    if (!confirm(`Delete workspace “${workspace.name}”?\n\nThe Git branch will be kept.`)) return;
    try {
      await window.desktop.deleteWorkspace(workspace.id);
      setActiveWorkspace(null);
      toast.success("Workspace deleted");
    } catch (error) {
      const text = cleanError(error);
      if (text.includes("uncommitted changes") && confirm(`${text}\n\nForce delete this worktree?`)) {
        try { await window.desktop.deleteWorkspace(workspace.id, true); setActiveWorkspace(null); toast.success("Workspace force deleted"); }
        catch (forceError) { toast.error(cleanError(forceError)); }
      } else toast.error(text);
    }
  };
  return (
    <header className="workspace-header drag">
      <button className="workspace-identity no-drag" onClick={() => setDetails(!details)}>
        <div><span>{workThread?.name}</span><i>/</i><span>{project?.name}</span><i>/</i><strong>{workspace.name}</strong></div>
        <p><Server size={12} /> {device?.name}<span>·</span><GitBranch size={12} /> {workspace.branch}</p>
        <ChevronDown size={14} className={details ? "rotated" : ""} />
      </button>
      <div className="header-actions no-drag"><button className="button" onClick={() => openDialog("workspace")}><Plus size={14} /> New</button><div className="menu-anchor"><button className="icon-button" onClick={() => setMenu(!menu)} aria-label="Workspace actions"><MoreHorizontal size={17} /></button>{menu && <div className="context-menu"><button className="danger" onClick={() => void remove()}><Trash2 size={14} /> Delete workspace</button></div>}</div></div>
      {details && <div className="workspace-popover no-drag"><dl><div><dt>Work Thread</dt><dd>{workThread?.name}</dd></div><div><dt>Project</dt><dd>{project?.name}</dd></div><div><dt>Device</dt><dd>{device?.name}</dd></div><div><dt>Branch</dt><dd>{workspace.branch}</dd></div><div><dt>Base</dt><dd>{workspace.baseBranch}</dd></div><div className="full"><dt>Path</dt><dd className="selectable">{workspace.path}</dd></div></dl></div>}
    </header>
  );
}
