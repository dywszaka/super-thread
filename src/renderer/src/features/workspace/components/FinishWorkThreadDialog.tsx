import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { AppSnapshot } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { Modal } from "./Modal";
import { WorkspaceChangeDetails } from "./WorkspaceChangeDetails";

const message = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function FinishWorkThreadDialog({ snapshot }: { snapshot: AppSnapshot }): ReactNode {
  const { finishThreadId, closeDialog } = useWorkbenchStore();
  const thread = snapshot.workThreads.find((item) => item.id === finishThreadId);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [approved, setApproved] = useState<string[]>([]);
  const inspection = useQuery({ queryKey: ["finish-work-thread", finishThreadId], queryFn: () => window.desktop.inspectWorkThreadFinish(finishThreadId!), enabled: Boolean(thread), retry: false, refetchOnWindowFocus: false, refetchOnMount: "always" });
  const workspaces = inspection.data?.workspaces ?? [];
  const valid = Boolean(thread?.status === "active" && inspection.data && !inspection.isFetching && !inspection.error && workspaces.every((item) => !item.error && (item.risks.length === 0 || approved.includes(item.workspaceId))));
  const refresh = async (): Promise<void> => {
    setApproved([]);
    await inspection.refetch();
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !valid || !finishThreadId) return;
    setBusy(true); setError("");
    try {
      await window.desktop.finishWorkThread({ id: finishThreadId, workspaceIds: workspaces.map((item) => item.workspaceId), forceWorkspaceIds: approved });
      for (const workspace of workspaces) useWorkbenchStore.getState().setActiveSession(workspace.workspaceId, null);
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      const state = useWorkbenchStore.getState();
      if (state.scope.type === "work-thread" && state.scope.id === finishThreadId) state.showAllWorkThreads();
      toast.success(`${thread?.name ?? "Work thread"} finished and archived`);
      closeDialog();
    } catch (error) {
      setError(message(error));
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      await refresh();
    } finally { setBusy(false); }
  };
  return <Modal open title="Finish work thread" description={`Delete all workspaces in “${thread?.name ?? "this work thread"}”, then archive it. Its document and TODOs are kept.`} busy={busy} onClose={closeDialog} onSubmit={submit} footer={<>
    <button type="button" className="button" disabled={busy} onClick={closeDialog}>Cancel</button>
    <button type="button" className="button" disabled={busy || inspection.isFetching || !thread} onClick={() => void refresh()}>Refresh checks</button>
    <button className="button primary" disabled={busy || !valid}>{busy ? "Finishing…" : "Finish Work Thread"}</button>
  </>}>
    <div className="callout"><span>All workspace terminals will stop and their tabs will be removed. Worktrees and their branches will be deleted. Project directories are kept. Deleted worktrees cannot be restored by restoring the work thread.</span></div>
    {!thread && <p className="field-error" role="alert">This work thread no longer exists.</p>}
    {inspection.isFetching && <p role="status">Checking workspaces…</p>}
    {inspection.error && <p className="field-error" role="alert">{message(inspection.error)}</p>}
    {inspection.data && workspaces.length === 0 && <p>No workspaces remain. Finish will archive this work thread.</p>}
    {workspaces.map((item) => <section className="creation-workspace" key={item.workspaceId}>
      <div className="creation-workspace-heading"><strong>{item.name}</strong><span>{item.keepsDirectory ? "Keep directory" : "Delete worktree"}</span></div>
      <p>{item.projectName} · {item.deviceName}</p>
      <p className="selectable">{item.path || "No working directory"}</p>
      {!item.keepsDirectory && <p>Delete branch: {item.branch}</p>}
      {item.runningSessionCount > 0 && <p>{item.runningSessionCount} running terminal session(s) will stop.</p>}
      <WorkspaceChangeDetails inspection={item} busy={busy} />
      {item.error && <p className="field-error" role="alert">Checks failed: {item.error}</p>}
      {item.risks.length > 0 && <>
        <ul className="finish-workspace-risks">{item.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
        <label className="finish-force-confirmation"><input type="checkbox" checked={approved.includes(item.workspaceId)} disabled={busy || inspection.isFetching || Boolean(item.error)} onChange={(event) => setApproved((items) => event.target.checked ? [...items, item.workspaceId] : items.filter((id) => id !== item.workspaceId))} /><span>Force delete this worktree and branch, discarding these changes and commits.</span></label>
      </>}
    </section>)}
    {error && <p className="creation-error" role="alert">{error}</p>}
  </Modal>;
}
