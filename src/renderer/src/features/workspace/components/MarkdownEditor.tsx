import { CrepeBuilder } from "@milkdown/crepe/builder";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { serializerCtx, editorViewCtx } from "@milkdown/kit/core";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MAX_WORK_THREAD_DOCUMENT_LENGTH } from "@/shared/contract";
import type { DocumentAutosave } from "../document-autosave";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

export function MarkdownEditor({ document, autoFocus }: { document: DocumentAutosave; autoFocus: boolean }): React.ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let ready = false;
    setError(false);
    const editor = new CrepeBuilder({ root: host.current, defaultValue: document.getSnapshot().content })
      .addFeature(toolbar)
      .addFeature(blockEdit)
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(table)
      .addFeature(placeholder, { text: "Start writing… Type / for blocks, or use Markdown formatting.", mode: "doc" });
    editor.editor.use($prose((ctx) => new Plugin({
      filterTransaction(transaction) {
        if (!transaction.docChanged) return true;
        if (ctx.get(serializerCtx)(transaction.doc).length <= MAX_WORK_THREAD_DOCUMENT_LENGTH) return true;
        toast.error("Document is too large (maximum 2 million characters).");
        return false;
      },
      view: () => ({
        update(view, previous) {
          if (!ready || disposed || view.state.doc.eq(previous.doc)) return;
          // Capture every transaction synchronously. A debounced editor listener
          // can miss the final keystroke when switching threads or closing.
          document.edit(ctx.get(serializerCtx)(view.state.doc));
        }
      })
    })));
    void editor.create().then(() => {
      if (disposed) { void editor.destroy(); return; }
      ready = true;
      editor.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dom.setAttribute("aria-label", "Markdown document");
        view.dom.setAttribute("role", "textbox");
        view.dom.setAttribute("aria-multiline", "true");
        if (autoFocus) view.focus();
      });
    }).catch(() => { if (!disposed) setError(true); });
    return () => {
      disposed = true;
      void document.flush();
      if (ready) void editor.destroy();
    };
  }, [document, autoFocus]);
  return <>{error && <div role="alert">Could not open the editor. Reopen this document to retry.</div>}<div ref={host} className="markdown-editor" /></>;
}
