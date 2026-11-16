import { ArchiveRestore, FileText, FolderGit2, MessagesSquare, Plus, Search, TerminalSquare, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, WorkThread, WorkThreadStatus } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { formatDocumentUpdate, workThreadDocumentUpdate } from "../selection";
import { WorkThreadSearch, type SearchSegment } from "../work-thread-search";
import { filterWorkThreads, workThreadTimeCutoff, type WorkThreadTimeUnit } from "../work-thread-filters";
import { SidebarReopenButton } from "./Sidebar";
import { WorkThreadAge } from "./WorkThreadAge";
import { WorkThreadDocument } from "./WorkThreadDocument";
import { WorkThreadActions } from "./WorkThreadActions";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

function HighlightedText({ segments }: { segments: readonly SearchSegment[] }): React.ReactNode {
  return segments.map((segment, index) => segment.highlight ? <mark key={index}>{segment.text}</mark> : segment.text);
}

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
  const [status, setStatus] = useState<WorkThreadStatus | "all">("active");
  const [projectId, setProjectId] = useState("");
  const [timeUnit, setTimeUnit] = useState<WorkThreadTimeUnit>("all");
  const [timeCount, setTimeCount] = useState(1);
  const [clock, setClock] = useState(Date.now());
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [search] = useState(() => new WorkThreadSearch());
  const searchField = useRef<HTMLInputElement | null>(null);
  const selectedProjectId = snapshot.projects.some((project) => project.id === projectId) ? projectId : "";
  const projects = useMemo(() => [...snapshot.projects].sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code)), [snapshot.projects]);
  const results = useMemo(() => search.search(filterWorkThreads(snapshot.workThreads, snapshot.workspaces, selectedProjectId, workThreadTimeCutoff(timeUnit, timeCount, clock)), searchQuery), [search, snapshot.workThreads, snapshot.workspaces, selectedProjectId, timeUnit, timeCount, clock, searchQuery]);
  const threads = results[status];
  const hasFilters = Boolean(selectedProjectId) || timeUnit !== "all";
  const clearSearch = (): void => {
    setSearchInput("");
    setSearchQuery("");
    setIsComposing(false);
    searchField.current?.focus();
  };
  const clearFilters = (): void => {
    setProjectId("");
    setTimeUnit("all");
    setTimeCount(1);
    clearSearch();
  };
  useEffect(() => {
    const refresh = (): void => setClock(Date.now());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  useEffect(() => {
    if (isComposing) return;
    const timer = window.setTimeout(() => setSearchQuery(searchInput), 150);
    return () => window.clearTimeout(timer);
  }, [searchInput, isComposing]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [documentOpen, setDocumentOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const listScroll = useRef(0);
  const [compact, setCompact] = useState(false);
  const documentTrigger = useRef<HTMLButtonElement | null>(null);
  const restoreListFocus = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const openDialog = useWorkbenchStore((state) => state.openDialog);
  const setWorkThreadFilter = useWorkbenchStore((state) => state.setWorkThreadFilter);
  const setActiveWorkspace = useWorkbenchStore((state) => state.setActiveWorkspace);
  const setActiveSession = useWorkbenchStore((state) => state.setActiveSession);
  const documentThread = snapshot.workThreads.find((thread) => thread.id === documentId);
  const drawerOpen = documentOpen && Boolean(documentThread);
  const closeDocument = (): void => {
    restoreListFocus.current = true;
    setDocumentOpen(false);
    setDocumentId(null);
  };

  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = (): void => setCompact(element.clientWidth < 960);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (drawerOpen && compact) return;
    if (list.current) list.current.scrollTop = listScroll.current;
    if (!drawerOpen && restoreListFocus.current) {
      restoreListFocus.current = false;
      const trigger = documentTrigger.current;
      if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
      else searchField.current?.focus({ preventScroll: true });
    }
  }, [drawerOpen, compact]);

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
    listScroll.current = list.current?.scrollTop ?? 0;
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
      <div ref={content} className={`work-thread-content ${drawerOpen ? "has-document" : ""} ${compact ? "is-compact" : ""}`}>
        <div className="work-thread-list-region" inert={drawerOpen && compact} aria-hidden={drawerOpen && compact}>
          <section ref={list} className="work-thread-page-body no-drag" onScroll={(event) => { if (!compact || !drawerOpen) listScroll.current = event.currentTarget.scrollTop; }}>
            <div className="work-thread-list-toolbar">
              <div className="work-thread-search" role="search" aria-label="Search work threads">
                <Search size={15} aria-hidden="true" />
                <input ref={searchField} type="search" aria-label="Search names and documents" placeholder="Search names and documents…" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onCompositionStart={() => setIsComposing(true)} onCompositionEnd={(event) => { setSearchInput(event.currentTarget.value); setIsComposing(false); }} />
                {searchInput && <button className="icon-button" type="button" aria-label="Clear search" onClick={clearSearch}><X size={14} /></button>}
              </div>
              <div className="segmented thread-status-filter" role="group" aria-label="Work thread status">
                <button aria-pressed={status === "all"} className={status === "all" ? "active" : ""} onClick={() => setStatus("all")}>All ({results.all.length})</button>
                <button aria-pressed={status === "active"} className={status === "active" ? "active" : ""} onClick={() => setStatus("active")}>Active ({results.active.length})</button>
                <button aria-pressed={status === "archived"} className={status === "archived" ? "active" : ""} onClick={() => setStatus("archived")}>Archived ({results.archived.length})</button>
              </div>
              <div className="work-thread-filters">
                <label className="work-thread-project-filter">Project
                  <select aria-label="Filter by project" value={selectedProjectId} onChange={(event) => setProjectId(event.target.value)}>
                    <option value="">All projects</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.code}</option>)}
                  </select>
                </label>
                <div className="work-thread-time-filter" role="group" aria-label="Filter by document update time">
                  <span>Last update</span>
                  {timeUnit !== "all" && <label className="work-thread-time-count">Last <input type="number" aria-label="Number of weeks or months" min={1} max={1200} step={1} value={timeCount} onChange={(event) => setTimeCount(Math.max(1, Math.min(1200, Math.trunc(Number(event.target.value) || 1))))} /></label>}
                  <select aria-label="Time range" value={timeUnit} onChange={(event) => { setTimeUnit(event.target.value as WorkThreadTimeUnit); setClock(Date.now()); }}>
                    <option value="all">All time</option><option value="weeks">Weeks</option><option value="months">Months</option>
                  </select>
                </div>
                {hasFilters && <button className="button" onClick={clearFilters}>Clear filters</button>}
              </div>
            </div>
            <div className="work-thread-cards">
              {threads.length === 0 && (results.query || hasFilters
                ? <div className="work-thread-list-empty" role="status"><Search size={28} /><h2>No matching work threads</h2><p>No {status === "all" ? "" : `${status} `}work threads match your {hasFilters ? "filters" : "search"}.</p><button className="button" onClick={hasFilters ? clearFilters : clearSearch}>{hasFilters ? "Clear filters" : "Clear search"}</button></div>
                : <div className="work-thread-list-empty"><MessagesSquare size={28} /><h2>No {status === "all" ? "" : `${status} `}work threads</h2><p>{status === "archived" ? "Archived work threads will appear here." : "Create a work thread to group one or more workspaces."}</p></div>)}
              {threads.map(({ thread, name, excerpt }) => {
                const workspaces = snapshot.workspaces.filter((workspace) => workspace.workThreadId === thread.id);
                const busy = busyId === thread.id;
                const terminalTarget = firstTerminalTarget(snapshot, thread.id);
                return (
                  <article className={`work-thread-card ${drawerOpen && documentId === thread.id ? "document-is-open" : ""}`} key={thread.id}>
                    <button type="button" className="work-thread-card-main" aria-label={`Open document for ${thread.name}`} aria-expanded={drawerOpen && documentId === thread.id} aria-controls="work-thread-document-drawer" title="Open document" onClick={(event) => openDocument(event.currentTarget, thread)}>
                      <span className="work-thread-card-icon"><MessagesSquare size={17} /></span>
                      <span><strong title={thread.name}><HighlightedText segments={name} /></strong><small className="work-thread-card-meta">{status === "all" && <span className="work-thread-status-badge">{thread.status === "active" ? "Active" : "Archived"}</span>}<span><FolderGit2 size={12} /> {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}</span><WorkThreadAge thread={thread} /><span className="thread-last-update">Last update <time dateTime={workThreadDocumentUpdate(thread)} title={new Date(workThreadDocumentUpdate(thread)).toLocaleString()}>{formatDocumentUpdate(workThreadDocumentUpdate(thread))}</time></span></small>{excerpt && <span className="work-thread-search-excerpt"><HighlightedText segments={excerpt} /></span>}</span>
                    </button>
                    <div className="work-thread-card-actions">
                      {terminalTarget && thread.status === "active" && <button className="button thread-terminal-action" disabled={busy} title="Open first terminal" aria-label={`Open first terminal for ${thread.name}`} onClick={() => openWorkThread(thread)}><TerminalSquare size={14} /> Terminal</button>}
                      {thread.status === "archived" && <button className="button" disabled={busy} onClick={() => void restore(thread.id, thread.name)}><ArchiveRestore size={14} /> Restore</button>}
                      <button className="button" disabled={busy} aria-label={`Edit document for ${thread.name}`} aria-expanded={drawerOpen && documentId === thread.id} aria-controls="work-thread-document-drawer" onClick={(event) => openDocument(event.currentTarget, thread)}><FileText size={14} /> Doc</button>
                      <WorkThreadActions name={thread.name} archived={thread.status === "archived"} busy={busy} hasWorkspaces={workspaces.length > 0} onFinish={() => useWorkbenchStore.getState().openFinishWorkThread(thread.id)} onArchive={() => void archive(thread.id, thread.name)} onDelete={() => void remove(thread.id, thread.name)} />
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
        <div className={`work-thread-document-slot ${drawerOpen ? "is-open" : ""}`} inert={!drawerOpen} aria-hidden={!drawerOpen}>
          {documentThread && <aside id="work-thread-document-drawer" className="work-thread-document-drawer no-drag" role="dialog" aria-modal="false" aria-label={`Document for ${documentThread.name}`} onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); closeDocument(); }
          }}>
            <WorkThreadDocument key={documentThread.id} thread={documentThread} onClose={closeDocument} backToList={compact} />
          </aside>}
        </div>
      </div>
    </main>
  );
}
