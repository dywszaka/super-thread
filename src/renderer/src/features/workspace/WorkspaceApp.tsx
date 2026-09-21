import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Box, FolderGit2, Plus, Server } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../state/workbench-store";
import { Sidebar } from "./components/Sidebar";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceDialogs } from "./components/Dialogs";
import { WorkspaceHeader } from "./components/WorkspaceHeader";

export function WorkspaceApp(): React.ReactNode {
  const { data: snapshot, error, isLoading } = useQuery({ queryKey: ["snapshot"], queryFn: () => window.desktop.snapshot() });
  const store = useWorkbenchStore();
  const filtered = useMemo(() => snapshot?.workspaces.filter((workspace) =>
    (!store.projectFilter || workspace.projectId === store.projectFilter) &&
    (!store.deviceFilter || workspace.deviceId === store.deviceFilter)
  ) ?? [], [snapshot?.workspaces, store.projectFilter, store.deviceFilter]);
  const active: Workspace | undefined = snapshot?.workspaces.find((item) => item.id === store.activeWorkspaceId && filtered.some((candidate) => candidate.id === item.id)) ?? filtered[0];

  useEffect(() => { if (active && active.id !== store.activeWorkspaceId) store.setActiveWorkspace(active.id); }, [active?.id]);
  useEffect(() => window.desktop.onMenuAction((action) => {
    if (action === "new-workspace") store.openDialog("workspace");
    if (action === "add-project") store.openDialog("project");
    if (action === "add-device") store.openDialog("device");
    if (action === "new-terminal" && active) void window.desktop.createSession({ workspaceId: active.id });
  }), [active?.id]);

  if (isLoading || !snapshot) return <div className="boot-screen drag"><div className="boot-logo"><Box size={22} /><span /></div></div>;
  if (error) throw error;
  const scopeTitle = store.projectFilter ? snapshot.projects.find((item) => item.id === store.projectFilter)?.name : store.deviceFilter ? snapshot.devices.find((item) => item.id === store.deviceFilter)?.name : "All workspaces";
  return (
    <div className="app-frame">
      <Sidebar snapshot={snapshot} />
      <div className="workbench">
        {active ? <><WorkspaceHeader snapshot={snapshot} workspace={active} />{active.status === "ready" ? <TerminalPane snapshot={snapshot} workspace={active} /> : <div className="workspace-error"><AlertTriangle size={28} /><h3>{active.status === "creating" ? "Creating workspace…" : "Workspace creation failed"}</h3><p className="selectable">{active.error}</p></div>}</> : <EmptyWorkspace title={scopeTitle || "Workspaces"} hasProjects={snapshot.projects.length > 0} />}
        <div className="workspace-switcher no-drag">
          <div className="switcher-scroll">{filtered.map((workspace) => {
            const project = snapshot.projects.find((item) => item.id === workspace.projectId);
            const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
            return <button key={workspace.id} className={`workspace-tab ${active?.id === workspace.id ? "active" : ""}`} onClick={() => store.setActiveWorkspace(workspace.id)}><span className={`workspace-icon ${workspace.status}`}><FolderGit2 size={14} /></span><span><strong>{workspace.name}</strong><small>{project?.name} · {device?.name}</small></span></button>;
          })}</div>
          <button className="switcher-add" onClick={() => store.openDialog("workspace")}><Plus size={15} /><span>New workspace</span></button>
        </div>
      </div>
      <WorkspaceDialogs snapshot={snapshot} />
    </div>
  );
}

function EmptyWorkspace({ title, hasProjects }: { title: string; hasProjects: boolean }): React.ReactNode {
  const openDialog = useWorkbenchStore((state) => state.openDialog);
  return (
    <main className="empty-workspace">
      <div className="empty-titlebar drag"><span className="no-drag">{title}</span><button className="button primary no-drag" onClick={() => openDialog(hasProjects ? "workspace" : "project")}><Plus size={14} /> {hasProjects ? "New Workspace" : "Add Project"}</button></div>
      <section><div className="empty-art"><Server size={28} /><span /><FolderGit2 size={28} /></div><h1>{hasProjects ? "Create your first workspace" : "Bring in a Git project"}</h1><p>{hasProjects ? "Choose a project and device. SuperThread will create an isolated Git worktree and open a terminal there." : "Import a local repository or clone one onto a connected device."}</p><button className="button primary large" onClick={() => openDialog(hasProjects ? "workspace" : "project")}><Plus size={15} /> {hasProjects ? "New Workspace" : "Add Project"}</button></section>
    </main>
  );
}
