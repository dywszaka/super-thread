import { useState } from "react";
import { toast } from "sonner";
import type { WorkspaceDeleteInspection } from "@/shared/work-thread-finish";
import { submoduleActivityLabel, submoduleStateLabel, workspaceChangesMarkdown, type WorkspaceChangeRecord } from "@/shared/workspace-changes";

export function WorkspaceChangeDetails({ inspection, busy = false }: { inspection: WorkspaceDeleteInspection | WorkspaceChangeRecord; busy?: boolean }): React.ReactNode {
  const [exporting, setExporting] = useState(false);
  const changes = inspection.changes;
  const markdown = () => workspaceChangesMarkdown(inspection);
  const copy = async (): Promise<void> => {
    try { await window.desktop.writeClipboard(markdown()); toast.success("Change summary copied as Markdown"); }
    catch { toast.error("Could not copy the change summary"); }
  };
  const save = async (): Promise<void> => {
    setExporting(true);
    try { if (await window.desktop.exportWorkspaceChanges(markdown())) toast.success("Change summary exported"); }
    catch { toast.error("Could not export the change summary"); }
    finally { setExporting(false); }
  };
  return <div className="workspace-changes no-drag">
    <div className="workspace-change-actions"><button type="button" className="button" disabled={busy || exporting} onClick={() => void copy()}>Copy Markdown</button><button type="button" className="button" disabled={busy || exporting} onClick={() => void save()}>{exporting ? "Exporting…" : "Export Markdown"}</button></div>
    <p className="creation-note">Checked: {inspection.checkedAt ? new Date(inspection.checkedAt).toLocaleString() : "Unknown"}</p>
    {changes ? <>
      <p className="creation-note">Starting point: {changes.baseline.source === "created" ? "Workspace creation" : changes.baseline.source === "inferred" ? "Inferred from Git history" : "Unknown"} · <code>{changes.baseline.commit?.slice(0, 12) ?? "unavailable"}</code></p>
      {changes.baseline.warning && <p className="workspace-change-warning">{changes.baseline.warning}</p>}
      <p className="creation-note">Changes compare starting and current versions. Edits later reverted may not appear. A version change does not identify who authored the code.</p>
      {changes.submodules.length === 0 ? <p>No submodules found.</p> : <div className="workspace-change-table"><table>
        <thead><tr><th scope="col">Submodule / this workspace</th><th scope="col">Current state</th></tr></thead>
        <tbody>{changes.submodules.map((sub) => <tr key={sub.path}>
          <td><strong className="selectable">{sub.path}</strong><span className={`workspace-change-label ${sub.activity === "unchanged" ? "" : "has-changes"}`}>{submoduleActivityLabel(sub.activity)}</span></td>
          <td><p>{submoduleStateLabel(sub)}</p><p className="creation-note selectable"><code>{sub.startCommit?.slice(0, 12) ?? "unknown / absent"}</code> → <code>{sub.currentCommit?.slice(0, 12) ?? "unknown / absent"}</code></p>
            {sub.recordedCommit && sub.recordedCommit !== sub.currentCommit && <p className="creation-note selectable">Parent index: <code>{sub.recordedCommit.slice(0, 12)}</code></p>}
            {sub.warning && <p className="workspace-change-warning">{sub.warning}</p>}
            {Boolean(sub.files?.length || sub.commits?.length) && <details><summary>Files and commits</summary>
              {Boolean(sub.files?.length) && <><p>Files with changes</p><ul>{sub.files!.map((file) => <li key={file} className="selectable">{file}</li>)}</ul></>}
              {Boolean(sub.commits?.length) && <><p>Commits since starting point</p><ul>{sub.commits!.map((commit) => <li key={commit.hash} className="selectable"><code>{commit.hash.slice(0, 12)}</code> {commit.subject}</li>)}</ul></>}
              {sub.detailsTruncated && <p className="creation-note">Details truncated; warnings and totals still apply.</p>}
            </details>}
          </td>
        </tr>)}</tbody>
      </table></div>}
    </> : <p className="creation-note">Submodule change details are unavailable for this workspace.</p>}
    {"outcome" in inspection && inspection.risks.length > 0 && <details><summary>Deletion warnings at inspection</summary><ul>{inspection.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul></details>}
  </div>;
}
