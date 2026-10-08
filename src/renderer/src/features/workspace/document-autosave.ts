import { useEffect } from "react";
import { toast } from "sonner";
import type { WorkThread } from "@/shared/domain";

export interface DocumentState {
  content: string;
  status: "saved" | "pending" | "saving" | "error";
  error?: string;
}

interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class DocumentAutosave {
  private state: DocumentState;
  private savedContent: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly key: string;

  constructor(
    id: string,
    content: string,
    private readonly save: (content: string) => Promise<void>,
    private readonly storage?: DraftStorage,
    private readonly delay = 500
  ) {
    this.key = `superthread-document-draft:${id}`;
    this.savedContent = content;
    let draft: string | null = null;
    try { draft = storage?.getItem(this.key) ?? null; } catch { /* Persistence still works when recovery storage is unavailable. */ }
    this.state = { content: draft ?? content, status: draft !== null && draft !== content ? "pending" : "saved" };
  }

  getSnapshot = (): DocumentState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  edit(content: string): void {
    // Keep a recovery copy before scheduling IPC, including during window shutdown.
    try { this.storage?.setItem(this.key, content); } catch { /* The main-process save remains authoritative. */ }
    this.publish({ content, status: "pending" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }

  flush = async (): Promise<void> => {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    if (this.state.content === this.savedContent) {
      this.publish({ content: this.state.content, status: "saved" });
      this.clearDraft();
      return;
    }
    // Serialize saves; edits made while a write is in flight are saved next.
    this.pending = this.saveLatest();
    try { await this.pending; } finally { this.pending = undefined; }
  };

  private async saveLatest(): Promise<void> {
    while (this.state.content !== this.savedContent) {
      const content = this.state.content;
      this.publish({ content, status: "saving" });
      try {
        await this.save(content);
        this.savedContent = content;
      } catch (error) {
        this.publish({ content: this.state.content, status: "error", error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error) });
        return;
      }
    }
    this.clearDraft();
    this.publish({ content: this.state.content, status: "saved" });
  }

  discard(): void {
    clearTimeout(this.timer);
    this.clearDraft();
  }

  private clearDraft(): void {
    try { this.storage?.removeItem(this.key); } catch { /* A redundant draft is safe to recover on the next launch. */ }
  }

  private publish(state: DocumentState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

const documents = new Map<string, DocumentAutosave>();

export function threadDocumentAutosave(id: string, content: string): DocumentAutosave {
  let document = documents.get(id);
  if (!document) {
    document = new DocumentAutosave(id, content, (value) => window.desktop.saveWorkThreadDocument({ id, content: value }), window.localStorage);
    documents.set(id, document);
  }
  return document;
}

export function useDocumentAutosaveLifecycle(threads?: readonly WorkThread[]): void {
  useEffect(() => {
    if (!threads) return;
    const existingIds = new Set(threads.map((thread) => thread.id));
    for (const id of documents.keys()) {
      if (existingIds.has(id)) continue;
      documents.get(id)?.discard();
      documents.delete(id);
    }
  }, [threads]);
  useEffect(() => {
    const flush = (): void => { documents.forEach((document) => { void document.flush(); }); };
    const close = (event: BeforeUnloadEvent): void => {
      const unsaved = [...documents.values()].filter((document) => document.getSnapshot().status !== "saved");
      if (!unsaved.length) return;
      event.preventDefault();
      event.returnValue = false;
      void Promise.all(unsaved.map((document) => document.flush())).then(() => {
        if (unsaved.every((document) => document.getSnapshot().status === "saved")) window.desktop.finishDocumentClose();
        else toast.error("Document could not be saved. Retry saving before closing.");
      });
    };
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", close);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("beforeunload", close);
      flush();
    };
  }, []);
}
