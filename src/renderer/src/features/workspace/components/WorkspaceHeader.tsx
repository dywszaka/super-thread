import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Code2, ExternalLink, Focus, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { SidebarReopenButton } from "./Sidebar";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function WorkspaceHeader({ snapshot, workspace }: { snapshot: AppSnapshot; workspace: Workspace }): React.ReactNode {
  const client = useQueryClient();
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const [openingInVSCode, setOpeningInVSCode] = useState(false);
  const [openingTmux, setOpeningTmux] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const detailsPopover = useRef<HTMLDivElement>(null);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const { enterFocusMode, openDialog, setActiveWorkspace } = useWorkbenchStore();
  const workThread = snapshot.workThreads.find((item) => item.id === workspace.workThreadId);
  const project = snapshot.projects.find((item) => item.id === workspace.projectId);
  const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
  const sessions = snapshot.sessions.filter((session) => session.workspaceId === workspace.id);
  const activeCount = sessions.filter((session) => session.status === "running" && session.activityStatus === "busy").length;
  const waitingCount = sessions.filter((session) => session.activityStatus === "waiting-input").length;
  const failedRestoreCount = sessions.filter((session) => session.status === "restore-failed").length;
  const attentionCount = activeCount + waitingCount + failedRestoreCount;
  const sessionSummary = `${activeCount} running · ${waitingCount} waiting · ${failedRestoreCount} restore failed`;
  useEffect(() => {
    if (!details && !menu) return;
    const closeFloatingPanels = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (details && !detailsButton.current?.contains(target) && !detailsPopover.current?.contains(target)) setDetails(false);
      if (menu && !menuAnchor.current?.contains(target)) setMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (details) detailsButton.current?.focus();
      if (menu) menuAnchor.current?.querySelector("button")?.focus();
      setDetails(false);
      setMenu(false);
    };
    window.addEventListener("pointerdown", closeFloatingPanels);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFloatingPanels);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [details, menu]);
  const openInVSCode = async (): Promise<void> => {
    setMenu(false);
    setOpeningInVSCode(true);
    try {
      await window.desktop.openWorkspaceInVSCode(workspace.id);
    } catch (error) {
      toast.error(cleanError(error));
    } finally {
      setOpeningInVSCode(false);
    }
  };
  const openTmuxInIterm = async (): Promise<void> => {
    setMenu(false);
    setOpeningTmux(true);
    try {
      await window.desktop.openWorkspaceTmuxInIterm(workspace.id);
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success("Opened workspace tmux session in iTerm");
    } catch (error) {
      toast.error(cleanError(error));
    } finally {
      setOpeningTmux(false);
    }
  };
  const remove = async (): Promise<void> => {
    setMenu(false);
    const consequence = workspace.kind === "main"
      ? "This removes only the SuperThread workspace and its terminal sessions. The project checkout is kept."
      : `This will delete the Git worktree and branch “${workspace.branch}”.`;
    if (!confirm(`Delete workspace “${workspace.name}”?\n\n${consequence}`)) return;
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
      <button ref={detailsButton} className="workspace-identity no-drag" aria-label="Workspace details" aria-expanded={details} title={`${workspace.name} · ${device?.name ?? ""} · ${workspace.branch}`} onClick={() => { setDetails((open) => !open); setMenu(false); }}>
        <strong title={workspace.name}>{workspace.name}</strong>
        <ChevronDown size={14} className={details ? "rotated" : ""} />
        <span className="workspace-context"><span>·</span><span title={device?.name}>{device?.name}</span><span>·</span><span title={workspace.branch}>{workspace.branch}</span></span>
      </button>
      {attentionCount > 0 && <div className="session-summary no-drag" role="img" aria-label={sessionSummary} title={sessionSummary}><i className={failedRestoreCount ? "failed" : waitingCount ? "waiting" : "busy"} /><span>{attentionCount}</span></div>}
      <div className="header-actions no-drag">
        <button className="icon-button" disabled={workspace.status !== "ready"} aria-label="Enter Focus mode" title="Enter Focus mode" onClick={enterFocusMode}><Focus size={14} /></button>
        <div ref={menuAnchor} className="menu-anchor"><button className="icon-button" onClick={() => { setMenu((open) => !open); setDetails(false); }} aria-label="Workspace actions" title="Workspace actions" aria-expanded={menu}><MoreHorizontal size={17} /></button>{menu && <div className="context-menu">
          <button disabled={workspace.status !== "ready" || openingInVSCode} onClick={() => void openInVSCode()}><Code2 size={14} /> {openingInVSCode ? "Opening…" : "Open in VS Code"}</button>
          <button disabled={workspace.status !== "ready" || openingTmux} onClick={() => void openTmuxInIterm()}><ExternalLink size={14} /> {openingTmux ? "Opening…" : "tmux in iTerm"}</button>
          <button onClick={() => { setMenu(false); openDialog("workspace"); }}><Plus size={14} /> New Workspace</button>
          <div className="context-menu-separator" />
          <button className="danger" onClick={() => void remove()}><Trash2 size={14} /> Delete workspace</button>
        </div>}</div>
      </div>
      {details && <div ref={detailsPopover} className="workspace-popover no-drag"><dl><div><dt>Work Thread</dt><dd>{workThread?.name}</dd></div><div><dt>Project</dt><dd>{project?.name}</dd></div><div><dt>Device</dt><dd>{device?.name}</dd></div><div><dt>Type</dt><dd>{workspace.kind === "main" ? "Main checkout" : "Worktree"}</dd></div><div><dt>Branch</dt><dd>{workspace.branch}</dd></div><div><dt>Base</dt><dd>{workspace.baseBranch}</dd></div><div className="full"><dt>Path</dt><dd className="selectable">{workspace.path}</dd></div></dl></div>}
    </header>
  );
}
