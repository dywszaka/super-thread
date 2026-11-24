import { WorkThreadAge } from "./WorkThreadAge";
import { TodoList } from "./TodoList";
import { MarkdownEditor } from "./MarkdownEditor";
import { ArrowLeft, Check, CircleCheck, FileText, Loader2, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AppSnapshot, WorkThread } from "@/shared/domain";
import { normalizeBrowserUrl } from "@/shared/browser-url";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { threadDocumentAutosave } from "../document-autosave";
import { documentBrowserWorkspaces } from "../document-browser";
import { SidebarReopenButton } from "./Sidebar";
import { Field, Modal } from "./Modal";
import { WorkspaceChangeDetails } from "./WorkspaceChangeDetails";
import { workspaceChangesMarkdown, type WorkspaceChangeRecord } from "@/shared/workspace-changes";
import { MAX_WORK_THREAD_DOCUMENT_LENGTH } from "@/shared/contract";
import { CodexSessionList } from "./CodexSessionList";

export function WorkThreadDocument({ thread, snapshot, onClose, backToList = false, autoFocus = Boolean(onClose) }: { thread: WorkThread; snapshot: AppSnapshot; onClose?: () => void; backToList?: boolean; autoFocus?: boolean }): React.ReactNode {
  const [tab, setTab] = useState<"document" | "todos" | "changes" | "codex">("document");
  const [documentRevision, setDocumentRevision] = useState(0);
  const [linkRequest, setLinkRequest] = useState<{ url: string; workspaceId: string } | null>(null);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [linkError, setLinkError] = useState("");
  const opening = useRef(false);
  const client = useQueryClient();
  const browserWorkspaces = documentBrowserWorkspaces(snapshot, thread.id);
  const openWorkspaceDialog = useWorkbenchStore((state) => state.openWorkspaceDialog);
  const document = useMemo(() => threadDocumentAutosave(thread.id, thread.document ?? ""), [thread.id]);
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  const appendSummary = (record: WorkspaceChangeRecord): void => {
    const content = `${document.getSnapshot().content.trimEnd()}\n\n${workspaceChangesMarkdown(record)}`;
    if (content.length > MAX_WORK_THREAD_DOCUMENT_LENGTH) { toast.error("Document is too large to add this summary. Copy or export it instead."); return; }
    document.edit(content);
    setDocumentRevision((revision) => revision + 1);
    setTab("document");
    void document.flush();
  };
  const openBrowser = async (url: string, workspaceId: string, fromDialog = false): Promise<void> => {
    if (opening.current) return;
    opening.current = true;
    setOpeningBrowser(true);
    setLinkError("");
    try {
      const latest = await window.desktop.snapshot();
      const workspace = documentBrowserWorkspaces(latest, thread.id).find((item) => item.id === workspaceId);
      if (!workspace) throw new Error("This workspace is no longer available. Choose a ready workspace in an active work thread.");
      const browser = await window.desktop.createBrowser({ workspaceId, url });
      await document.flush();
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      setLinkRequest(null);
      const store = useWorkbenchStore.getState();
      store.setActiveSession(workspaceId, browser.id);
      store.openWorkspace(workspace);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(cause);
      if (fromDialog) setLinkError(message);
      else toast.error(message);
    } finally {
      opening.current = false;
      setOpeningBrowser(false);
    }
  };
  useEffect(() => {
    void document.flush();
    return () => { void document.flush(); };
  }, [document]);
  return (
    <section className="thread-document-page">
      <header className={`thread-document-header ${onClose ? "no-drag" : "drag"}`}>
        {!onClose && <SidebarReopenButton />}
        <div className="thread-document-title no-drag"><FileText size={17} /><div><h1 title={thread.name}>{thread.name}</h1></div></div>
        <div className="thread-document-actions no-drag">
          <span className={`document-save-status ${state.status}`} role="status" aria-live="polite">
            {state.status === "saved" ? <><Check size={13} /> Saved</> : state.status === "error" ? "Save failed" : <><Loader2 className="spinning" size={13} /> {state.status === "saving" ? "Saving…" : "Unsaved changes"}</>}
          </span>
          {thread.status === "active" && <button className="icon-button" title="Finish work thread" aria-label="Finish work thread" onClick={() => useWorkbenchStore.getState().openFinishWorkThread(thread.id)}><CircleCheck size={16} /></button>}
          {onClose ? backToList ? <button className="button" onClick={onClose}><ArrowLeft size={14} /> Back to list</button> : <button className="icon-button" onClick={onClose} aria-label="Close document"><X size={16} /></button> : <button className="button" onClick={() => openWorkspaceDialog(thread.id)}><Plus size={14} /> New Workspace</button>}
        </div>
      </header>
      {thread.completion && <details className="thread-completion no-drag">
        <summary>{thread.status === "active" ? "Last finish" : "Finished"}: {thread.completion.outcome === "completed" ? "Completed" : "Cancelled"} · <time dateTime={thread.completion.finishedAt}>{new Date(thread.completion.finishedAt).toLocaleString()}</time></summary>
        <p className="selectable">{thread.completion.note || "No note provided."}</p>
      </details>}
      <div className="thread-document-age no-drag"><WorkThreadAge thread={thread} details visibility="reminders" /></div>
      <div className="thread-document-toolbar no-drag">
        <div className="segmented" role="tablist" aria-label="Work thread content" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const tabs = ["document", "todos", "changes", "codex"] as const;
          const next = event.key === "Home" ? "document" : event.key === "End" ? "codex" : tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
          void document.flush();
          setTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[id="${next}-tab-${thread.id}"]`)?.focus();
        }}>
          <button role="tab" title="Markdown document" tabIndex={tab === "document" ? 0 : -1} id={`document-tab-${thread.id}`} aria-controls={`document-panel-${thread.id}`} aria-selected={tab === "document"} className={tab === "document" ? "active" : ""} onClick={() => setTab("document")}>Document</button>
          <button role="tab" tabIndex={tab === "todos" ? 0 : -1} id={`todos-tab-${thread.id}`} aria-controls={`todos-panel-${thread.id}`} aria-selected={tab === "todos"} className={tab === "todos" ? "active" : ""} onClick={() => { void document.flush(); setTab("todos"); }}>Todos ({(thread.todos ?? []).filter((todo) => !todo.completedAt).length})</button>
          <button role="tab" tabIndex={tab === "changes" ? 0 : -1} id={`changes-tab-${thread.id}`} aria-controls={`changes-panel-${thread.id}`} aria-selected={tab === "changes"} className={tab === "changes" ? "active" : ""} onClick={() => { void document.flush(); setTab("changes"); }}>Changes ({thread.workspaceChanges?.length ?? 0})</button>
          <button role="tab" tabIndex={tab === "codex" ? 0 : -1} id={`codex-tab-${thread.id}`} aria-controls={`codex-panel-${thread.id}`} aria-selected={tab === "codex"} className={tab === "codex" ? "active" : ""} onClick={() => { void document.flush(); setTab("codex"); }}>Codex ({thread.codexSessions?.length ?? 0})</button>
        </div>
        <div className="thread-document-age-inline"><WorkThreadAge thread={thread} visibility="normal" /></div>
      </div>
      {state.status === "error" && <div className="document-save-error no-drag" role="alert"><span>{state.error}. Your draft is kept on this device.</span><button className="button" onClick={() => void document.flush()}>Retry save</button></div>}
      <section hidden={tab !== "document"} role="tabpanel" id={`document-panel-${thread.id}`} aria-labelledby={`document-tab-${thread.id}`} className="thread-document-editor no-drag" aria-label="Work thread document" onBlur={() => void document.flush()} onClickCapture={(event) => {
        const link = event.target instanceof Element ? event.target.closest("a") : null;
        const href = link?.getAttribute("href");
        if (!href || href.startsWith("#")) return;
        event.preventDefault();
        event.stopPropagation();
        if (opening.current || linkRequest) return;
        if (/^mailto:/i.test(href)) {
          void window.desktop.openDocumentLink(href).catch(() => toast.error("Could not open this link."));
          return;
        }
        if (!/^https?:/i.test(href)) { toast.error("Use an http, https, or email link."); return; }
        let url: string;
        try { url = normalizeBrowserUrl(href); }
        catch { toast.error("Enter an HTTP or HTTPS address without credentials."); return; }
        if (thread.status !== "active") { toast.error("Restore this work thread before opening links in Browser."); return; }
        if (!browserWorkspaces.length) { toast.error("Create or repair a workspace in this work thread before opening links in Browser."); return; }
        if (browserWorkspaces.length === 1) { void openBrowser(url, browserWorkspaces[0]!.id); return; }
        setLinkError("");
        setLinkRequest({ url, workspaceId: browserWorkspaces[0]!.id });
      }}>
        <MarkdownEditor key={documentRevision} document={document} autoFocus={autoFocus} />
      </section>
      {tab === "todos" && <div className="thread-todos-panel" role="tabpanel" id={`todos-panel-${thread.id}`} aria-labelledby={`todos-tab-${thread.id}`}><TodoList threads={[thread]} recentOnly /></div>}
      {tab === "changes" && <div className="thread-changes-panel no-drag" role="tabpanel" id={`changes-panel-${thread.id}`} aria-labelledby={`changes-tab-${thread.id}`}>
        {!thread.workspaceChanges?.length && <p className="creation-note">Workspace deletion summaries will appear here. They remain available after Finish and archival.</p>}
        {[...(thread.workspaceChanges ?? [])].reverse().map((record) => <section key={record.workspaceId} className="creation-workspace">
          <div className="creation-workspace-heading"><strong>{record.name}</strong><span>{record.outcome === "deleted" ? "Deleted" : record.outcome === "failed" ? "Deletion failed" : "Result unconfirmed"}</span></div>
          <p>{record.projectName} · {record.deviceName}</p>
          {record.error && <p className="creation-error">{record.error}</p>}
          <WorkspaceChangeDetails inspection={record} />
          <button type="button" className="button" onClick={() => appendSummary(record)}>Add summary to Doc</button>
        </section>)}
      </div>}
      {tab === "codex" && <div className="codex-sessions-panel no-drag" role="tabpanel" id={`codex-panel-${thread.id}`} aria-labelledby={`codex-tab-${thread.id}`}><CodexSessionList thread={thread} snapshot={snapshot} /></div>}
      {linkRequest && <div onKeyDown={(event) => event.stopPropagation()}>
        <Modal open title="Open link in Browser" description="Choose a workspace for this link." busy={openingBrowser}
          submitLabel="Open" submitDisabled={!browserWorkspaces.some((workspace) => workspace.id === linkRequest.workspaceId)}
          onClose={() => { if (!opening.current) setLinkRequest(null); }}
          onSubmit={(event) => { event.preventDefault(); void openBrowser(linkRequest.url, linkRequest.workspaceId, true); }}>
          <Field label="Link"><input value={linkRequest.url} readOnly title={linkRequest.url} /></Field>
          <Field label="Workspace"><select value={linkRequest.workspaceId} disabled={openingBrowser} onChange={(event) => { setLinkRequest({ ...linkRequest, workspaceId: event.target.value }); setLinkError(""); }}>
            {!browserWorkspaces.some((workspace) => workspace.id === linkRequest.workspaceId) && <option value={linkRequest.workspaceId} disabled>Workspace unavailable</option>}
            {browserWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {snapshot.projects.find((project) => project.id === workspace.projectId)?.name ?? "Unknown project"} · {snapshot.devices.find((device) => device.id === workspace.deviceId)?.name ?? "Unknown device"}</option>)}
          </select></Field>
          {linkError && <div className="field"><small className="field-error selectable" role="alert">{linkError}</small></div>}
        </Modal>
      </div>}
    </section>
  );
}
