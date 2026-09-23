import { Archive, ArchiveRestore, FolderGit2, MessagesSquare, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, WorkThreadStatus } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { SidebarReopenButton } from "./Sidebar";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function WorkThreadList({ snapshot }: { snapshot: AppSnapshot }): React.ReactNode {
  const [status, setStatus] = useState<WorkThreadStatus>("active");
  const [busyId, setBusyId] = useState<string | null>(null);
  const openDialog = useWorkbenchStore((state) => state.openDialog);
  const setWorkThreadFilter = useWorkbenchStore((state) => state.setWorkThreadFilter);
  const threads = snapshot.workThreads.filter((thread) => thread.status === status);

  const archive = async (id: string, name: string): Promise<void> => {
    if (!confirm(`Archive “${name}”?\n\nIts workspaces will be hidden from active views. Running terminal sessions will continue.`)) return;
    setBusyId(id);
    try {
      await window.desktop.archiveWorkThread(id);
      toast.success(`${name} archived`);
    } catch (error) { toast.error(cleanError(error)); }
    finally { setBusyId(null); }
  };

  const restore = async (id: string, name: string): Promise<void> => {
    setBusyId(id);
    try {
      await window.desktop.restoreWorkThread(id);
      toast.success(`${name} restored`);
    } catch (error) { toast.error(cleanError(error)); }
    finally { setBusyId(null); }
  };

  const remove = async (id: string, name: string): Promise<void> => {
    if (!confirm(`Permanently delete the empty work thread “${name}”?`)) return;
    setBusyId(id);
    try {
      await window.desktop.deleteWorkThread(id);
      toast.success(`${name} deleted`);
    } catch (error) { toast.error(cleanError(error)); }
    finally { setBusyId(null); }
  };

  return (
    <main className="work-thread-page">
      <header className="work-thread-page-header drag">
        <SidebarReopenButton />
        <div><h1>Work Threads</h1><p>Organize related workspaces without changing their runtime state.</p></div>
        <button className="button primary no-drag" onClick={() => openDialog("workThread")}><Plus size={14} /> New Work Thread</button>
      </header>
      <section className="work-thread-page-body no-drag">
        <div className="segmented thread-status-filter">
          <button className={status === "active" ? "active" : ""} onClick={() => setStatus("active")}>Active ({snapshot.workThreads.filter((thread) => thread.status === "active").length})</button>
          <button className={status === "archived" ? "active" : ""} onClick={() => setStatus("archived")}>Archived ({snapshot.workThreads.filter((thread) => thread.status === "archived").length})</button>
        </div>
        <div className="work-thread-cards">
          {threads.length === 0 && <div className="work-thread-list-empty"><MessagesSquare size={28} /><h2>No {status} work threads</h2><p>{status === "active" ? "Create a work thread to group one or more workspaces." : "Archived work threads will appear here."}</p></div>}
          {threads.map((thread) => {
            const workspaces = snapshot.workspaces.filter((workspace) => workspace.workThreadId === thread.id);
            const busy = busyId === thread.id;
            return (
              <article className="work-thread-card" key={thread.id}>
                <button className="work-thread-card-main" disabled={status === "archived"} onClick={() => setWorkThreadFilter(thread.id)}>
                  <span className="work-thread-card-icon"><MessagesSquare size={17} /></span>
                  <span><strong>{thread.name}</strong><small><FolderGit2 size={12} /> {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}</small></span>
                </button>
                <div className="work-thread-card-actions">
                  {status === "active"
                    ? <button className="button" disabled={busy} onClick={() => void archive(thread.id, thread.name)}><Archive size={14} /> Archive</button>
                    : <button className="button" disabled={busy} onClick={() => void restore(thread.id, thread.name)}><ArchiveRestore size={14} /> Restore</button>}
                  <button className="icon-button danger-button" disabled={busy || workspaces.length > 0} title={workspaces.length > 0 ? "Remove every workspace before deleting this work thread" : "Delete work thread"} onClick={() => void remove(thread.id, thread.name)}><Trash2 size={14} /></button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
