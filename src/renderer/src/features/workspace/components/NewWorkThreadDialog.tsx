import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { AppSnapshot } from "@/shared/domain";
import { MAX_WORK_THREAD_DOCUMENT_LENGTH, workThreadCreationSchema } from "@/shared/contract";
import { batchWorkspaceError } from "@/shared/work-thread-creation";
import { useWorkbenchStore, type WorkThreadCreationDraft } from "../../../state/workbench-store";
import { Field, Modal } from "./Modal";
import { configurationError, initialWorkspaceConfiguration, WorkspaceConfigurationForm } from "./WorkspaceConfigurationForm";

const errorMessage = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function NewWorkThreadDialog({ snapshot }: { snapshot: AppSnapshot }): ReactNode {
  const { workThreadDraft: draft, workThreadCreation: creation, setWorkThreadDraft, beginWorkThreadDraft, closeDialog, showAllProjects } = useWorkbenchStore();
  const steps = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const body = steps.current?.parentElement;
    body?.scrollTo({ top: 0 });
    (body?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), textarea:not(:disabled)") ?? steps.current)?.focus();
  }, [draft?.step]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    beginWorkThreadDraft({ operationId: crypto.randomUUID(), name: "", content: snapshot.settings.workThreadTemplate, workspaces: [{ entryId: crypto.randomUUID(), configuration: initialWorkspaceConfiguration(snapshot) }], step: 0 });
  }, []);
  if (!draft) return null;
  const running = creation?.status === "running" || submitting;
  const locked = Boolean(creation?.threadId);
  const update = (next: Partial<WorkThreadCreationDraft>): void => { setError(""); setWorkThreadDraft({ ...draft, ...next }); };
  const entryState = (entryId: string) => creation?.entries.find((item) => item.entryId === entryId);
  const leftover = creation?.entries.find((item) => item.status === "failed" && snapshot.workspaces.some((workspace) => workspace.id === item.workspaceId));
  const nameError = !draft.name.trim() ? "Enter a work thread name." : !locked && snapshot.workThreads.some((item) => item.name.toLowerCase() === draft.name.trim().toLowerCase()) ? "A work thread with this name already exists." : undefined;
  const workspaceError = draft.workspaces.length === 0 ? "Add at least one workspace." : draft.workspaces.map((item) => entryState(item.entryId)?.status === "succeeded" ? undefined : configurationError(snapshot, item.configuration)).find(Boolean) ?? batchWorkspaceError(draft);
  const next = (): void => {
    const issue = draft.step === 0 ? nameError : workspaceError;
    if (issue) { setError(issue); return; }
    update({ step: draft.step === 0 ? 1 : 2 });
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (running) return;
    if (draft.step !== 2) { next(); return; }
    const parsed = workThreadCreationSchema.safeParse({ operationId: draft.operationId, name: draft.name, content: draft.content, workspaces: draft.workspaces });
    const issue = nameError ?? workspaceError;
    if (issue || !parsed.success) { setError(issue ?? "Check the workspace configuration before creating."); return; }
    setSubmitting(true); setError("");
    try { await window.desktop.submitWorkThreadCreation(parsed.data); }
    catch (error) { setError(errorMessage(error)); toast.error(errorMessage(error)); }
    finally { setSubmitting(false); }
  };
  const discard = async (): Promise<void> => {
    if (running) return;
    try {
      if (creation) await window.desktop.discardWorkThreadCreation(draft.operationId);
      setWorkThreadDraft(null); closeDialog();
    } catch (error) { toast.error(errorMessage(error)); }
  };
  return <Modal open title="New work thread" description={running ? "Creation continues when you close this dialog." : "Define the work, configure workspaces, then create them together."} onClose={closeDialog} onSubmit={submit} footer={<>
    <button type="button" className="button" disabled={running} onClick={() => void discard()}>{creation ? "Discard remaining" : "Discard draft"}</button>
    <button type="button" className="button" onClick={closeDialog}>{running ? "Hide" : "Close"}</button>
    {draft.step > 0 && <button type="button" className="button" disabled={running} onClick={() => update({ step: draft.step === 2 ? 1 : 0 })}>Back</button>}
    <button className="button primary" disabled={running || Boolean(leftover)}>{running ? "Creating…" : draft.step < 2 ? "Next" : creation ? "Continue creation" : "Create Work Thread"}</button>
  </>}>
    <ol ref={steps} tabIndex={-1} className="creation-steps" aria-label="Creation steps">{["Work Thread", "Workspaces", "Confirm"].map((label, index) => <li key={label} aria-current={draft.step === index ? "step" : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    {draft.step === 0 && <>
      <Field label="Name" error={error && nameError ? nameError : undefined} hint={locked ? "This work thread has already been saved." : undefined}><input value={draft.name} disabled={running || locked} onChange={(event) => update({ name: event.target.value })} maxLength={80} placeholder="Improve terminal workflow" aria-invalid={Boolean(error && nameError)} autoFocus /></Field>
      <Field label="Content" hint={locked ? "Edit the saved content in the work thread’s Doc." : "Describe the goal, scope, and completion criteria in Markdown."}><textarea className="markdown-input" value={draft.content ?? ""} disabled={running || locked} onChange={(event) => update({ content: event.target.value })} maxLength={MAX_WORK_THREAD_DOCUMENT_LENGTH} rows={10} /></Field>
    </>}
    {draft.step === 1 && <>
      {snapshot.checkouts.length === 0 && <div className="callout"><span>Add or set up a project first. Your draft will be kept.</span><button type="button" className="button" onClick={() => { closeDialog(); showAllProjects(); }}>All projects</button></div>}
      {draft.workspaces.map((item, index) => {
        const status = entryState(item.entryId);
        const succeeded = status?.status === "succeeded";
        const residual = item.entryId === leftover?.entryId;
        return <section className="creation-workspace" key={item.entryId} aria-label={`Workspace ${index + 1}`}>
          <div className="creation-workspace-heading"><strong>Workspace {index + 1}{succeeded ? " · Created" : ""}</strong><button type="button" className="icon-button" aria-label={`Remove workspace ${index + 1}`} disabled={running || succeeded || residual} onClick={() => update({ workspaces: draft.workspaces.filter((entry) => entry.entryId !== item.entryId) })}><Trash2 size={15} /></button></div>
          <WorkspaceConfigurationForm snapshot={snapshot} value={item.configuration} disabled={running || succeeded || residual} onChange={(configuration) => update({ workspaces: draft.workspaces.map((entry) => entry.entryId === item.entryId ? { ...entry, configuration } : entry) })} />
        </section>;
      })}
      <button type="button" className="button" disabled={running || draft.workspaces.length >= 100 || snapshot.checkouts.length === 0} onClick={() => update({ workspaces: [...draft.workspaces, { entryId: crypto.randomUUID(), configuration: initialWorkspaceConfiguration(snapshot) }] })}><Plus size={14} /> Add Workspace</button>
    </>}
    {draft.step === 2 && <>
      <strong className="creation-thread-name">{draft.name}</strong>
      <details className="creation-definition"><summary>Work Thread content</summary><pre>{draft.content || "Empty document"}</pre></details>
      <p className="creation-note">Each workspace includes a default Terminal. All workspaces must finish before this creation is complete.</p>
      <div className="creation-results" aria-live="polite">{draft.workspaces.map((item) => {
        const { configuration } = item;
        const status = entryState(item.entryId);
        const project = snapshot.projects.find((project) => project.id === configuration.projectId);
        const device = snapshot.devices.find((device) => device.id === configuration.deviceId);
        return <section className="creation-workspace" key={item.entryId}>
          <div className="creation-workspace-heading"><strong>{configuration.name}</strong><span>{({ pending: "Waiting", creating: "Creating…", succeeded: "Created", failed: "Failed" } as const)[status?.status ?? "pending"]}</span></div>
          <p>{project?.name} · {device?.name}</p>
          <p>{configuration.kind === "main" ? "Project directory" : `Isolated worktree · ${configuration.baseBranch} → work/${configuration.name}`}</p>
          {configuration.kind === "worktree" && configuration.linkPaths?.length ? <p>Linked files/folders: {configuration.linkPaths.join(", ")}</p> : null}
          {status?.error && <p className="field-error">{status.error}</p>}
        </section>;
      })}</div>
    </>}
    {(error || creation?.status === "paused" || leftover) && <div className="creation-error" role="alert">{error || (leftover ? "Cleanup failed. Open the leftover workspace from the sidebar and delete it before retrying. Successfully created workspaces are preserved." : creation?.error)}{creation?.status === "paused" && !leftover && <p>Go back to correct failed or waiting workspaces, then continue. Created workspaces are preserved.</p>}</div>}
  </Modal>;
}
