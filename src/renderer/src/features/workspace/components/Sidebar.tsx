import { Archive, ChevronDown, ChevronLeft, ChevronRight, FolderGit2, Laptop, Layers3, MessagesSquare, MonitorCog, Pencil, Pin, Plus, Server } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, WorkThread, Workspace } from "@/shared/domain";
import appIcon from "../../../assets/icon.png";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { sortedWorkThreads, visibleWorkspaces, workspaceProjectName } from "../selection";
import { EditWorkspaceDialog } from "./EditWorkspaceDialog";
import { RenameWorkThreadDialog } from "./RenameWorkThreadDialog";

interface WorkThreadMenuState {
  thread: WorkThread;
  x: number;
  y: number;
}

interface WorkspaceMenuState {
  workspace: Workspace;
  x: number;
  y: number;
}

const cleanError = (error: unknown): string => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': /, "")
  : String(error);

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
  const threadMenuRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const [threadMenu, setThreadMenu] = useState<WorkThreadMenuState | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<WorkspaceMenuState | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadMenuBusy, setThreadMenuBusy] = useState(false);
  const activeThreads = useMemo(() => sortedWorkThreads(snapshot.workThreads.filter((thread) => thread.status === "active")), [snapshot.workThreads]);
  const allActiveWorkspaces = useMemo(() => visibleWorkspaces(snapshot, { type: "all-workspaces" }), [snapshot]);
  const editingWorkspace = snapshot.workspaces.find((workspace) => workspace.id === editingWorkspaceId);
  const renamingThread = snapshot.workThreads.find((thread) => thread.id === renamingThreadId);

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

  useEffect(() => {
    if (!threadMenu && !workspaceMenu) return;
    const close = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!threadMenuRef.current?.contains(target)) setThreadMenu(null);
      if (!workspaceMenuRef.current?.contains(target)) setWorkspaceMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { setThreadMenu(null); setWorkspaceMenu(null); }
    };
    const closeOnBlur = (): void => { setThreadMenu(null); setWorkspaceMenu(null); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [threadMenu, workspaceMenu]);

  const openThreadMenu = (event: React.MouseEvent, thread: WorkThread): void => {
    event.preventDefault();
    const width = 184;
    const height = 124;
    setWorkspaceMenu(null);
    setThreadMenu({
      thread,
      x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(event.clientY, window.innerHeight - height - 6))
    });
  };

  const openWorkspaceMenu = (event: React.MouseEvent, workspace: Workspace): void => {
    event.preventDefault();
    const width = 184;
    const height = 44;
    setThreadMenu(null);
    setWorkspaceMenu({
      workspace,
      x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(event.clientY, window.innerHeight - height - 6))
    });
  };

  const editWorkspace = (): void => {
    const workspace = workspaceMenu?.workspace;
    if (!workspace) return;
    setWorkspaceMenu(null);
    setEditingWorkspaceId(workspace.id);
  };

  const renameThread = (): void => {
    const thread = threadMenu?.thread;
    if (!thread) return;
    setThreadMenu(null);
    setRenamingThreadId(thread.id);
  };

  const setPinned = async (pinned: boolean): Promise<void> => {
    const thread = threadMenu?.thread;
    if (!thread) return;
    setThreadMenu(null);
    if (thread.pinned === pinned) return;
    setThreadMenuBusy(true);
    try {
      await window.desktop.setWorkThreadPinned({ id: thread.id, pinned });
    } catch (error) {
      toast.error(cleanError(error));
    } finally {
      setThreadMenuBusy(false);
    }
  };

  const archiveThread = async (): Promise<void> => {
    const thread = threadMenu?.thread;
    if (!thread) return;
    setThreadMenu(null);
    if (!confirm(`Archive “${thread.name}”?\n\nIts workspaces will be hidden from active views. Running terminal sessions will continue.`)) return;
    setThreadMenuBusy(true);
    try {
      await window.desktop.archiveWorkThread(thread.id);
      toast.success(`${thread.name} archived`);
    } catch (error) {
      toast.error(cleanError(error));
    } finally {
      setThreadMenuBusy(false);
    }
  };

  if (sidebarCollapsed) return null;

  return (
    <aside className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
      <div className="sidebar-title drag"><div className="brand no-drag"><img className="brand-mark" src={appIcon} alt="Super Thread" /></div><button className="sidebar-collapse no-drag" onClick={() => setSidebarCollapsed(true)} title="Hide sidebar"><ChevronLeft size={15} /></button></div>
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
                <div className={`thread-row ${isSelected ? "selected" : ""}`} onContextMenu={(event) => openThreadMenu(event, thread)}>
                  <button className="thread-disclosure" onClick={() => toggleThreadExpanded(thread.id)} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${thread.name}`}>
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <button className="thread-scope" onClick={() => setWorkThreadFilter(thread.id)}>{thread.pinned ? <span className="thread-pinned-indicator" title="Pinned"><Pin size={14} /></span> : <MessagesSquare size={14} />}<em>{thread.name}</em></button>
                </div>
                {isExpanded && <div className="thread-children">
                  {workspaces.length === 0 && <p className="thread-empty">No workspaces</p>}
                  {workspaces.map((workspace) => {
                    const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
                    const Icon = device?.type === "remote" ? Server : Laptop;
                    return <button key={workspace.id} className={`workspace-tree-row ${activeWorkspaceId === workspace.id && isSelected ? "selected" : ""}`} onContextMenu={(event) => openWorkspaceMenu(event, workspace)} onClick={() => { setWorkThreadFilter(thread.id); setActiveWorkspace(workspace.id); }}><Icon size={13} /><span><strong>{workspace.name}</strong><small>{workspaceProjectName(snapshot, workspace)}</small></span></button>;
                  })}
                </div>}
              </div>
            );
          })}
        </div>
      </nav>
      {threadMenu && <div
        ref={threadMenuRef}
        className="work-thread-context-menu no-drag"
        role="menu"
        aria-label={`${threadMenu.thread.name} actions`}
        style={{ left: threadMenu.x, top: threadMenu.y }}
      >
        <button type="button" disabled={threadMenuBusy} onClick={renameThread}><Pencil size={13} /><span>Rename work thread…</span></button>
        <div className="context-menu-separator" />
        <button type="button" disabled={threadMenuBusy} onClick={() => void setPinned(!threadMenu.thread.pinned)}>
          <Pin size={13} />
          <span>{threadMenu.thread.pinned ? "Unpin work thread" : "Pin work thread"}</span>
        </button>
        <div className="context-menu-separator" />
        <button type="button" disabled={threadMenuBusy} onClick={() => void archiveThread()}><Archive size={13} /><span>Archive work thread</span></button>
      </div>}
      {workspaceMenu && <div
        ref={workspaceMenuRef}
        className="work-thread-context-menu no-drag"
        role="menu"
        aria-label={`${workspaceMenu.workspace.name} actions`}
        style={{ left: workspaceMenu.x, top: workspaceMenu.y }}
      >
        <button type="button" onClick={editWorkspace}><Pencil size={13} /><span>Edit workspace…</span></button>
      </div>}
      <div className="sidebar-resize no-drag" onPointerDown={(event) => { resizing.current = true; event.currentTarget.setPointerCapture(event.pointerId); }} />
      <EditWorkspaceDialog snapshot={snapshot} workspace={editingWorkspace} onClose={() => setEditingWorkspaceId(null)} />
      <RenameWorkThreadDialog thread={renamingThread} onClose={() => setRenamingThreadId(null)} />
    </aside>
  );
}

export function SidebarReopenButton(): React.ReactNode {
  const { sidebarCollapsed, setSidebarCollapsed } = useWorkbenchStore();
  if (!sidebarCollapsed) return null;

  return <button className="sidebar-reopen no-drag" onClick={() => setSidebarCollapsed(false)} aria-label="Show sidebar" title="Show sidebar"><ChevronRight size={16} /></button>;
}
