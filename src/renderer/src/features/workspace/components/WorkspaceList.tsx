import { ChevronRight, FolderGit2, GitBranch, Layers3, Laptop, MessagesSquare, Plus, Server, TerminalSquare } from "lucide-react";
import type { AppSnapshot } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { workspaceOverview, workspaceProjectName } from "../selection";
import { SidebarReopenButton } from "./Sidebar";

export function WorkspaceList({ snapshot }: { snapshot: AppSnapshot }): React.ReactNode {
  const { openWorkspaceDialog, openWorkspace } = useWorkbenchStore();
  const rows = workspaceOverview(snapshot);
  const terminals = rows.reduce((sum, row) => sum + row.terminals, 0);
  const connected = rows.reduce((sum, row) => sum + row.connected, 0);

  return (
    <main className="project-page workspace-overview">
      <header className="project-page-header drag">
        <SidebarReopenButton />
        <div><h1>All workspaces</h1><p>Local activity is monitored. Remote terminals show connection counts only.</p></div>
        <button className="button primary no-drag" onClick={() => openWorkspaceDialog()}><Plus size={14} /> New Workspace</button>
      </header>
      <section className="project-page-body no-drag">
        <div className="project-summary workspace-running-summary" aria-live="polite">
          <span><strong>{rows.length}</strong> workspaces</span>
          <span><TerminalSquare size={13} /><strong>{terminals}</strong> local active terminals</span>
          <span><Server size={13} /><strong>{connected}</strong> remote terminals connected</span>
        </div>
        <div className="project-cards">
          {rows.length === 0 && <div className="project-list-empty"><Layers3 size={28} /><h2>No workspaces yet</h2><p>Create a workspace to start a terminal session.</p><button className="button primary" onClick={() => openWorkspaceDialog()}><Plus size={14} /> New Workspace</button></div>}
          {rows.map(({ workspace, terminals, connected }) => {
            const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
            const thread = snapshot.workThreads.find((item) => item.id === workspace.workThreadId);
            const Icon = device?.type === "remote" ? Server : Laptop;
            const running = terminals + connected;
            return (
              <button key={workspace.id} className="project-card workspace-overview-row" onClick={() => openWorkspace(workspace)}>
                <span className="project-card-icon"><Icon size={19} /></span>
                <span className="project-card-content">
                  <span className="project-card-title"><strong title={workspace.name}>{workspace.name}</strong>{workspace.status !== "ready" && <span title={workspace.error}>{workspace.status}</span>}</span>
                  <span className="workspace-overview-context">
                    <span title={`Project: ${workspaceProjectName(snapshot, workspace)}`}><FolderGit2 size={12} /><span>{workspaceProjectName(snapshot, workspace)}</span></span>
                    <span title={`Device: ${device?.name ?? "Unknown device"}`}><Icon size={12} /><span>{device?.name ?? "Unknown device"}</span></span>
                  </span>
                  <span className="workspace-overview-context workspace-overview-meta">
                    <span title={`Work thread: ${thread?.name ?? "Standalone"}`}><MessagesSquare size={12} /><span>{thread?.name ?? "Standalone"}</span></span>
                    {workspace.branch && <span title={`Branch: ${workspace.branch}`}><GitBranch size={12} /><span>{workspace.branch}</span></span>}
                  </span>
                </span>
                <span className={`workspace-running-count ${running ? "has-running" : ""}`}>
                  {running ? <>{terminals > 0 && <span><TerminalSquare size={12} /><strong>{terminals}</strong> local active</span>}{connected > 0 && <span><Server size={12} /><strong>{connected}</strong> remote connected</span>}</> : "No terminal activity"}
                </span>
                <ChevronRight size={15} />
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
