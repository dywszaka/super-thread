import MDEditor, { commands } from "@uiw/react-md-editor";
import rehypeSanitize from "rehype-sanitize";
import { Check, FileText, Loader2, Plus } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { WorkThread } from "@/shared/domain";
import { MAX_WORK_THREAD_DOCUMENT_LENGTH } from "@/shared/contract";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { threadDocumentAutosave } from "../document-autosave";
import { SidebarReopenButton } from "./Sidebar";

export function WorkThreadDocument({ thread }: { thread: WorkThread }): React.ReactNode {
  const openDialog = useWorkbenchStore((state) => state.openDialog);
  const document = useMemo(() => threadDocumentAutosave(thread.id, thread.document ?? ""), [thread.id]);
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  const [mode, setMode] = useState<"edit" | "live" | "preview">("live");
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const change = (): void => setDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    void document.flush();
    return () => { void document.flush(); };
  }, [document]);
  return (
    <main className="thread-document-page">
      <header className="thread-document-header drag">
        <SidebarReopenButton />
        <div className="thread-document-title no-drag"><FileText size={17} /><div><h1>{thread.name}</h1><p>Document · Markdown</p></div></div>
        <div className="thread-document-actions no-drag">
          <span className={`document-save-status ${state.status}`} role="status" aria-live="polite">
            {state.status === "saved" ? <><Check size={13} /> Saved</> : state.status === "error" ? "Save failed" : <><Loader2 className="spinning" size={13} /> {state.status === "saving" ? "Saving…" : "Unsaved changes"}</>}
          </span>
          <button className="button" onClick={() => openDialog("workspace")}><Plus size={14} /> New Workspace</button>
        </div>
      </header>
      <div className="thread-document-toolbar no-drag">
        <span>Use Markdown to write notes, plans, and documentation.</span>
        <div className="segmented" aria-label="Document view">
          {(["edit", "live", "preview"] as const).map((value) => <button key={value} aria-pressed={mode === value} className={mode === value ? "active" : ""} onClick={() => setMode(value)}>{value === "edit" ? "Edit" : value === "live" ? "Split" : "Preview"}</button>)}
        </div>
      </div>
      {state.status === "error" && <div className="document-save-error no-drag" role="alert"><span>{state.error}. Your draft is kept on this device.</span><button className="button" onClick={() => void document.flush()}>Retry save</button></div>}
      <section className="thread-document-editor no-drag" data-color-mode={dark ? "dark" : "light"} aria-label="Work thread document" onClick={(event) => {
        const link = event.target instanceof Element ? event.target.closest("a") : null;
        const href = link?.getAttribute("href");
        if (!href || href.startsWith("#")) return;
        event.preventDefault();
        if (/^(https?:|mailto:)/i.test(href)) {
          void window.desktop.openDocumentLink(href).catch(() => toast.error("Could not open this link."));
        } else toast.error("Use an http, https, or email link.");
      }}>
        <MDEditor
          value={state.content}
          onChange={(value) => {
            const content = value ?? "";
            if (content.length > MAX_WORK_THREAD_DOCUMENT_LENGTH) { toast.error("Document is too large (maximum 2 million characters)."); return; }
            document.edit(content);
          }}
          preview={mode}
          height="100%"
          visibleDragbar={false}
          commands={[commands.title, commands.bold, commands.italic, commands.strikethrough, commands.divider, commands.link, commands.quote, commands.code, commands.codeBlock, commands.divider, commands.unorderedListCommand, commands.orderedListCommand, commands.checkedListCommand]}
          extraCommands={[]}
          textareaProps={{ "aria-label": "Markdown document", placeholder: "# Start writing\n\nCapture your notes, plans, and ideas here…", maxLength: MAX_WORK_THREAD_DOCUMENT_LENGTH }}
          previewOptions={{ rehypePlugins: [rehypeSanitize] }}
        />
      </section>
    </main>
  );
}
