import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, GitBranch, HardDrive, Link, Network, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { AppSnapshot } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { resolveSelectionId } from "../selection";
import { Field, Modal } from "./Modal";

const message = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

function DirectoryField({ value, onChange, remote, placeholder }: { value: string; onChange(value: string): void; remote?: boolean; placeholder: string }): ReactNode {
  return (
    <div className="path-control">
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required />
      {!remote && <button type="button" className="icon-button" title="Choose folder" onClick={async () => { const path = await window.desktop.selectDirectory(); if (path) onChange(path); }}><FolderOpen size={16} /></button>}
    </div>
  );
}

export function AddDeviceDialog(): ReactNode {
  const { dialog, closeDialog } = useWorkbenchStore();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("22");
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true);
    try {
      await window.desktop.addDevice({ name, host, user, port: Number(port) });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success(`${name} added`); closeDialog(); setName(""); setHost("");
    } catch (error) { toast.error(message(error)); } finally { setBusy(false); }
  };
  return (
    <Modal open={dialog === "device"} title="Add remote device" description="Connect through SSH. SuperThread never stores your password." busy={busy} submitLabel="Add Device" onClose={closeDialog} onSubmit={submit}>
      <div className="form-grid two"><Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="dev-cuda" required /></Field><Field label="Host"><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="dev-cuda.local" required /></Field></div>
      <div className="form-grid two"><Field label="SSH user"><input value={user} onChange={(e) => setUser(e.target.value)} placeholder="allen" required /></Field><Field label="Port"><input type="number" value={port} onChange={(e) => setPort(e.target.value)} min="1" max="65535" required /></Field></div>
      <div className="callout"><Network size={16} /><span>SSH keys and your existing <code>~/.ssh/config</code> are used for authentication.</span></div>
    </Modal>
  );
}

export function AddProjectDialog({ snapshot }: { snapshot: AppSnapshot }): ReactNode {
  const { dialog, closeDialog } = useWorkbenchStore();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"import" | "clone">("import");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [deviceId, setDeviceId] = useState(snapshot.devices[0]?.id || "");
  const [parent, setParent] = useState("");
  const device = snapshot.devices.find((item) => item.id === deviceId);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true);
    try {
      if (mode === "import") await window.desktop.addProject({ mode, path });
      else await window.desktop.addProject({ mode, repositoryUrl: url, deviceId, parentDirectory: parent });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success("Project added"); closeDialog(); setPath(""); setUrl("");
    } catch (error) { toast.error(message(error)); } finally { setBusy(false); }
  };
  return (
    <Modal open={dialog === "project"} title="Add project" description="A project is identified by its canonical Git remote, not its local path." busy={busy} submitLabel={mode === "import" ? "Import Project" : "Clone Project"} onClose={closeDialog} onSubmit={submit}>
      <div className="segmented"><button type="button" className={mode === "import" ? "active" : ""} onClick={() => setMode("import")}><HardDrive size={15} /> Import local</button><button type="button" className={mode === "clone" ? "active" : ""} onClick={() => setMode("clone")}><Link size={15} /> Clone URL</button></div>
      {mode === "import" ? <Field label="Repository directory" hint="The origin remote and current default branch will be detected."><DirectoryField value={path} onChange={setPath} placeholder="/Users/you/code/project" /></Field> : <>
        <Field label="Git repository URL"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@github.com:org/repository.git" required /></Field>
        <Field label="Device"><select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} required>{snapshot.devices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="Parent directory"><DirectoryField value={parent} onChange={setParent} remote={device?.type === "remote"} placeholder={device?.type === "remote" ? "/data/allen" : "/Users/you/code"} /></Field>
      </>}
    </Modal>
  );
}

export function NewWorkspaceDialog({ snapshot }: { snapshot: AppSnapshot }): ReactNode {
  const { dialog, closeDialog, projectFilter, deviceFilter, setActiveWorkspace } = useWorkbenchStore();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState(projectFilter || snapshot.projects[0]?.id || "");
  const [deviceId, setDeviceId] = useState(deviceFilter || snapshot.devices[0]?.id || "");
  const [name, setName] = useState("");
  const resolvedProjectId = resolveSelectionId(projectId, projectFilter, snapshot.projects);
  const resolvedDeviceId = resolveSelectionId(deviceId, deviceFilter, snapshot.devices);
  const project = snapshot.projects.find((item) => item.id === resolvedProjectId);
  const device = snapshot.devices.find((item) => item.id === resolvedDeviceId);
  const [baseBranch, setBaseBranch] = useState(project?.defaultBranch || "main");
  const [setupMode, setSetupMode] = useState<"import" | "clone">("clone");
  const [setupPath, setSetupPath] = useState("");
  const checkout = useMemo(() => snapshot.checkouts.find((item) => item.projectId === resolvedProjectId && item.deviceId === resolvedDeviceId), [snapshot, resolvedProjectId, resolvedDeviceId]);

  useEffect(() => {
    setBaseBranch(project?.defaultBranch || "main");
  }, [resolvedProjectId]);

  const updateProject = (value: string): void => {
    setProjectId(value);
    setBaseBranch(snapshot.projects.find((item) => item.id === value)?.defaultBranch || "main");
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true);
    try {
      if (!checkout) {
        await window.desktop.setupProject({ projectId: resolvedProjectId, deviceId: resolvedDeviceId, mode: setupMode, ...(setupMode === "import" ? { path: setupPath } : { parentDirectory: setupPath }) });
        await client.invalidateQueries({ queryKey: ["snapshot"] });
        toast.success(`${project?.name} is now available on ${device?.name}`);
        return;
      }
      await window.desktop.createWorkspace({ projectId: resolvedProjectId, deviceId: resolvedDeviceId, name, baseBranch });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      const fresh = await window.desktop.snapshot();
      const created = fresh.workspaces.find((item) => item.name === name && item.deviceId === resolvedDeviceId);
      if (created) setActiveWorkspace(created.id);
      toast.success(`Workspace ${name} created`); closeDialog(); setName("");
    } catch (error) { toast.error(message(error)); } finally { setBusy(false); }
  };
  const noProjects = snapshot.projects.length === 0;
  return (
    <Modal open={dialog === "workspace"} title="New workspace" description="Create an isolated Git worktree on a device." busy={busy} submitLabel={!checkout ? (setupMode === "clone" ? "Clone Project" : "Import Existing") : "Create Workspace"} onClose={closeDialog} onSubmit={submit}>
      {noProjects ? <div className="empty-dialog"><GitBranch size={24} /><h3>Add a project first</h3><p>Import a repository before creating a workspace.</p><button type="button" className="button primary" onClick={() => useWorkbenchStore.getState().openDialog("project")}><Plus size={14} /> Add Project</button></div> : <>
        <div className="form-grid two"><Field label="Project"><select value={resolvedProjectId} onChange={(e) => updateProject(e.target.value)}>{snapshot.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Device"><select value={resolvedDeviceId} onChange={(e) => setDeviceId(e.target.value)}>{snapshot.devices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
        {!checkout ? <div className="setup-panel"><div className="setup-title"><Network size={17} /><div><strong>{project?.name} isn’t available on {device?.name}</strong><span>Set up a base checkout before creating a workspace.</span></div></div><div className="segmented"><button type="button" className={setupMode === "clone" ? "active" : ""} onClick={() => setSetupMode("clone")}>Clone project</button><button type="button" className={setupMode === "import" ? "active" : ""} onClick={() => setSetupMode("import")}>Import existing</button></div><Field label={setupMode === "clone" ? "Parent directory" : "Repository directory"}><DirectoryField value={setupPath} onChange={setSetupPath} remote={device?.type === "remote"} placeholder={device?.type === "remote" ? "/data/allen" : "/Users/you/code"} /></Field></div> : <><Field label="Name" hint={`Creates branch work/${name || "workspace-name"}`}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="nvfp4-kernel" pattern="[a-zA-Z0-9._-]+" required /></Field><Field label="Base branch"><input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" required /></Field></>}
      </>}
    </Modal>
  );
}

export function WorkspaceDialogs({ snapshot }: { snapshot: AppSnapshot }): ReactNode {
  return <><AddProjectDialog snapshot={snapshot} /><AddDeviceDialog /><NewWorkspaceDialog snapshot={snapshot} /></>;
}
