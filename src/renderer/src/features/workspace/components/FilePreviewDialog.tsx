import { ArrowUp, FileText, Folder, LoaderCircle, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FilePreviewTab, Workspace, WorkspaceFileLocation } from "@/shared/domain";
import { Modal } from "./Modal";

export function FilePreviewDialog({ workspace, previewId, initialDirectory = "", onClose, onOpen }: {
  workspace: Workspace;
  previewId?: string;
  initialDirectory?: string;
  onClose(): void;
  onOpen(tab: FilePreviewTab): void;
}): React.ReactNode {
  const [location, setLocation] = useState<WorkspaceFileLocation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const visit = async (input: string): Promise<void> => {
    const current = ++generation.current;
    setBusy(true); setError("");
    try {
      const result = await window.desktop.browseWorkspaceFiles({ workspaceId: workspace.id, path: input });
      if (current !== generation.current) return;
      if (result.kind === "directory") setLocation(result);
      else {
        if (!result.fileType) throw new Error("Choose a PDF, HTML, or Markdown file.");
        const tab = previewId
          ? await window.desktop.navigateFilePreview({ id: previewId, path: result.path })
          : await window.desktop.openFilePreview({ workspaceId: workspace.id, path: result.path });
        if (current === generation.current) onOpen(tab);
      }
    } catch (cause) { if (current === generation.current) setError(String(cause)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  useEffect(() => {
    void visit(initialDirectory);
    return () => { generation.current++; };
  }, [workspace.id, initialDirectory, previewId]);
  const segments = location?.path === "." ? [] : location?.path.split("/") ?? [];
  return <Modal open title={previewId ? "Switch preview file" : "Open file preview"} description={`Choose a PDF, HTML, or Markdown file in ${workspace.name}.`} onClose={onClose}
    onSubmit={(event) => event.preventDefault()}
    footer={<button type="button" className="button" onClick={onClose}>Cancel</button>}>
    <div className="file-picker-path"><input aria-label="Workspace file path" value={location?.path ?? (initialDirectory || ".")} readOnly spellCheck={false} /><button type="button" className="icon-button" aria-label="Refresh directory" disabled={busy} onClick={() => void visit(location?.path ?? initialDirectory)}><RotateCw size={15} /></button></div>
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
