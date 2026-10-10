import { AppWindowMac, Archive, ArchiveRestore, FileText, FolderGit2, MessagesSquare, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, WorkThread, WorkThreadStatus } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { formatDocumentUpdate, workThreadDocumentUpdate, workThreadsByDocumentUpdate } from "../selection";
import { SidebarReopenButton } from "./Sidebar";
import { WorkThreadDocument } from "./WorkThreadDocument";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

/** First terminal (running preferred) of a work thread, or null when it has none. */
const firstTerminalTarget = (snapshot: AppSnapshot, threadId: string): { workspaceId: string; sessionId: string } | null => {
  for (const workspace of snapshot.workspaces) {
    if (workspace.workThreadId !== threadId || workspace.status !== "ready") continue;
    const sessions = snapshot.sessions
      .filter((session) => session.workspaceId === workspace.id)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    const session = sessions.find((item) => item.status === "running") ?? sessions[0];
    if (session) return { workspaceId: workspace.id, sessionId: session.id };
  }
  return null;
};

export function WorkThreadList({ snapshot }: { snapshot: AppSnapshot }): React.ReactNode {
  const [status, setStatus] = useState<WorkThreadStatus>("active");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [documentOpen, setDocumentOpen] = useState(false);
  const documentTrigger = useRef<HTMLButtonElement | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const openDialog = useWorkbenchStore((state) => state.openDialog);
  const setWorkThreadFilter = useWorkbenchStore((state) => state.setWorkThreadFilter);
  const setActiveWorkspace = useWorkbenchStore((state) => state.setActiveWorkspace);
  const setActiveSession = useWorkbenchStore((state) => state.setActiveSession);
  const documentThread = snapshot.workThreads.find((thread) => thread.id === documentId);
  const drawerOpen = documentOpen && Boolean(documentThread);
  const closeDocument = (): void => { setDocumentOpen(false); documentTrigger.current?.focus(); };

  useEffect(() => {
    if (drawerOpen || !documentId) return;
    // Keep the editor mounted through the closing transition; reopening cancels cleanup.
    const timer = window.setTimeout(() => setDocumentId(null), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 320);
    return () => window.clearTimeout(timer);
  }, [drawerOpen, documentId]);
  const threads = workThreadsByDocumentUpdate(snapshot.workThreads.filter((thread) => thread.status === status));

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
    if (!confirm(`Permanently delete work thread “${name}”?\n\nIts document and all TODOs will also be deleted. This cannot be undone.`)) return;
    setBusyId(id);
    try {
      await window.desktop.deleteWorkThread(id);
      toast.success(`${name} deleted`);
    } catch (error) { toast.error(cleanError(error)); }
    finally { setBusyId(null); }
  };

  const openWorkThread = (thread: WorkThread): void => {
    const target = firstTerminalTarget(snapshot, thread.id);
    setWorkThreadFilter(thread.id);
    if (target) {
      setActiveWorkspace(target.workspaceId);
      setActiveSession(target.workspaceId, target.sessionId);
    }
  };

  // Clicking anywhere on the card body behaves like the Doc action: open the document drawer and
  // restore focus to the element that opened it on close.
  const openDocument = (trigger: HTMLButtonElement | null, thread: WorkThread): void => {
    documentTrigger.current = trigger;
    setDocumentId(thread.id);
    setDocumentOpen(true);
  };

  return (
    <main className="work-thread-page">
      <header className="work-thread-page-header drag">
        <SidebarReopenButton />
        <div><h1>Work Threads</h1><p>Organize related workspaces without changing their runtime state.</p></div>
        <button className="button primary no-drag" onClick={() => openDialog("workThread")}><Plus size={14} /> New Work Thread</button>
      </header>
      <div className="work-thread-content">
        <div className="work-thread-list-region">
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
                const terminalTarget = firstTerminalTarget(snapshot, thread.id);
                return (
                  <article className={`work-thread-card ${drawerOpen && documentId === thread.id ? "document-is-open" : ""}`} key={thread.id}>
                    <button type="button" className="work-thread-card-main" aria-label={`Open document for ${thread.name}`} aria-expanded={drawerOpen && documentId === thread.id} aria-controls="work-thread-document-drawer" title="Open document" onClick={(event) => openDocument(event.currentTarget, thread)}>
                      <span className="work-thread-card-icon"><MessagesSquare size={17} /></span>
                      <span><strong>{thread.name}</strong><small className="work-thread-card-meta"><span><FolderGit2 size={12} /> {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}</span><span>Last update <time dateTime={workThreadDocumentUpdate(thread)} title={new Date(workThreadDocumentUpdate(thread)).toLocaleString()}>{formatDocumentUpdate(workThreadDocumentUpdate(thread))}</time></span></small></span>
                    </button>
                    <div className="work-thread-card-actions">
                      <button className="icon-button" disabled={status === "archived"} title={terminalTarget ? "Open first terminal" : "Open document"} aria-label={`Open ${terminalTarget ? "first terminal" : "document"} for ${thread.name}`} onClick={() => openWorkThread(thread)}><AppWindowMac size={14} /></button>
                      {status === "active"
                        ? <button className="button" disabled={busy} onClick={() => void archive(thread.id, thread.name)}><Archive size={14} /> Archive</button>
                        : <button className="button" disabled={busy} onClick={() => void restore(thread.id, thread.name)}><ArchiveRestore size={14} /> Restore</button>}
                      <button className="button" disabled={busy} aria-label={`Edit document for ${thread.name}`} aria-expanded={drawerOpen && documentId === thread.id} aria-controls="work-thread-document-drawer" onClick={(event) => openDocument(event.currentTarget, thread)}><FileText size={14} /> Doc</button>
                      <button className="icon-button danger-button" disabled={busy || workspaces.length > 0} title={workspaces.length > 0 ? "Remove every workspace before deleting this work thread" : "Delete work thread"} onClick={() => void remove(thread.id, thread.name)}><Trash2 size={14} /></button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
        <div className={`work-thread-document-slot ${drawerOpen ? "is-open" : ""}`} inert={!drawerOpen} aria-hidden={!drawerOpen} onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "width" && !drawerOpen) setDocumentId(null);
        }}>
          {documentThread && <aside id="work-thread-document-drawer" className="work-thread-document-drawer no-drag" role="dialog" aria-modal="false" aria-label={`Document for ${documentThread.name}`} onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); closeDocument(); }
          }}>
            <WorkThreadDocument key={documentThread.id} thread={documentThread} onClose={closeDocument} />
          </aside>}
        </div>
      </div>
    </main>
  );
}
