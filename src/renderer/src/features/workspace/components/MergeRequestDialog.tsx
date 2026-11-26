import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AppSnapshot, Workspace } from "@/shared/domain";
import type { WorkspaceMergeRequest } from "@/shared/merge-request";
import { mergeRequestIsRunning } from "@/shared/merge-request";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { hostingErrorMessage, mergeRequestKey, mergeRequestOperationKey, useMergeRequestOperation } from "../merge-request-queries";
import { GitHostingConnectionFields, useConnectionEditor } from "./GitHostingConnections";
import { Field, Modal } from "./Modal";

type ConnectableInspection = Extract<WorkspaceMergeRequest, { state: "needs-connection" | "error" | "available" }>;
function ConnectStep({ workspace, inspection, pushed, onConnected, onClose }: { workspace: Workspace; inspection: ConnectableInspection; pushed: boolean; onConnected(): void; onClose(): void }): React.ReactNode {
  const preparation = inspection.state === "available" ? inspection.context : inspection.preparation;
  const editor = useConnectionEditor({ workspaceId: workspace.id, connection: inspection.connection, suggestedProvider: preparation?.remote.suggestedProvider, suggestedBaseUrl: preparation?.remote.suggestedBaseUrl, onConnected });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <Modal open title="Connect code hosting" description={`${workspace.name} · ${preparation?.remote.host ?? "origin"}`} busy={editor.busy} submitLabel={editor.savedId ? "Use connection" : "Verify & connect"} onClose={onClose} onSubmit={(event) => void editor.save(event)}>
    <h3 ref={heading} tabIndex={-1}>1. Connect · 2. Review · 3. Create</h3>
    {pushed && <p className="callout">Branch already pushed. Reconnect, then review and retry request creation; existing requests will be checked first.</p>}
    {"failure" in inspection && inspection.failure && <p className="hosting-failure" role="alert">{inspection.failure.message}</p>}
    <GitHostingConnectionFields editor={editor} />
  </Modal>;
}

export function MergeRequestDialog({ snapshot, workspace }: { snapshot: AppSnapshot; workspace: Workspace }): React.ReactNode {
  const client = useQueryClient();
  const close = useWorkbenchStore((state) => state.closeDialog);
  const draft = useWorkbenchStore((state) => state.mergeRequestDrafts[workspace.id]);
  const setDraft = useWorkbenchStore((state) => state.setMergeRequestDraft);
  const { data: savedOperation } = useMergeRequestOperation(workspace.id);
  const running = mergeRequestIsRunning(savedOperation);
  const query = useQuery({ queryKey: mergeRequestKey(workspace.id), queryFn: () => window.desktop.inspectWorkspaceMergeRequest(workspace.id), enabled: !running, staleTime: 0, retry: false });
  const [connecting, setConnecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const info = query.data;
  const prepared = info?.state === "available" ? info.context : info?.state === "needs-connection" || info?.state === "error" ? info.preparation : undefined;
  const operation = savedOperation && (running || !prepared || savedOperation.context.headCommit === prepared.headCommit && savedOperation.context.remoteUrl === prepared.remoteUrl && savedOperation.context.branch === prepared.branch) ? savedOperation : null;
  const busy = running || submitting;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!draft && (operation || prepared)) setDraft(workspace.id, { title: operation?.title ?? prepared?.defaultTitle ?? "", description: operation?.description ?? "" });
  }, [draft, operation, prepared, setDraft, workspace.id]);
  useEffect(() => { if (info?.state === "available") heading.current?.focus(); }, [info?.state]);
  const refresh = async (): Promise<void> => { await query.refetch(); };
  const connected = (): void => { setConnecting(false); void refresh(); };
  const openUrl = (url: string): void => { void window.desktop.openDocumentLink(url).catch((error) => toast.error(hostingErrorMessage(error))); };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || query.isFetching || info?.state !== "available" || !draft) return;
    setSubmitting(true);
    try {
      const result = await window.desktop.createWorkspaceMergeRequest({ workspaceId: workspace.id, context: info.context, title: draft.title, description: draft.description });
      client.setQueryData(mergeRequestKey(workspace.id), { state: "existing", url: result.url });
      toast.success(result.created ? "Merge request created" : "Merge request already exists", { action: { label: "Open", onClick: () => openUrl(result.url) } });
    } catch (error) { toast.error(hostingErrorMessage(error)); }
    finally {
      setSubmitting(false);
      await client.invalidateQueries({ queryKey: mergeRequestOperationKey(workspace.id) });
      await client.invalidateQueries({ queryKey: mergeRequestKey(workspace.id) });
    }
  };
  const repair = async (): Promise<void> => {
    setRepairing(true);
    try {
      const result = await window.desktop.createSession({ workspaceId: workspace.id, name: "Git push repair" });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      const store = useWorkbenchStore.getState();
      store.openWorkspace(workspace); store.setActiveSession(workspace.id, result.session.id); close();
      toast.info("Repair Git authentication or remote history here, then reopen Push & create MR to retry. Your draft is kept.");
    } catch (error) { toast.error(hostingErrorMessage(error)); }
    finally { setRepairing(false); }
  };
  if (!busy && info && (info.state === "needs-connection" || connecting && (info.state === "available" || info.state === "error"))) {
    return <ConnectStep key={`${info.state}-${"connection" in info ? info.connection?.id ?? "new" : "new"}`} workspace={workspace} inspection={info as ConnectableInspection} pushed={Boolean(operation?.pushed)} onConnected={connected} onClose={close} />;
  }
  const url = info?.state === "existing" ? info.url : operation?.stage === "succeeded" ? operation.result?.url : undefined;
  const failure = url ? undefined : info?.state === "error" ? info.failure : operation?.stage === "failed" ? operation.failure : undefined;
  const ready = !url && info?.state === "available";
  return <Modal open title={url ? "Merge request ready" : "Push & create merge request"} description={`${workspace.name} · ${snapshot.devices.find((item) => item.id === workspace.deviceId)?.name ?? "Workspace device"}`} onClose={close} onSubmit={(event) => void submit(event)} footer={<>
    <button type="button" className="button" onClick={close}>{busy ? "Hide" : "Close"}</button>
    {!busy && !url && <button type="button" className="button" disabled={query.isFetching} onClick={() => void refresh()}>Refresh checks</button>}
    {url && <button type="button" className="button primary" onClick={() => openUrl(url)}>Open request</button>}
    {ready && <button type="submit" className="button primary" disabled={busy || query.isFetching}>{busy ? "Working…" : `Push & create ${info.context.provider === "github" ? "PR" : "MR"}`}</button>}
  </>}>
    <h3 ref={heading} tabIndex={-1}>{url ? "Request available" : "Review before creating"}</h3>
    {query.isFetching && !busy && <p role="status">Checking workspace and platform…</p>}
    {query.isError && <p className="field-error" role="alert">{hostingErrorMessage(query.error)}</p>}
    {info?.state === "unavailable" && <p role="status">{info.reason}</p>}
    {prepared && <dl className="merge-request-context"><div><dt>Repository</dt><dd>{info?.state === "available" ? info.context.repository : prepared.remote.path}</dd></div><div><dt>Source → target</dt><dd>{prepared.branch} → {prepared.targetBranch}</dd></div><div><dt>Commit to push</dt><dd><code title={prepared.headCommit}>{prepared.headCommit.slice(0, 12)}</code></dd></div><div><dt>Git push</dt><dd>Workspace device · origin</dd></div>{info && "connection" in info && info.connection && <div><dt>Platform API</dt><dd>This Mac · {info.connection.username} · {info.connection.baseUrl}</dd></div>}</dl>}
    {ready && <>
      {info.context.hasUncommittedChanges && <p className="callout">Uncommitted files detected. Only committed content will be pushed.</p>}
      <Field label="Title (required)"><input name="mergeRequestTitle" required maxLength={255} pattern=".*\S.*" value={draft?.title ?? info.context.defaultTitle} disabled={busy} onChange={(event) => setDraft(workspace.id, { title: event.target.value, description: draft?.description ?? "" })} /></Field>
      <Field label="Description (optional)"><textarea className="merge-request-description" name="mergeRequestDescription" rows={6} maxLength={60000} value={draft?.description ?? ""} disabled={busy} onChange={(event) => setDraft(workspace.id, { title: draft?.title ?? info.context.defaultTitle, description: event.target.value })} /></Field>
      {!busy && <button type="button" className="button" onClick={() => setConnecting(true)}>Manage platform connection</button>}
    </>}
    {operation && (!url || operation.stage === "succeeded") && <div className="merge-request-progress" role="status" aria-live="polite"><strong>{({ checking: "Checking current state…", pushing: "Pushing branch on workspace device…", creating: "Creating request from this Mac…", succeeded: "Merge request available", failed: "Operation stopped" })[operation.stage]}</strong><span>{operation.pushed ? "Branch pushed." : operation.stage === "failed" ? "Push was not confirmed. Retry will recheck the platform and Git state." : "Only this branch will be pushed. No automatic commit or force push."}</span>{busy && <span>You can hide this panel and return to see its progress.</span>}</div>}
    {failure && <div className="hosting-failure" role="alert"><p>{failure.message}</p>{operation?.pushed && <p>Branch pushed, but request creation failed. Retry checks for an existing request first.</p>}{!busy && <div className="hosting-actions">{failure.code === "git" && <button type="button" className="button" disabled={repairing} onClick={() => void repair()}>{repairing ? "Opening…" : "Open repair terminal"}</button>}{info && (info.state === "available" || info.state === "error") && <button type="button" className="button" onClick={() => setConnecting(true)}>Reconnect / check permissions</button>}</div>}</div>}
    {url && <p className="selectable">{url}</p>}
  </Modal>;
}
