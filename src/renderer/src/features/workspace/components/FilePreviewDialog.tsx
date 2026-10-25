import { ArrowUp, FileText, Folder, LoaderCircle, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FilePreviewTab, Workspace, WorkspaceFileLocation } from "@/shared/domain";
import { Modal } from "./Modal";

export function FilePreviewDialog({ workspace, onClose, onOpen }: { workspace: Workspace; onClose(): void; onOpen(tab: FilePreviewTab): void }): React.ReactNode {
  const [location, setLocation] = useState<WorkspaceFileLocation>();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const visit = async (input: string): Promise<void> => {
    const current = ++generation.current;
    setBusy(true); setError("");
    try {
      const result = await window.desktop.browseWorkspaceFiles({ workspaceId: workspace.id, path: input });
      if (current !== generation.current) return;
      if (result.kind === "directory") { setLocation(result); setPath(result.path === "." ? "" : result.path); }
      else {
        if (!result.fileType) throw new Error("Choose a PDF, HTML, or Markdown file.");
        const tab = await window.desktop.openFilePreview({ workspaceId: workspace.id, path: result.path });
        if (current === generation.current) onOpen(tab);
      }
    } catch (cause) { if (current === generation.current) setError(String(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  useEffect(() => {
    void visit("");
    return () => { generation.current++; };
  }, [workspace.id]);
  const segments = location?.path === "." ? [] : location?.path.split("/") ?? [];
  return <Modal open title="Open file preview" description={`Browse PDF, HTML, and Markdown files in ${workspace.name}.`} onClose={onClose}
    onSubmit={(event) => { event.preventDefault(); if (!busy) void visit(path); }}
    footer={<><button type="button" className="button" onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy ? "Loading…" : "Open path"}</button></>}>
    <div className="file-picker-path"><input aria-label="Workspace file path" placeholder="Relative path or absolute path within this workspace" value={path} onChange={(event) => setPath(event.target.value)} spellCheck={false} /><button type="button" className="icon-button" aria-label="Refresh directory" disabled={busy} onClick={() => void visit(location?.path ?? "")}><RotateCw size={15} /></button></div>
    <nav className="file-picker-breadcrumbs" aria-label="File location">
      <button type="button" disabled={busy} title={workspace.path} onClick={() => void visit("")}>{workspace.name}</button>
      {segments.map((segment, index) => <span key={index}> / <button type="button" disabled={busy} onClick={() => void visit(segments.slice(0, index + 1).join("/"))}>{segment}</button></span>)}
    </nav>
    {error && <p className="field-error selectable" role="alert">{error}</p>}
    <div className="file-picker-list" aria-busy={busy}>
      {location?.parentPath != null && <button type="button" className="file-picker-entry" disabled={busy} onClick={() => void visit(location.parentPath!)}><ArrowUp size={16} /><span>Parent directory</span></button>}
      {location?.entries?.map((entry) => <button type="button" className="file-picker-entry" key={`${entry.path}:${entry.name}`} disabled={busy} title={entry.name} onClick={() => void visit(entry.path)}>{entry.kind === "directory" ? <Folder size={16} /> : <FileText size={16} />}<span>{entry.name}</span></button>)}
      {busy && <div className="file-picker-status"><LoaderCircle size={16} className="spinning" /> Loading files…</div>}
      {!busy && location && !location.entries?.length && <p className="file-picker-status">No supported files in this directory.</p>}
    </div>
  </Modal>;
}
