import { Folder, GitBranch, HardDrive } from "lucide-react";
import type { ReactNode } from "react";
import type { AppSnapshot } from "@/shared/domain";
import { createWorkspaceSchema } from "@/shared/contract";
import { workspaceConfigurationError, type WorkspaceConfiguration } from "@/shared/work-thread-creation";
import { Field } from "./Modal";
import { WorkspaceLinks } from "./WorkspaceLinks";

export function initialWorkspaceConfiguration(snapshot: AppSnapshot, projectId?: string, deviceId?: string): WorkspaceConfiguration {
  const checkout = snapshot.checkouts.find((item) => item.projectId === projectId && item.deviceId === deviceId)
    ?? snapshot.checkouts.find((item) => item.projectId === projectId) ?? (!projectId ? snapshot.checkouts[0] : undefined);
  const project = snapshot.projects.find((item) => item.id === (checkout?.projectId ?? projectId));
  const common = { projectId: checkout?.projectId ?? projectId ?? "", deviceId: checkout?.deviceId ?? deviceId ?? snapshot.devices[0]?.id ?? "", name: "" };
  return checkout?.isGit === false ? { ...common, kind: "main" } : { ...common, kind: "worktree", baseBranch: checkout?.defaultBranch ?? project?.defaultBranch ?? "main" };
}

export function configurationError(snapshot: AppSnapshot, configuration: WorkspaceConfiguration): string | undefined {
  const parsed = createWorkspaceSchema.safeParse(configuration);
  if (!parsed.success) return "Enter a valid name (letters, numbers, dots, dashes, underscores) and base branch.";
  return workspaceConfigurationError(snapshot, parsed.data);
}

export function WorkspaceConfigurationForm({ snapshot, value, onChange, disabled = false, preparedOnly = true, onSetup }: {
  snapshot: AppSnapshot; value: WorkspaceConfiguration; onChange(value: WorkspaceConfiguration): void; disabled?: boolean; preparedOnly?: boolean; onSetup?(): void;
}): ReactNode {
  const checkout = snapshot.checkouts.find((item) => item.projectId === value.projectId && item.deviceId === value.deviceId);
  const project = snapshot.projects.find((item) => item.id === value.projectId);
  const projects = snapshot.projects.filter((item) => !preparedOnly || snapshot.checkouts.some((checkout) => checkout.projectId === item.id));
  const devices = snapshot.devices.filter((item) => !preparedOnly || snapshot.checkouts.some((checkout) => checkout.projectId === value.projectId && checkout.deviceId === item.id));
  const changeCheckout = (projectId: string, deviceId?: string): void => {
    const next = initialWorkspaceConfiguration(snapshot, projectId, deviceId);
    if (!preparedOnly && deviceId) next.deviceId = deviceId;
    onChange({ ...next, name: value.name });
  };
  const changeKind = (kind: "main" | "worktree"): void => {
    const common = { projectId: value.projectId, deviceId: value.deviceId, name: value.name };
    onChange(kind === "main" ? { ...common, kind } : { ...common, kind, baseBranch: checkout?.defaultBranch ?? project?.defaultBranch ?? "main", linkPaths: [] });
  };
  const error = value.name && !disabled ? configurationError(snapshot, value) : undefined;
  return <fieldset className="workspace-configuration" disabled={disabled}>
    <div className="form-grid two">
      <Field label="Project"><select value={value.projectId} onChange={(event) => changeCheckout(event.target.value)}>
        {!projects.some((item) => item.id === value.projectId) && <option value={value.projectId}>Select a prepared project</option>}
        {projects.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}
      </select></Field>
      <Field label="Device"><select value={value.deviceId} onChange={(event) => changeCheckout(value.projectId, event.target.value)}>
        {!devices.some((item) => item.id === value.deviceId) && <option value={value.deviceId}>Select a prepared device</option>}
        {devices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></Field>
    </div>
    {!checkout ? <div className="callout"><span>Set up this project on the selected device before creating a workspace.</span>{onSetup && <button type="button" className="button" onClick={onSetup}>Set Up Project</button>}</div> : <>
      <div className="field"><span>Workspace type</span><div className="segmented" role="group" aria-label="Workspace type">
        <button type="button" disabled={disabled || checkout.isGit === false} aria-pressed={value.kind === "worktree"} className={value.kind === "worktree" ? "active" : ""} onClick={() => changeKind("worktree")}><GitBranch size={15} /> Isolated worktree</button>
        <button type="button" disabled={disabled} aria-pressed={value.kind === "main"} className={value.kind === "main" ? "active" : ""} onClick={() => changeKind("main")}><HardDrive size={15} /> Project directory</button>
      </div></div>
      {checkout.isGit === false && <div className="callout"><Folder size={16} /><span>This folder uses its project directory directly.</span></div>}
      <Field label="Workspace name" hint={value.kind === "main" ? `Uses ${checkout.path} directly` : `Creates branch work/${value.name || "workspace-name"}`} error={error}>
        <input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} maxLength={80} placeholder="workspace-name" aria-invalid={Boolean(error)} />
      </Field>
      {value.kind === "worktree" && <>
        <Field label="Base branch"><input value={value.baseBranch} onChange={(event) => onChange({ ...value, baseBranch: event.target.value })} maxLength={255} placeholder="main" /></Field>
        <WorkspaceLinks key={checkout.id} projectId={value.projectId} deviceId={value.deviceId} checkoutPath={checkout.path} selectedPaths={value.linkPaths ?? []} onChange={(linkPaths) => onChange({ ...value, linkPaths })} busy={disabled} />
      </>}
    </>}
  </fieldset>;
}
