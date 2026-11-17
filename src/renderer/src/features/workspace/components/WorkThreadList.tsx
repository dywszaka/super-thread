import { ArchiveRestore, FolderGit2, MessagesSquare, Plus, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, WorkThread, WorkThreadStatus } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { formatDocumentUpdate, workThreadDocumentUpdate } from "../selection";
import { WorkThreadSearch, type SearchSegment } from "../work-thread-search";
import { filterWorkThreads, workThreadTimeCutoff, type WorkThreadTimeUnit } from "../work-thread-filters";
import { threadDocumentAutosave } from "../document-autosave";
import { SidebarReopenButton } from "./Sidebar";
import { WorkThreadAge } from "./WorkThreadAge";
import { WorkThreadDocument } from "./WorkThreadDocument";
import { WorkThreadActions } from "./WorkThreadActions";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

function HighlightedText({ segments }: { segments: readonly SearchSegment[] }): React.ReactNode {
  return segments.map((segment, index) => segment.highlight ? <mark key={index}>{segment.text}</mark> : segment.text);
}

export function WorkThreadList({ snapshot }: { snapshot: AppSnapshot }): React.ReactNode {
  const [status, setStatus] = useState<WorkThreadStatus | "all">("active");
  const [projectId, setProjectId] = useState("");
  const [timeUnit, setTimeUnit] = useState<WorkThreadTimeUnit>("weeks");
  const [timeCount, setTimeCount] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [search] = useState(() => new WorkThreadSearch());
  const searchField = useRef<HTMLInputElement | null>(null);
  const selectedProject = snapshot.projects.find((project) => project.id === projectId);
  const selectedProjectId = selectedProject?.id ?? "";
  const projects = useMemo(() => [...snapshot.projects].sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code)), [snapshot.projects]);
  const results = useMemo(() => search.search(filterWorkThreads(snapshot.workThreads, snapshot.workspaces, selectedProjectId, workThreadTimeCutoff(timeUnit, timeCount, clock)), searchQuery), [search, snapshot.workThreads, snapshot.workspaces, selectedProjectId, timeUnit, timeCount, clock, searchQuery]);
  const threads = results[status];
  const hasFilters = Boolean(selectedProjectId) || timeCount > 0;
  const clearSearch = (): void => {
    setSearchInput("");
    setSearchQuery("");
    setIsComposing(false);
    searchField.current?.focus();
  };
  const clearFilters = (): void => {
    setProjectId("");
    setTimeUnit("weeks");
    setTimeCount(0);
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
  const documentSlot = useRef<HTMLDivElement>(null);
  const drawerAnimation = useRef<Animation | null>(null);
  const list = useRef<HTMLElement>(null);
  const listScroll = useRef(0);
  const documentTrigger = useRef<HTMLButtonElement | null>(null);
  const restoreListFocus = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const openDialog = useWorkbenchStore((state) => state.openDialog);
  const documentThread = snapshot.workThreads.find((thread) => thread.id === documentId);
  const drawerPresent = Boolean(documentThread);
  const drawerOpen = documentOpen && drawerPresent;
  const closeDocument = (): void => {
    if (documentThread) void threadDocumentAutosave(documentThread.id, documentThread.document ?? "").flush();
    restoreListFocus.current = true;
    setDocumentOpen(false);
  };

  useLayoutEffect(() => {
    const slot = documentSlot.current;
    if (!drawerPresent || !slot || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      drawerAnimation.current?.cancel();
      drawerAnimation.current = null;
      if (!documentOpen) setDocumentId(null);
      return;
    }
    // Reverse the same timeline when reopening mid-close, preserving its current position.
    let animation = drawerAnimation.current;
    if (!animation) {
      animation = slot.animate([{ transform: "translateX(100%)" }, { transform: "none" }], {
        duration: 220, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "both"
      });
      animation.currentTime = documentOpen ? 0 : 220;
      drawerAnimation.current = animation;
    }
    animation.playbackRate = documentOpen ? 1 : -1;
    animation.play();
    let cancelled = false;
    void animation.finished.then(() => {
      if (cancelled) return;
      if (!documentOpen) setDocumentId(null);
      else {
        // Release the filled transform once settled so editor text renders without a layer.
        animation.cancel();
        if (drawerAnimation.current === animation) drawerAnimation.current = null;
      }
    }).catch(() => { /* Unmounting or reduced motion can cancel the timeline. */ });
    return () => { cancelled = true; };
  }, [documentOpen, drawerPresent]);

  useLayoutEffect(() => () => drawerAnimation.current?.cancel(), []);

  useLayoutEffect(() => {
    if (drawerPresent) return;
    if (list.current) list.current.scrollTop = listScroll.current;
    if (!drawerPresent && restoreListFocus.current) {
      restoreListFocus.current = false;
      const trigger = documentTrigger.current;
      if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
      else searchField.current?.focus({ preventScroll: true });
    }
  }, [drawerPresent]);

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

  const openDocument = (trigger: HTMLButtonElement | null, thread: WorkThread): void => {
    restoreListFocus.current = false;
    listScroll.current = list.current?.scrollTop ?? 0;
    documentTrigger.current = trigger;
    setDocumentId(thread.id);
    setDocumentOpen(true);
  };

  return (
    <main className="work-thread-page">
      <header className="work-thread-page-header drag" inert={drawerPresent} aria-hidden={drawerPresent}>
        <SidebarReopenButton />
        <div><h1>Work Threads</h1><p>Organize related workspaces without changing their runtime state.</p></div>
        <button className="button primary no-drag" onClick={() => openDialog("workThread")}><Plus size={14} /> New Work Thread</button>
      </header>
      {drawerPresent && <button type="button" className="work-thread-document-backdrop no-drag" aria-label="Dismiss document drawer" tabIndex={-1} onClick={closeDocument} />}
      <div className="work-thread-content">
        <div className="work-thread-list-region" inert={drawerPresent} aria-hidden={drawerPresent}>
          <section ref={list} className="work-thread-page-body no-drag" onScroll={(event) => { listScroll.current = event.currentTarget.scrollTop; }}>
            <div className="work-thread-list-toolbar">
              <div className="work-thread-search" role="search" aria-label="Search work threads">
                <Search size={15} aria-hidden="true" />
                <input ref={searchField} type="search" aria-label="Search names and documents" placeholder="Search threads…" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onCompositionStart={() => setIsComposing(true)} onCompositionEnd={(event) => { setSearchInput(event.currentTarget.value); setIsComposing(false); }} />
                {searchInput && <button className="icon-button" type="button" aria-label="Clear search" onClick={clearSearch}><X size={14} /></button>}
              </div>
              <div className="segmented thread-status-filter" role="group" aria-label="Work thread status">
                <button aria-pressed={status === "all"} className={status === "all" ? "active" : ""} onClick={() => setStatus("all")}>All ({results.all.length})</button>
                <button aria-pressed={status === "active"} className={status === "active" ? "active" : ""} onClick={() => setStatus("active")}>Active ({results.active.length})</button>
                <button aria-pressed={status === "archived"} className={status === "archived" ? "active" : ""} onClick={() => setStatus("archived")}>Archived ({results.archived.length})</button>
              </div>
              <div className="work-thread-filters">
                <select className="work-thread-project-filter" aria-label="Filter by project" title={selectedProject ? `${selectedProject.name} · ${selectedProject.code}` : "All projects"} value={selectedProjectId} onChange={(event) => setProjectId(event.target.value)}>
                  <option value="">All projects</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.code}</option>)}
                </select>
                <div className={`work-thread-time-filter ${timeCount === 0 ? "is-inactive" : ""}`} role="group" aria-label="Filter by document update time" title={timeCount === 0 ? "No time filter (0)" : `Document updated in the last ${timeCount} ${timeUnit}`}>
                  <select className="work-thread-time-count" aria-label="Number of weeks or months" value={timeCount} onChange={(event) => { setTimeCount(Number(event.target.value)); setClock(Date.now()); }}>
                    {Array.from({ length: 13 }, (_, count) => <option key={count} value={count}>{count}</option>)}
                  </select>
                  <div className="segmented work-thread-time-units" role="group" aria-label="Time unit">
                    <button aria-label="Weeks" aria-pressed={timeUnit === "weeks"} className={timeUnit === "weeks" ? "active" : ""} onClick={() => { setTimeUnit("weeks"); setClock(Date.now()); }}>周</button>
                    <span aria-hidden="true">｜</span>
                    <button aria-label="Months" aria-pressed={timeUnit === "months"} className={timeUnit === "months" ? "active" : ""} onClick={() => { setTimeUnit("months"); setClock(Date.now()); }}>月</button>
                  </div>
                </div>
                {hasFilters && <button className="icon-button" aria-label="Clear filters" title="Clear filters" onClick={clearFilters}><X size={14} /></button>}
              </div>
            </div>
            <div className="work-thread-cards">
              {threads.length === 0 && (results.query || hasFilters
                ? <div className="work-thread-list-empty" role="status"><Search size={28} /><h2>No matching work threads</h2><p>No {status === "all" ? "" : `${status} `}work threads match your {hasFilters ? "filters" : "search"}.</p><button className="button" onClick={hasFilters ? clearFilters : clearSearch}>{hasFilters ? "Clear filters" : "Clear search"}</button></div>
                : <div className="work-thread-list-empty"><MessagesSquare size={28} /><h2>No {status === "all" ? "" : `${status} `}work threads</h2><p>{status === "archived" ? "Archived work threads will appear here." : "Create a work thread to group one or more workspaces."}</p></div>)}
              {threads.map(({ thread, name, excerpt }) => {
                const workspaces = snapshot.workspaces.filter((workspace) => workspace.workThreadId === thread.id);
                const busy = busyId === thread.id;
                return (
                  <article className={`work-thread-card ${drawerOpen && documentId === thread.id ? "document-is-open" : ""}`} key={thread.id} onClick={(event) => {
                    if (event.target instanceof Element && event.target.closest(".work-thread-card-main, .work-thread-card-actions")) return;
                    openDocument(event.currentTarget.querySelector<HTMLButtonElement>(".work-thread-card-main"), thread);
                  }}>
                    <button type="button" className="work-thread-card-main" aria-label={`Open document for ${thread.name}`} aria-expanded={drawerOpen && documentId === thread.id} aria-controls="work-thread-document-drawer" title="Open document" onClick={(event) => openDocument(event.currentTarget, thread)}>
                      <span className="work-thread-card-icon"><MessagesSquare size={17} /></span>
                      <span><strong title={thread.name}><HighlightedText segments={name} /></strong><small className="work-thread-card-meta">{status === "all" && <span className="work-thread-status-badge">{thread.status === "active" ? "Active" : "Archived"}</span>}<span><FolderGit2 size={12} /> {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}</span><WorkThreadAge thread={thread} /><span className="thread-last-update">Last update <time dateTime={workThreadDocumentUpdate(thread)} title={new Date(workThreadDocumentUpdate(thread)).toLocaleString()}>{formatDocumentUpdate(workThreadDocumentUpdate(thread))}</time></span></small>{excerpt && <span className="work-thread-search-excerpt"><HighlightedText segments={excerpt} /></span>}</span>
                    </button>
                    <div className="work-thread-card-actions">
                      {thread.status === "archived" && <button className="button" disabled={busy} onClick={() => void restore(thread.id, thread.name)}><ArchiveRestore size={14} /> Restore</button>}
                      <WorkThreadActions name={thread.name} archived={thread.status === "archived"} busy={busy} hasWorkspaces={workspaces.length > 0} onFinish={() => useWorkbenchStore.getState().openFinishWorkThread(thread.id)} onArchive={() => void archive(thread.id, thread.name)} onDelete={() => void remove(thread.id, thread.name)} />
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
        <div ref={documentSlot} className={`work-thread-document-slot ${drawerPresent ? "is-open" : ""}`} inert={!drawerOpen} aria-hidden={!drawerOpen}>
          {documentThread && <aside id="work-thread-document-drawer" className="work-thread-document-drawer no-drag" role="dialog" aria-modal="false" aria-label={`Document for ${documentThread.name}`} onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); closeDocument(); }
          }}>
            <WorkThreadDocument key={documentThread.id} thread={documentThread} snapshot={snapshot} onClose={closeDocument} />
          </aside>}
        </div>
      </div>
    </main>
  );
}
