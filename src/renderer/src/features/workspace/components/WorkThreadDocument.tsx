import { MarkdownEditor } from "./MarkdownEditor";
import { Check, FileText, Loader2, Plus, X } from "lucide-react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { WorkThread } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { threadDocumentAutosave } from "../document-autosave";
import { SidebarReopenButton } from "./Sidebar";

export function WorkThreadDocument({ thread, onClose }: { thread: WorkThread; onClose?: () => void }): React.ReactNode {
  const openDialog = useWorkbenchStore((state) => state.openDialog);
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
        <div className="thread-document-title no-drag"><FileText size={17} /><div><h1>{thread.name}</h1><p>Document · Markdown</p></div></div>
        <div className="thread-document-actions no-drag">
          <span className={`document-save-status ${state.status}`} role="status" aria-live="polite">
            {state.status === "saved" ? <><Check size={13} /> Saved</> : state.status === "error" ? "Save failed" : <><Loader2 className="spinning" size={13} /> {state.status === "saving" ? "Saving…" : "Unsaved changes"}</>}
          </span>
          {onClose ? <button className="icon-button" onClick={onClose} aria-label="Close document"><X size={16} /></button> : <button className="button" onClick={() => openDialog("workspace")}><Plus size={14} /> New Workspace</button>}
        </div>
      </header>
      <div className="thread-document-toolbar no-drag">
        <span>Use Markdown to write notes, plans, and documentation.</span>
      </div>
      {state.status === "error" && <div className="document-save-error no-drag" role="alert"><span>{state.error}. Your draft is kept on this device.</span><button className="button" onClick={() => void document.flush()}>Retry save</button></div>}
      <section className="thread-document-editor no-drag" aria-label="Work thread document" onBlur={() => void document.flush()} onClick={(event) => {
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
    </section>
  );
}
