import { WorkThreadAge } from "./WorkThreadAge";
import { TodoList } from "./TodoList";
import { MarkdownEditor } from "./MarkdownEditor";
import { ArrowLeft, Check, FileText, Loader2, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { WorkThread } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { threadDocumentAutosave } from "../document-autosave";
import { SidebarReopenButton } from "./Sidebar";

export function WorkThreadDocument({ thread, onClose, backToList = false }: { thread: WorkThread; onClose?: () => void; backToList?: boolean }): React.ReactNode {
  const [tab, setTab] = useState<"document" | "todos">("document");
  const openWorkspaceDialog = useWorkbenchStore((state) => state.openWorkspaceDialog);
  const document = useMemo(() => threadDocumentAutosave(thread.id, thread.document ?? ""), [thread.id]);
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
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
          {onClose ? backToList ? <button className="button" onClick={onClose}><ArrowLeft size={14} /> Back to list</button> : <button className="icon-button" onClick={onClose} aria-label="Close document"><X size={16} /></button> : <button className="button" onClick={() => openWorkspaceDialog(thread.id)}><Plus size={14} /> New Workspace</button>}
        </div>
      </header>
      <div className="thread-document-age no-drag"><WorkThreadAge thread={thread} details visibility="reminders" /></div>
      <div className="thread-document-toolbar no-drag">
        <div className="segmented" role="tablist" aria-label="Work thread content" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "document" : event.key === "End" ? "todos" : tab === "document" ? "todos" : "document";
          void document.flush();
          setTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[id="${next}-tab-${thread.id}"]`)?.focus();
        }}>
          <button role="tab" title="Markdown document" tabIndex={tab === "document" ? 0 : -1} id={`document-tab-${thread.id}`} aria-controls={`document-panel-${thread.id}`} aria-selected={tab === "document"} className={tab === "document" ? "active" : ""} onClick={() => setTab("document")}>Document</button>
          <button role="tab" tabIndex={tab === "todos" ? 0 : -1} id={`todos-tab-${thread.id}`} aria-controls={`todos-panel-${thread.id}`} aria-selected={tab === "todos"} className={tab === "todos" ? "active" : ""} onClick={() => { void document.flush(); setTab("todos"); }}>Todos ({(thread.todos ?? []).filter((todo) => !todo.completedAt).length})</button>
        </div>
        <div className="thread-document-age-inline"><WorkThreadAge thread={thread} visibility="normal" /></div>
      </div>
      {state.status === "error" && <div className="document-save-error no-drag" role="alert"><span>{state.error}. Your draft is kept on this device.</span><button className="button" onClick={() => void document.flush()}>Retry save</button></div>}
      <section hidden={tab !== "document"} role="tabpanel" id={`document-panel-${thread.id}`} aria-labelledby={`document-tab-${thread.id}`} className="thread-document-editor no-drag" aria-label="Work thread document" onBlur={() => void document.flush()} onClick={(event) => {
        const link = event.target instanceof Element ? event.target.closest("a") : null;
        const href = link?.getAttribute("href");
        if (!href || href.startsWith("#")) return;
        if (link?.closest('[contenteditable="true"]') && !event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        if (/^(https?:|mailto:)/i.test(href)) {
          void window.desktop.openDocumentLink(href).catch(() => toast.error("Could not open this link."));
        } else toast.error("Use an http, https, or email link.");
      }}>
        <MarkdownEditor document={document} autoFocus={Boolean(onClose)} />
      </section>
      {tab === "todos" && <div className="thread-todos-panel" role="tabpanel" id={`todos-panel-${thread.id}`} aria-labelledby={`todos-tab-${thread.id}`}><TodoList threads={[thread]} recentOnly /></div>}
    </section>
  );
}
