import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2, GitBranch, HardDrive, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Project } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { Field, Modal } from "./Modal";
import { SidebarReopenButton } from "./Sidebar";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function ProjectList({ snapshot }: { snapshot: AppSnapshot }): React.ReactNode {
  const client = useQueryClient();
  const openDialog = useWorkbenchStore((state) => state.openDialog);
  const setProjectFilter = useWorkbenchStore((state) => state.setProjectFilter);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const editing = snapshot.projects.find((project) => project.id === editingId);

  const remove = async (project: Project): Promise<void> => {
    const workspaceCount = snapshot.workspaces.filter((workspace) => workspace.projectId === project.id).length;
    if (workspaceCount > 0) return;
    if (!confirm(`Delete the project “${project.name}” from SuperThread?\n\nIts checkout records will be removed, but repository files on your devices will not be deleted.`)) return;
    setBusyId(project.id);
    try {
      await window.desktop.deleteProject(project.id);
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success(`${project.name} deleted`);
    } catch (error) { toast.error(cleanError(error)); }
    finally { setBusyId(null); }
  };

  return (
    <main className="project-page">
      <header className="project-page-header drag">
        <SidebarReopenButton />
        <div><h1>Projects</h1><p>Manage logical Git repositories and the devices where they are available.</p></div>
        <button className="button primary no-drag" onClick={() => openDialog("project")}><Plus size={14} /> Add Project</button>
      </header>
      <section className="project-page-body no-drag">
        <div className="project-summary"><span><strong>{snapshot.projects.length}</strong> projects</span><span><strong>{snapshot.checkouts.length}</strong> checkouts</span><span><strong>{snapshot.workspaces.length}</strong> workspaces</span></div>
        <div className="project-cards">
          {snapshot.projects.length === 0 && <div className="project-list-empty"><FolderGit2 size={28} /><h2>No projects yet</h2><p>Import an existing Git repository or clone one onto this Mac.</p><button className="button primary" onClick={() => openDialog("project")}><Plus size={14} /> Add Project</button></div>}
          {snapshot.projects.map((project) => {
            const checkouts = snapshot.checkouts.filter((checkout) => checkout.projectId === project.id);
            const workspaces = snapshot.workspaces.filter((workspace) => workspace.projectId === project.id);
            const checkoutDevices = checkouts.map((checkout) => snapshot.devices.find((device) => device.id === checkout.deviceId)?.name).filter(Boolean);
            const busy = busyId === project.id;
            return (
              <article className="project-card" key={project.id}>
                <div className="project-card-icon"><FolderGit2 size={19} /></div>
                <div className="project-card-content">
                  <div className="project-card-title"><strong>{project.name}</strong><span>{project.defaultBranch}</span></div>
                  <code>{project.repositoryUrl}</code>
                  <div className="project-usage"><span><HardDrive size={12} /> {checkouts.length} {checkouts.length === 1 ? "checkout" : "checkouts"}{checkoutDevices.length > 0 ? ` · ${checkoutDevices.join(", ")}` : ""}</span><span><GitBranch size={12} /> {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}</span></div>
                </div>
                <div className="project-card-actions">
                  {workspaces.length > 0 && <button className="button" disabled={busy} onClick={() => setProjectFilter(project.id)}>View workspaces</button>}
                  <button className="icon-button" disabled={busy} title="Edit project name" onClick={() => setEditingId(project.id)}><Pencil size={14} /></button>
                  <button className="icon-button danger-button" disabled={busy || workspaces.length > 0} title={workspaces.length > 0 ? "Remove every workspace before deleting this project" : "Delete project"} onClick={() => void remove(project)}><Trash2 size={14} /></button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <EditProjectDialog project={editing} onClose={() => setEditingId(null)} />
    </main>
  );
}

function EditProjectDialog({ project, onClose }: { project?: Project; onClose(): void }): React.ReactNode {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setName(project?.name ?? ""); }, [project?.id, project?.name]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!project) return;
    setBusy(true);
    try {
      await window.desktop.updateProject({ id: project.id, name });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success(`${name.trim()} updated`);
      onClose();
    } catch (error) { toast.error(cleanError(error)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={Boolean(project)} title="Edit project" description="The display name is used for future workspace paths. Existing workspace paths are unchanged." busy={busy} submitLabel="Save Changes" onClose={onClose} onSubmit={submit}>
      <Field label="Project name"><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoFocus /></Field>
      <Field label="Repository"><input value={project?.repositoryUrl ?? ""} readOnly /></Field>
    </Modal>
  );
}
