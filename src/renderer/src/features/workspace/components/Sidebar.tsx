import { Archive, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, FolderGit2, Laptop, Layers3, MessagesSquare, MonitorCog, Plus, Server } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, WorkThread, WorkThreadPriority } from "@/shared/domain";
import appIcon from "../../../assets/icon.png";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { sortedWorkThreads, visibleWorkspaces, workspaceProjectName } from "../selection";
import { WorkThreadPriorityIcon } from "./WorkThreadPriorityMenu";

interface WorkThreadMenuState {
  thread: WorkThread;
  x: number;
  y: number;
}

const priorities: ReadonlyArray<{ value: WorkThreadPriority; label: string }> = [
  { value: "high", label: "High priority" },
  { value: "normal", label: "Normal priority" },
  { value: "low", label: "Low priority" }
];

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
  const [threadMenu, setThreadMenu] = useState<WorkThreadMenuState | null>(null);
  const [threadMenuBusy, setThreadMenuBusy] = useState(false);
  const activeThreads = useMemo(() => sortedWorkThreads(snapshot.workThreads.filter((thread) => thread.status === "active")), [snapshot.workThreads]);
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

  useEffect(() => {
    if (!threadMenu) return;
    const close = (event: PointerEvent): void => {
      if (!threadMenuRef.current?.contains(event.target as Node)) setThreadMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setThreadMenu(null);
    };
    const closeOnBlur = (): void => setThreadMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [threadMenu]);

  const openThreadMenu = (event: React.MouseEvent, thread: WorkThread): void => {
    event.preventDefault();
    const width = 184;
    const height = 158;
    setThreadMenu({
      thread,
      x: Math.max(6, Math.min(event.clientX, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(event.clientY, window.innerHeight - height - 6))
    });
  };

  const setPriority = async (priority: WorkThreadPriority): Promise<void> => {
    const thread = threadMenu?.thread;
    if (!thread) return;
    setThreadMenu(null);
    if (thread.priority === priority) return;
    setThreadMenuBusy(true);
    try {
      await window.desktop.setWorkThreadPriority({ id: thread.id, priority });
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
                  <button className="thread-scope" onClick={() => setWorkThreadFilter(thread.id)}>{thread.priority === "normal" ? <MessagesSquare size={14} /> : <span className={`thread-priority-indicator ${thread.priority}`} title={`${thread.priority} priority`}><WorkThreadPriorityIcon priority={thread.priority} /></span>}<em>{thread.name}</em></button>
                </div>
                {isExpanded && <div className="thread-children">
                  <button className={`workspace-tree-row ${isSelected && !activeWorkspaceId ? "selected" : ""}`} onClick={() => setWorkThreadFilter(thread.id)}><FileText size={13} /><span><strong>Document</strong><small>Markdown</small></span></button>
                  {workspaces.map((workspace) => {
                    const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
                    const Icon = device?.type === "remote" ? Server : Laptop;
                    return <button key={workspace.id} className={`workspace-tree-row ${activeWorkspaceId === workspace.id && isSelected ? "selected" : ""}`} onClick={() => { setWorkThreadFilter(thread.id); setActiveWorkspace(workspace.id); }}><Icon size={13} /><span><strong>{workspace.name}</strong><small>{workspaceProjectName(snapshot, workspace)}</small></span></button>;
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
        <div className="context-menu-label">Priority</div>
        {priorities.map((item) => <button
          type="button"
          role="menuitemradio"
          aria-checked={threadMenu.thread.priority === item.value}
          disabled={threadMenuBusy}
          key={item.value}
          onClick={() => void setPriority(item.value)}
        >
          <WorkThreadPriorityIcon priority={item.value} />
          <span>{item.label}</span>
          {threadMenu.thread.priority === item.value && <Check size={13} />}
        </button>)}
        <div className="context-menu-separator" />
        <button type="button" disabled={threadMenuBusy} onClick={() => void archiveThread()}><Archive size={13} /><span>Archive work thread</span></button>
      </div>}
      <div className="sidebar-resize no-drag" onPointerDown={(event) => { resizing.current = true; event.currentTarget.setPointerCapture(event.pointerId); }} />
    </aside>
  );
}

export function SidebarReopenButton(): React.ReactNode {
  const { sidebarCollapsed, setSidebarCollapsed } = useWorkbenchStore();
  if (!sidebarCollapsed) return null;

  return <button className="sidebar-reopen no-drag" onClick={() => setSidebarCollapsed(false)} aria-label="Show sidebar" title="Show sidebar"><ChevronRight size={16} /></button>;
}
