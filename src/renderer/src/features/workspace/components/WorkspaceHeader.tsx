import { ChevronDown, Code2, Focus, GitBranch, MoreHorizontal, Plus, Server, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { SidebarReopenButton } from "./Sidebar";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function WorkspaceHeader({ snapshot, workspace }: { snapshot: AppSnapshot; workspace: Workspace }): React.ReactNode {
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const [openingInVSCode, setOpeningInVSCode] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const detailsPopover = useRef<HTMLDivElement>(null);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const { enterFocusMode, openDialog, setActiveWorkspace } = useWorkbenchStore();
  const workThread = snapshot.workThreads.find((item) => item.id === workspace.workThreadId);
  const project = snapshot.projects.find((item) => item.id === workspace.projectId);
  const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
  const sessions = snapshot.sessions.filter((session) => session.workspaceId === workspace.id);
  const activeCount = sessions.filter((session) => session.status === "running" && session.activityStatus === "busy").length;
  const waitingCodexCount = sessions.filter((session) => session.activityStatus === "waiting-input").length;
  const failedRestoreCount = sessions.filter((session) => session.status === "restore-failed").length;
  useEffect(() => {
    if (!details && !menu) return;
    const closeFloatingPanels = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (details && !detailsButton.current?.contains(target) && !detailsPopover.current?.contains(target)) setDetails(false);
      if (menu && !menuAnchor.current?.contains(target)) setMenu(false);
    };
    window.addEventListener("pointerdown", closeFloatingPanels);
    return () => window.removeEventListener("pointerdown", closeFloatingPanels);
  }, [details, menu]);
  const openInVSCode = async (): Promise<void> => {
    setOpeningInVSCode(true);
    try {
      await window.desktop.openWorkspaceInVSCode(workspace.id);
    } catch (error) {
      toast.error(cleanError(error));
    } finally {
      setOpeningInVSCode(false);
    }
  };
  const remove = async (): Promise<void> => {
    setMenu(false);
    if (!confirm(`Delete workspace “${workspace.name}”?\n\nThis will delete the Git worktree and branch “${workspace.branch}”.`)) return;
    try {
      await window.desktop.deleteWorkspace(workspace.id);
      setActiveWorkspace(null);
      toast.success("Workspace deleted");
    } catch (error) {
      const text = cleanError(error);
      if (text.includes("Workspace delete blocked") && confirm(`${text}\n\nForce delete this worktree and branch?`)) {
        try { await window.desktop.deleteWorkspace(workspace.id, true); setActiveWorkspace(null); toast.success("Workspace force deleted"); }
        catch (forceError) { toast.error(cleanError(forceError)); }
      } else toast.error(text);
    }
  };
  return (
    <header className="workspace-header drag">
      <SidebarReopenButton />
      <button ref={detailsButton} className="workspace-identity no-drag" onClick={() => { setDetails((open) => !open); setMenu(false); }}>
        <div><span>{workThread?.name}</span><i>/</i><span>{project?.name}</span><i>/</i><strong>{workspace.name}</strong></div>
        <p><Server size={12} /> {device?.name}<span>·</span><GitBranch size={12} /> {workspace.branch}</p>
        <ChevronDown size={14} className={details ? "rotated" : ""} />
      </button>
      {(activeCount > 0 || waitingCodexCount > 0 || failedRestoreCount > 0) && <div className="session-summary no-drag">
        {activeCount > 0 && <span><i className="busy" /> {activeCount} running</span>}
        {waitingCodexCount > 0 && <span><i className="waiting" /> {waitingCodexCount} waiting</span>}
        {failedRestoreCount > 0 && <span><i className="failed" /> {failedRestoreCount} failed</span>}
      </div>}
      <div className="header-actions no-drag"><button className="button" disabled={workspace.status !== "ready"} title="Enter Focus mode" onClick={enterFocusMode}><Focus size={14} /> Focus</button><button className="button" disabled={workspace.status !== "ready" || openingInVSCode} title="Open this workspace in Visual Studio Code" onClick={() => void openInVSCode()}><Code2 size={14} /> {openingInVSCode ? "Opening…" : "Open in VS Code"}</button><button className="button" onClick={() => openDialog("workspace")}><Plus size={14} /> New</button><div ref={menuAnchor} className="menu-anchor"><button className="icon-button" onClick={() => { setMenu((open) => !open); setDetails(false); }} aria-label="Workspace actions"><MoreHorizontal size={17} /></button>{menu && <div className="context-menu"><button className="danger" onClick={() => void remove()}><Trash2 size={14} /> Delete workspace</button></div>}</div></div>
      {details && <div ref={detailsPopover} className="workspace-popover no-drag"><dl><div><dt>Work Thread</dt><dd>{workThread?.name}</dd></div><div><dt>Project</dt><dd>{project?.name}</dd></div><div><dt>Device</dt><dd>{device?.name}</dd></div><div><dt>Branch</dt><dd>{workspace.branch}</dd></div><div><dt>Base</dt><dd>{workspace.baseBranch}</dd></div><div className="full"><dt>Path</dt><dd className="selectable">{workspace.path}</dd></div></dl></div>}
    </header>
  );
}
