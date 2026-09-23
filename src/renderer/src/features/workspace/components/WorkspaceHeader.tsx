import { ChevronDown, Code2, GitBranch, MoreHorizontal, Plus, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function WorkspaceHeader({ snapshot, workspace }: { snapshot: AppSnapshot; workspace: Workspace }): React.ReactNode {
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const [openingInVSCode, setOpeningInVSCode] = useState(false);
  const { openDialog, setActiveWorkspace } = useWorkbenchStore();
  const workThread = snapshot.workThreads.find((item) => item.id === workspace.workThreadId);
  const project = snapshot.projects.find((item) => item.id === workspace.projectId);
  const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
  const sessions = snapshot.sessions.filter((session) => session.workspaceId === workspace.id);
  const activeCount = sessions.filter((session) => session.status === "running" && session.activityStatus !== "waiting-input").length;
  const waitingCodexCount = sessions.filter((session) => session.kind === "codex" && session.activityStatus === "waiting-input").length;
  const unreadCodexCount = sessions.filter((session) => session.codexResultUnread).length;
  const failedRestoreCount = sessions.filter((session) => session.status === "restore-failed").length;
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
      <button className="workspace-identity no-drag" onClick={() => setDetails(!details)}>
        <div><span>{workThread?.name}</span><i>/</i><span>{project?.name}</span><i>/</i><strong>{workspace.name}</strong></div>
        <p><Server size={12} /> {device?.name}<span>·</span><GitBranch size={12} /> {workspace.branch}</p>
        <ChevronDown size={14} className={details ? "rotated" : ""} />
      </button>
      {(activeCount > 0 || waitingCodexCount > 0 || unreadCodexCount > 0 || failedRestoreCount > 0) && <div className="session-summary no-drag">
        {activeCount > 0 && <span><i className="busy" /> {activeCount} running</span>}
        {waitingCodexCount > 0 && <span><i className="waiting" /> {waitingCodexCount} waiting</span>}
        {unreadCodexCount > 0 && <span><i className="unread" /> {unreadCodexCount} unread</span>}
        {failedRestoreCount > 0 && <span><i className="failed" /> {failedRestoreCount} failed</span>}
      </div>}
      <div className="header-actions no-drag"><button className="button" disabled={workspace.status !== "ready" || openingInVSCode} title="Open this workspace in Visual Studio Code" onClick={() => void openInVSCode()}><Code2 size={14} /> {openingInVSCode ? "Opening…" : "Open in VS Code"}</button><button className="button" onClick={() => openDialog("workspace")}><Plus size={14} /> New</button><div className="menu-anchor"><button className="icon-button" onClick={() => setMenu(!menu)} aria-label="Workspace actions"><MoreHorizontal size={17} /></button>{menu && <div className="context-menu"><button className="danger" onClick={() => void remove()}><Trash2 size={14} /> Delete workspace</button></div>}</div></div>
      {details && <div className="workspace-popover no-drag"><dl><div><dt>Work Thread</dt><dd>{workThread?.name}</dd></div><div><dt>Project</dt><dd>{project?.name}</dd></div><div><dt>Device</dt><dd>{device?.name}</dd></div><div><dt>Branch</dt><dd>{workspace.branch}</dd></div><div><dt>Base</dt><dd>{workspace.baseBranch}</dd></div><div className="full"><dt>Path</dt><dd className="selectable">{workspace.path}</dd></div></dl></div>}
    </header>
  );
}
