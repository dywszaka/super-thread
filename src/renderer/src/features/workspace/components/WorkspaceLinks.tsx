import { useQuery } from "@tanstack/react-query";
import { File, Folder, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

export function WorkspaceLinks({ projectId, deviceId, checkoutPath, selectedPaths, onChange, busy }: {
  projectId: string; deviceId: string; checkoutPath: string; selectedPaths: string[];
  onChange(paths: string[]): void; busy: boolean;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const candidates = useQuery({
    queryKey: ["workspace-link-candidates", projectId, deviceId, checkoutPath],
    queryFn: () => window.desktop.listWorkspaceLinkCandidates({ projectId, deviceId }),
    enabled: expanded,
    retry: false
  });
  return <details className="workspace-links" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>Link files and folders <span>{selectedPaths.length ? `${selectedPaths.length} selected` : "Optional"}</span></summary>
    <p>Choose untracked or ignored items from the project checkout. Links use the same relative names and share the original contents.</p>
    <div className="workspace-links-toolbar"><code title={checkoutPath}>{checkoutPath}</code><button type="button" className="icon-button" title="Refresh link candidates" disabled={busy || candidates.isFetching} onClick={() => void candidates.refetch()}><RefreshCw size={14} className={candidates.isFetching ? "spinning" : ""} /></button></div>
    {candidates.isPending && <div className="directory-empty" role="status">Loading files and folders…</div>}
    {candidates.error && <div className="directory-error" role="alert">{candidates.error.message.replace(/^Error invoking remote method '[^']+': /, "")}</div>}
    {candidates.data && <div className="workspace-link-list">
      {candidates.data.map((entry) => <label key={entry.path} title={entry.path}>
        <input type="checkbox" checked={selectedPaths.includes(entry.path)} disabled={busy || (!selectedPaths.includes(entry.path) && selectedPaths.length >= 256)} onChange={(event) => onChange(event.target.checked ? [...selectedPaths, entry.path] : selectedPaths.filter((path) => path !== entry.path))} />
        {entry.kind === "directory" ? <Folder size={14} /> : <File size={14} />}<span>{entry.path}{entry.kind === "directory" ? "/" : ""}</span>
      </label>)}
      {candidates.data.length === 0 && <div className="directory-empty">No untracked or ignored files or folders.</div>}
    </div>}
    {selectedPaths.some((path) => candidates.data && !candidates.data.some((entry) => entry.path === path)) && <div className="directory-error">Some selected items are no longer available. <button type="button" className="button" disabled={busy} onClick={() => onChange(selectedPaths.filter((path) => candidates.data?.some((entry) => entry.path === path)))}>Clear unavailable items</button></div>}
  </details>;
}
