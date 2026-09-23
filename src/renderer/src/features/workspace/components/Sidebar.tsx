import { ChevronDown, ChevronLeft, ChevronRight, FolderGit2, Layers3, MessagesSquare, MonitorCog, Plus } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { AppSnapshot } from "@/shared/domain";
import appIcon from "../../../assets/icon.png";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { visibleWorkspaces, workspaceProjectName } from "../selection";

export function Sidebar({ snapshot }: { snapshot: AppSnapshot }): React.ReactNode {
  const {
    scope,
    activeWorkspaceId,
    sidebarCollapsed,
    sidebarWidth,
    expandedThreadIds,
    showAllWorkspaces,
    showAllProjects,
    showAllWorkThreads,
    showAllDevices,
    setWorkThreadFilter,
    setActiveWorkspace,
    setSidebarCollapsed,
    setSidebarWidth,
    toggleThreadExpanded,
    openDialog
  } = useWorkbenchStore();
  const resizing = useRef(false);
  const activeThreads = useMemo(() => snapshot.workThreads.filter((thread) => thread.status === "active"), [snapshot.workThreads]);
  const allActiveWorkspaces = useMemo(() => visibleWorkspaces(snapshot, { type: "all-workspaces" }), [snapshot]);

  useEffect(() => {
    const move = (event: PointerEvent): void => { if (resizing.current) setSidebarWidth(event.clientX); };
    const up = (): void => { resizing.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [setSidebarWidth]);

  if (sidebarCollapsed) {
    return <button className="sidebar-reopen no-drag" onClick={() => setSidebarCollapsed(false)} title="Show sidebar"><ChevronRight size={16} /></button>;
  }

  return (
    <aside className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
      <div className="sidebar-title drag"><div className="brand no-drag"><img className="brand-mark" src={appIcon} alt="" /><strong>Super Thread</strong></div><button className="sidebar-collapse no-drag" onClick={() => setSidebarCollapsed(true)} title="Hide sidebar"><ChevronLeft size={15} /></button></div>
      <nav className="sidebar-scroll no-drag">
        <div className="primary-scopes">
          <button className={`scope-row all ${scope.type === "all-workspaces" ? "selected" : ""}`} onClick={showAllWorkspaces}><span><Layers3 size={15} /> All workspaces</span><b>{allActiveWorkspaces.length}</b></button>
          <button className={`scope-row all ${scope.type === "all-projects" ? "selected" : ""}`} onClick={showAllProjects}><span><FolderGit2 size={15} /> All projects</span><b>{snapshot.projects.length}</b></button>
          <button className={`scope-row all ${scope.type === "all-work-threads" ? "selected" : ""}`} onClick={showAllWorkThreads}><span><MessagesSquare size={15} /> All work threads</span><b>{snapshot.workThreads.length}</b></button>
          <button className={`scope-row all ${scope.type === "all-devices" ? "selected" : ""}`} onClick={showAllDevices}><span><MonitorCog size={15} /> All devices</span><b>{snapshot.devices.length}</b></button>
        </div>

        <div className="sidebar-separator" />
        <div className="section-heading"><span>Work Threads</span><button className="mini-action" onClick={() => openDialog("workThread")} title="New work thread"><Plus size={14} /></button></div>
        <div className="scope-list thread-list">
          {activeThreads.length === 0 && <p className="sidebar-empty">No active work threads</p>}
          {activeThreads.map((thread) => {
            const workspaces = snapshot.workspaces.filter((workspace) => workspace.workThreadId === thread.id);
            const isExpanded = expandedThreadIds.includes(thread.id);
            const isSelected = scope.type === "work-thread" && scope.id === thread.id;
            return (
              <div className="thread-tree" key={thread.id}>
                <div className={`thread-row ${isSelected ? "selected" : ""}`}>
                  <button className="thread-disclosure" onClick={() => toggleThreadExpanded(thread.id)} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${thread.name}`}>
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <button className="thread-scope" onClick={() => setWorkThreadFilter(thread.id)}><MessagesSquare size={14} /><em>{thread.name}</em></button>
                  <b>{workspaces.length}</b>
                </div>
                {isExpanded && <div className="thread-children">
                  {workspaces.length === 0 && <p className="thread-empty">No workspaces</p>}
                  {workspaces.map((workspace) => <button key={workspace.id} className={`workspace-tree-row ${activeWorkspaceId === workspace.id && isSelected ? "selected" : ""}`} onClick={() => { setWorkThreadFilter(thread.id); setActiveWorkspace(workspace.id); }}><FolderGit2 size={13} /><span><strong>{workspace.name}</strong><small>{workspaceProjectName(snapshot, workspace)}</small></span></button>)}
                </div>}
              </div>
            );
          })}
        </div>
      </nav>
      <div className="sidebar-resize no-drag" onPointerDown={(event) => { resizing.current = true; event.currentTarget.setPointerCapture(event.pointerId); }} />
    </aside>
  );
}
