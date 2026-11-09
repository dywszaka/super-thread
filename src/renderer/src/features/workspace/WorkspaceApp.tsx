import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Box, Focus, FolderGit2, Plus, Server } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../state/workbench-store";
import { Sidebar, SidebarReopenButton } from "./components/Sidebar";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceDialogs } from "./components/Dialogs";
import { DeviceList } from "./components/DeviceList";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { WorkThreadList } from "./components/WorkThreadList";
import { WorkspaceList } from "./components/WorkspaceList";
import { ProjectList } from "./components/ProjectList";
import { AllTodos } from "./components/TodoList";
import { WorkThreadDocument } from "./components/WorkThreadDocument";
import { WorkThreadAgeProvider } from "./components/WorkThreadAge";
import { useDocumentAutosaveLifecycle } from "./document-autosave";
import { visibleWorkspaces } from "./selection";

export function WorkspaceApp(): React.ReactNode {
  const { data: snapshot, error, isLoading } = useQuery({ queryKey: ["snapshot"], queryFn: () => window.desktop.snapshot() });
  const store = useWorkbenchStore();
  const client = useQueryClient();
  const scope = store.scope;
  useDocumentAutosaveLifecycle(snapshot?.workThreads);
  const documentThread = scope.type === "work-thread" && !store.activeWorkspaceId
    ? snapshot?.workThreads.find((thread) => thread.id === scope.id && thread.status === "active")
    : undefined;
  const filtered = useMemo(() => snapshot ? visibleWorkspaces(snapshot, scope) : [], [snapshot, scope]);
  const selected = filtered.find((workspace) => workspace.id === store.activeWorkspaceId);
  const active: Workspace | undefined = selected ?? (scope.type === "all-workspaces" ? undefined : filtered[0]);
  const hasSnapshot = Boolean(snapshot);
  const showingOverview = scope.type === "all-workspaces" && !selected;
  const showingWorkspace = !showingOverview && !documentThread && scope.type !== "all-projects" && scope.type !== "all-work-threads" && scope.type !== "all-devices" && scope.type !== "all-todos";
  const showingTerminal = showingWorkspace && active?.status === "ready";
  const focusMode = store.focusMode && showingTerminal;

  useEffect(() => {
    if (showingOverview) {
      if (hasSnapshot && store.activeWorkspaceId) store.setActiveWorkspace(null);
      return;
    }
    if (documentThread) return;
    if (store.scope.type === "all-todos" || store.scope.type === "all-projects" || store.scope.type === "all-work-threads" || store.scope.type === "all-devices") return;
    if (active && active.id !== store.activeWorkspaceId) store.setActiveWorkspace(active.id);
    if (!active && store.activeWorkspaceId) store.setActiveWorkspace(null);
  }, [active?.id, store.scope.type, documentThread?.id, showingOverview, hasSnapshot, store.activeWorkspaceId]);
  useEffect(() => {
    if (!showingTerminal && store.focusMode) store.exitFocusMode();
  }, [showingTerminal, store.focusMode]);
  useEffect(() => window.desktop.onBrowserCreated((tab) => {
    void client.invalidateQueries({ queryKey: ["snapshot"] }).then(() => {
      store.setActiveWorkspace(tab.workspaceId);
      store.setActiveSession(tab.workspaceId, tab.id);
    });
  }), [client]);
  useEffect(() => window.desktop.onFilePreviewCreated((tab) => {
    void client.invalidateQueries({ queryKey: ["snapshot"] }).then(() => {
      store.setActiveWorkspace(tab.workspaceId);
      store.setActiveSession(tab.workspaceId, tab.id);
    });
  }), [client]);
  useEffect(() => window.desktop.setFocusMode(focusMode), [focusMode]);
  useEffect(() => window.desktop.onMenuAction((action) => {
    if (useWorkbenchStore.getState().dialog) return;
    if (action === "settings") store.openDialog("settings");
    if (action === "new-work-thread") store.openDialog("workThread");
    if (action === "new-workspace") {
      const { scope, openWorkspaceDialog } = useWorkbenchStore.getState();
      openWorkspaceDialog(scope.type === "work-thread" ? scope.id : undefined);
    }
    if (action === "add-project") store.openDialog("project");
    if (action === "add-device") store.openDialog("device");
    if (action === "new-terminal" && showingTerminal && active) store.requestSessionCreate(active.id, "shell");
  }), [active?.id, showingTerminal]);

  if (isLoading || !snapshot) return <div className="boot-screen drag"><div className="boot-logo"><Box size={22} /><span /></div></div>;
  if (error) throw error;
  const scopeTitle = scope.type === "project"
    ? snapshot.projects.find((item) => item.id === scope.id)?.name
    : scope.type === "work-thread"
      ? snapshot.workThreads.find((item) => item.id === scope.id)?.name
      : "All workspaces";
  return (
    <WorkThreadAgeProvider settings={snapshot.settings}><div className={`app-frame ${store.sidebarCollapsed ? "sidebar-is-collapsed" : ""} ${focusMode ? "focus-mode" : ""}`}>
      {!focusMode && <Sidebar snapshot={snapshot} />}
      <div className="workbench">
        {focusMode ? <FocusTitlebar /> : store.scope.type === "all-todos" ? <AllTodos snapshot={snapshot} /> : store.scope.type === "all-projects" ? <ProjectList snapshot={snapshot} /> : store.scope.type === "all-work-threads" ? <WorkThreadList snapshot={snapshot} /> : store.scope.type === "all-devices" ? <DeviceList snapshot={snapshot} /> : showingOverview ? <WorkspaceList snapshot={snapshot} /> : documentThread ? <WorkThreadDocument key={documentThread.id} thread={documentThread} /> : <>
          {active ? <><WorkspaceHeader key={active.id} snapshot={snapshot} workspace={active} />{active.status !== "ready" && <div className="workspace-error"><AlertTriangle size={28} /><h3>{active.status === "creating" ? "Creating workspace…" : "Workspace creation failed"}</h3><p className="selectable">{active.error}</p></div>}</> : <EmptyWorkspace title={scopeTitle || "Workspaces"} hasProjects={snapshot.projects.length > 0} workThreadId={scope.type === "work-thread" ? scope.id : undefined} />}
        </>}
        <div className={`workspace-terminal-stack ${showingTerminal ? "active" : ""}`}>
          {snapshot.workspaces.filter((workspace) => workspace.status === "ready").map((workspace) => {
            const visible = showingTerminal && active?.id === workspace.id;
            return <div key={workspace.id} className={`workspace-terminal-view ${visible ? "active" : ""}`} aria-hidden={!visible}><TerminalPane snapshot={snapshot} workspace={workspace} visible={visible} /></div>;
          })}
        </div>
      </div>
      <WorkspaceDialogs snapshot={snapshot} />
    </div></WorkThreadAgeProvider>
  );
}

function FocusTitlebar(): React.ReactNode {
  const exitFocusMode = useWorkbenchStore((state) => state.exitFocusMode);
  return (
    <header className="focus-titlebar drag">
      <button className="button no-drag" onClick={exitFocusMode} title="Exit Focus mode"><Focus size={14} /> Exit Focus</button>
    </header>
  );
}

function EmptyWorkspace({ title, hasProjects, workThreadId }: { title: string; hasProjects: boolean; workThreadId?: string }): React.ReactNode {
  const { openDialog, openWorkspaceDialog } = useWorkbenchStore();
  const action = hasProjects ? "New Workspace" : "Add Project";
  const open = (): void => {
    if (hasProjects) openWorkspaceDialog(workThreadId);
    else openDialog("project");
  };
  return (
    <main className="empty-workspace">
      <div className="empty-titlebar drag"><SidebarReopenButton /><span className="no-drag">{title}</span><button className="button primary no-drag" onClick={open}><Plus size={14} /> {action}</button></div>
      <section><div className="empty-art"><Server size={28} /><span /><FolderGit2 size={28} /></div><h1>{hasProjects ? "Create your first workspace" : "Bring in a Git project"}</h1><p>{hasProjects ? "Choose a project and device, then use its main checkout or create an isolated worktree." : "Import a local repository or clone one onto a connected device."}</p><button className="button primary large" onClick={open}><Plus size={15} /> {action}</button></section>
    </main>
  );
}
