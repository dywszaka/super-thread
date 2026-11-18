import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type { WorkspaceChangeRecord } from "@/shared/workspace-changes";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { Modal } from "./Modal";
import { WorkspaceChangeDetails } from "./WorkspaceChangeDetails";

const message = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function DeleteWorkspaceDialog(): React.ReactNode {
  const { deleteWorkspaceId, closeDialog } = useWorkbenchStore();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<WorkspaceChangeRecord>();
  const [failedResult, setFailedResult] = useState<WorkspaceChangeRecord>();
  const inspection = useQuery({ queryKey: ["delete-workspace", deleteWorkspaceId], queryFn: () => window.desktop.inspectWorkspaceDeletion(deleteWorkspaceId!), enabled: Boolean(deleteWorkspaceId && !result), retry: false, refetchOnWindowFocus: false, refetchOnMount: "always" });
  const item = result ?? inspection.data;
  const refresh = async (keepFailure = false): Promise<void> => {
    setApproved(false);
    if (!keepFailure) { setFailedResult(undefined); setError(""); }
    await inspection.refetch();
  };
  const valid = Boolean(item && !item.error && !inspection.isFetching && !inspection.error && (!item.risks.length || approved));
  const remove = async (): Promise<void> => {
    if (!deleteWorkspaceId || !valid || busy) return;
    const before = inspection.data;
    setFailedResult(undefined);
    setBusy(true); setError("");
    try {
      const snapshot = await window.desktop.snapshot();
      const workspace = snapshot.workspaces.find((entry) => entry.id === deleteWorkspaceId);
      const record = await window.desktop.deleteWorkspace(deleteWorkspaceId, approved);
      setResult(record);
      const state = useWorkbenchStore.getState();
      if (state.activeWorkspaceId === deleteWorkspaceId) {
        if (workspace?.workThreadId) state.setActiveWorkspace(null);
        else state.showAllWorkspaces();
      }
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success("Workspace deleted");
    } catch (cause) {
      setError(message(cause));
      if (before) setFailedResult({ ...before, checkedAt: before.checkedAt ?? new Date().toISOString(), outcome: "failed", updatedAt: new Date().toISOString(), error: message(cause) });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      await refresh(true);
    } finally { setBusy(false); }
  };
  return <Modal open title={result ? "Workspace deleted" : "Delete workspace"} description={result ? "Keep a copy of this summary for your development records. Work Thread summaries remain in its Changes tab." : "Review submodule changes before deleting this workspace. Project directories are kept."} busy={busy} onClose={closeDialog} onSubmit={(event) => { event.preventDefault(); if (result) closeDialog(); else void remove(); }} footer={result ? <button className="button primary" type="button" onClick={closeDialog}>Done</button> : <>
    <button type="button" className="button" disabled={busy} onClick={closeDialog}>Cancel</button>
    <button type="button" className="button" disabled={busy || inspection.isFetching} onClick={() => void refresh()}>Refresh checks</button>
    <button className="button primary" disabled={busy || !valid}>{busy ? "Deleting…" : "Delete Workspace"}</button>
  </>}>
    {inspection.isFetching && <p role="status">Checking workspace…</p>}
    {inspection.error && <p className="field-error" role="alert">{message(inspection.error)}</p>}
    {item && <><strong>{item.name}</strong><p className="creation-note">{item.projectName} · {item.deviceName} · {item.branch}</p>
      <div className="callout"><span>{item.keepsDirectory ? "The project directory and its files are kept. Only workspace tabs and terminal sessions are removed." : "The worktree directory, its submodule contents and its branch will be removed. These files cannot be restored from the summary."}</span></div>
      {failedResult && <p className="creation-note">The summary below describes the failed attempt. Refresh the checks to review the latest state before retrying.</p>}
      <WorkspaceChangeDetails inspection={failedResult ?? item} busy={busy} />
      {!result && <>
        {item.error && <p className="field-error" role="alert">{item.error}</p>}
        {item.risks.length > 0 && <><ul className="finish-workspace-risks">{item.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
          <label className="finish-force-confirmation"><input type="checkbox" checked={approved} disabled={busy || inspection.isFetching || Boolean(item.error)} onChange={(event) => setApproved(event.target.checked)} /><span>Delete this worktree and branch, including the submodule contents and changes listed above.</span></label></>}
      </>}
    </>}
    {error && <p className="creation-error" role="alert">{error}</p>}
  </Modal>;
}
