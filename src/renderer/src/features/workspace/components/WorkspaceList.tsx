import { Bot, ChevronRight, Layers3, Laptop, Plus, Server, TerminalSquare } from "lucide-react";
import type { AppSnapshot } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { workspaceOverview, workspaceProjectName } from "../selection";
import { SidebarReopenButton } from "./Sidebar";

export function WorkspaceList({ snapshot }: { snapshot: AppSnapshot }): React.ReactNode {
  const { openDialog, setWorkThreadFilter, setActiveWorkspace } = useWorkbenchStore();
  const rows = workspaceOverview(snapshot);
  const terminals = rows.reduce((sum, row) => sum + row.terminals, 0);
  const codex = rows.reduce((sum, row) => sum + row.codex, 0);
  const dialog = snapshot.projects.length === 0 ? "project" : !snapshot.workThreads.some((thread) => thread.status === "active") ? "workThread" : "workspace";
  const action = dialog === "project" ? "Add Project" : dialog === "workThread" ? "New Work Thread" : "New Workspace";

  return (
    <main className="project-page workspace-overview">
      <header className="project-page-header drag">
        <SidebarReopenButton />
        <div><h1>All workspaces</h1><p>Running counts sessions actively executing commands or working.</p></div>
        <button className="button primary no-drag" onClick={() => openDialog(dialog)}><Plus size={14} /> {action}</button>
      </header>
      <section className="project-page-body no-drag">
        <div className="project-summary workspace-running-summary" aria-live="polite">
          <span><strong>{rows.length}</strong> workspaces</span>
          <span><TerminalSquare size={13} /><strong>{terminals}</strong> running terminals</span>
          <span><Bot size={13} /><strong>{codex}</strong> running Codex</span>
        </div>
        <div className="project-cards">
          {rows.length === 0 && <div className="project-list-empty"><Layers3 size={28} /><h2>No workspaces yet</h2><p>Create a workspace to start a Terminal or Codex session.</p><button className="button primary" onClick={() => openDialog(dialog)}><Plus size={14} /> {action}</button></div>}
          {rows.map(({ workspace, terminals, codex }) => {
            const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
            const thread = snapshot.workThreads.find((item) => item.id === workspace.workThreadId);
            const Icon = device?.type === "remote" ? Server : Laptop;
            const running = terminals + codex;
            return (
              <button key={workspace.id} className="project-card workspace-overview-row" onClick={() => { setWorkThreadFilter(workspace.workThreadId); setActiveWorkspace(workspace.id); }}>
                <span className="project-card-icon"><Icon size={19} /></span>
                <span className="project-card-content">
                  <span className="project-card-title"><strong>{workspace.name}</strong>{workspace.status !== "ready" && <span>{workspace.status}</span>}</span>
                  <span className="workspace-overview-meta">{workspaceProjectName(snapshot, workspace)} · {device?.name ?? "Unknown device"} · {thread?.name ?? "Unknown work thread"}</span>
                  <span className="workspace-overview-meta">{workspace.branch}</span>
                </span>
                <span className={`workspace-running-count ${running ? "has-running" : ""}`} title={`${terminals} running terminals · ${codex} running Codex`}><strong>{running}</strong> running</span>
                <ChevronRight size={15} />
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
