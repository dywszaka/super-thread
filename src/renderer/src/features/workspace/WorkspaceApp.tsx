import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Box, FolderGit2, Plus, Server } from "lucide-react";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import type { Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../state/workbench-store";
import { Sidebar } from "./components/Sidebar";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceDialogs } from "./components/Dialogs";
import { DeviceList } from "./components/DeviceList";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { WorkThreadList } from "./components/WorkThreadList";
import { ProjectList } from "./components/ProjectList";
import { visibleWorkspaces } from "./selection";

export function WorkspaceApp(): React.ReactNode {
  const { data: snapshot, error, isLoading } = useQuery({ queryKey: ["snapshot"], queryFn: () => window.desktop.snapshot() });
  const store = useWorkbenchStore();
  const scope = store.scope;
  const filtered = useMemo(() => snapshot ? visibleWorkspaces(snapshot, scope) : [], [snapshot, scope]);
  const active: Workspace | undefined = snapshot?.workspaces.find((item) => item.id === store.activeWorkspaceId && filtered.some((candidate) => candidate.id === item.id)) ?? filtered[0];
  const showingWorkspace = scope.type !== "all-projects" && scope.type !== "all-work-threads" && scope.type !== "all-devices";
  const showingTerminal = showingWorkspace && active?.status === "ready";

  useEffect(() => {
    if (store.scope.type === "all-projects" || store.scope.type === "all-work-threads" || store.scope.type === "all-devices") return;
    if (active && active.id !== store.activeWorkspaceId) store.setActiveWorkspace(active.id);
    if (!active && store.activeWorkspaceId) store.setActiveWorkspace(null);
  }, [active?.id, store.scope.type]);
  useEffect(() => window.desktop.onMenuAction((action) => {
    if (action === "new-work-thread") store.openDialog("workThread");
    if (action === "new-workspace") store.openDialog("workspace");
    if (action === "add-project") store.openDialog("project");
    if (action === "add-device") store.openDialog("device");
    if (action === "new-terminal" && active) void window.desktop.createSession({ workspaceId: active.id }).then((result) => {
      if (result.warning) toast.warning(result.warning);
    }).catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  }), [active?.id]);

  if (isLoading || !snapshot) return <div className="boot-screen drag"><div className="boot-logo"><Box size={22} /><span /></div></div>;
  if (error) throw error;
  const scopeTitle = scope.type === "project"
    ? snapshot.projects.find((item) => item.id === scope.id)?.name
    : scope.type === "work-thread"
      ? snapshot.workThreads.find((item) => item.id === scope.id)?.name
      : "All workspaces";
  const hasActiveThreads = snapshot.workThreads.some((thread) => thread.status === "active");
  return (
    <div className={`app-frame ${store.sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
      <Sidebar snapshot={snapshot} />
      <div className="workbench">
        {store.scope.type === "all-projects" ? <ProjectList snapshot={snapshot} /> : store.scope.type === "all-work-threads" ? <WorkThreadList snapshot={snapshot} /> : store.scope.type === "all-devices" ? <DeviceList snapshot={snapshot} /> : <>
          {active ? <><WorkspaceHeader snapshot={snapshot} workspace={active} />{active.status !== "ready" && <div className="workspace-error"><AlertTriangle size={28} /><h3>{active.status === "creating" ? "Creating workspace…" : "Workspace creation failed"}</h3><p className="selectable">{active.error}</p></div>}</> : <EmptyWorkspace title={scopeTitle || "Workspaces"} hasProjects={snapshot.projects.length > 0} hasWorkThreads={hasActiveThreads} />}
        </>}
        <div className={`workspace-terminal-stack ${showingTerminal ? "active" : ""}`}>
          {snapshot.workspaces.filter((workspace) => workspace.status === "ready").map((workspace) => {
            const visible = showingTerminal && active?.id === workspace.id;
            return <div key={workspace.id} className={`workspace-terminal-view ${visible ? "active" : ""}`} aria-hidden={!visible}><TerminalPane snapshot={snapshot} workspace={workspace} visible={visible} /></div>;
          })}
        </div>
      </div>
      <WorkspaceDialogs snapshot={snapshot} />
    </div>
  );
}

function EmptyWorkspace({ title, hasProjects, hasWorkThreads }: { title: string; hasProjects: boolean; hasWorkThreads: boolean }): React.ReactNode {
  const openDialog = useWorkbenchStore((state) => state.openDialog);
  const dialog = !hasProjects ? "project" : !hasWorkThreads ? "workThread" : "workspace";
  const action = !hasProjects ? "Add Project" : !hasWorkThreads ? "New Work Thread" : "New Workspace";
  return (
    <main className="empty-workspace">
      <div className="empty-titlebar drag"><span className="no-drag">{title}</span><button className="button primary no-drag" onClick={() => openDialog(dialog)}><Plus size={14} /> {action}</button></div>
      <section><div className="empty-art"><Server size={28} /><span /><FolderGit2 size={28} /></div><h1>{!hasProjects ? "Bring in a Git project" : !hasWorkThreads ? "Create your first work thread" : "Create your first workspace"}</h1><p>{!hasProjects ? "Import a local repository or clone one onto a connected device." : !hasWorkThreads ? "Use a work thread to group the workspaces that belong to the same effort." : "Choose a work thread, project, and device. SuperThread will create an isolated Git worktree and open a terminal there."}</p><button className="button primary large" onClick={() => openDialog(dialog)}><Plus size={15} /> {action}</button></section>
    </main>
  );
}
