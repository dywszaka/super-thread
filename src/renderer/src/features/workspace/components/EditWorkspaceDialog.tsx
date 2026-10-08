import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Workspace } from "@/shared/domain";
import { Field, Modal } from "./Modal";

const cleanError = (error: unknown): string => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': /, "")
  : String(error);

const WORKSPACE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Edits an existing workspace. Only the display name is writable: the worktree path, branch, and
 * tmux session were fixed at creation and stay bound to the workspace for its whole lifetime.
 */
export function EditWorkspaceDialog({ snapshot, workspace, onClose }: { snapshot: AppSnapshot; workspace?: Workspace; onClose(): void }): React.ReactNode {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const validName = trimmed.length > 0 && trimmed.length <= 80 && WORKSPACE_NAME_PATTERN.test(trimmed);
  const changed = Boolean(workspace) && trimmed !== workspace?.name;
  const workThread = snapshot.workThreads.find((item) => item.id === workspace?.workThreadId);
  const project = snapshot.projects.find((item) => item.id === workspace?.projectId);
  const device = snapshot.devices.find((item) => item.id === workspace?.deviceId);

  useEffect(() => { setName(workspace?.name ?? ""); }, [workspace?.id, workspace?.name]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!workspace || !validName || !changed) { onClose(); return; }
    setBusy(true);
    try {
      await window.desktop.renameWorkspace({ id: workspace.id, name: trimmed });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success(`Workspace renamed to ${trimmed}`);
      onClose();
    } catch (error) { toast.error(cleanError(error)); }
    finally { setBusy(false); }
  };

  return (
    <Modal
      open={Boolean(workspace)}
      title="Edit workspace"
      description="Only the name can change. The worktree path, branch, and terminal sessions stay as they are."
      busy={busy}
      submitDisabled={!validName || !changed}
      submitLabel="Save Changes"
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Name" hint="Letters, numbers, dots, dashes, and underscores only."><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus /></Field>
      <div className="form-grid two">
        <Field label="Work Thread"><input value={workThread?.name ?? ""} readOnly /></Field>
        <Field label="Project"><input value={project?.name ?? ""} readOnly /></Field>
      </div>
      <div className="form-grid two">
        <Field label="Device"><input value={device?.name ?? ""} readOnly /></Field>
        <Field label="Branch"><input value={workspace?.branch ?? ""} readOnly /></Field>
      </div>
      <Field label="Path"><input value={workspace?.path ?? ""} readOnly /></Field>
    </Modal>
  );
}
