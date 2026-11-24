import { DeleteWorkspaceDialog } from "./DeleteWorkspaceDialog";
import { FinishWorkThreadDialog } from "./FinishWorkThreadDialog";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronUp, Folder, FolderOpen, GitBranch, HardDrive, Link, Network, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { AppSnapshot, DirectoryListing, Project, SshTunnelConfig } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { sortedWorkThreads } from "../selection";
import { Field, Modal } from "./Modal";
import { tunnelConflicts } from "@/shared/ssh-tunnels";
import { SshTunnelFields } from "./SshTunnelFields";
import { projectCodeError } from "@/shared/project-code";
import { NewWorkThreadDialog } from "./NewWorkThreadDialog";
import { configurationError, initialWorkspaceConfiguration, WorkspaceConfigurationForm } from "./WorkspaceConfigurationForm";
import { SettingsDialog } from "./SettingsDialog";
import { CodexRecordingField } from "./CodexRecordingField";

const message = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

const projectLabel = (snapshot: AppSnapshot, project: Project): string => {
  if (!snapshot.projects.some((item) => item.id !== project.id && item.name.toLowerCase() === project.name.toLowerCase())) return project.name;
  const checkout = snapshot.checkouts.find((item) => item.projectId === project.id);
  const device = snapshot.devices.find((item) => item.id === checkout?.deviceId);
  return `${project.name} · ${device?.name ?? ""} · ${checkout?.path ?? project.id}`;
};

export function DirectoryField({ value, onChange, remote, deviceId, placeholder }: { value: string; onChange(value: string): void; remote?: boolean; deviceId?: string; placeholder: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const load = async (path?: string): Promise<void> => {
    if (!remote || !deviceId) return;
    setLoading(true); setBrowseError("");
    try {
      const next = await window.desktop.browseDirectory({ deviceId, path: path || value || undefined });
      setListing(next);
      onChange(next.path);
      setOpen(true);
    } catch (error) {
      setBrowseError(message(error));
      toast.error(message(error));
    } finally { setLoading(false); }
  };
  return (
    <div className="directory-field">
      <div className="path-control">
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required />
        {remote
          ? <button type="button" className="icon-button" title="Browse remote folders" disabled={!deviceId || loading} onClick={() => void load(value)}>{loading ? <RefreshCw className="spinning" size={15} /> : <FolderOpen size={16} />}</button>
          : <button type="button" className="icon-button" title="Choose folder" onClick={async () => { const path = await window.desktop.selectDirectory(); if (path) onChange(path); }}><FolderOpen size={16} /></button>}
      </div>
      {remote && open && <div className="directory-browser">
        <div className="directory-browser-bar">
          <button type="button" className="icon-button" title="Parent folder" disabled={loading || !listing?.parentPath} onClick={() => void load(listing?.parentPath || undefined)}><ChevronUp size={15} /></button>
          <code className="selectable">{listing?.path || value || "~"}</code>
          <button type="button" className="icon-button" title="Refresh" disabled={loading} onClick={() => void load(listing?.path || value)}><RefreshCw className={loading ? "spinning" : ""} size={15} /></button>
        </div>
        {browseError && <div className="directory-error">{browseError}</div>}
        <div className="directory-list">
          {listing?.entries.map((entry) => <button type="button" key={entry.path} onClick={() => void load(entry.path)}><Folder size={14} /><span>{entry.name}</span></button>)}
          {listing && listing.entries.length === 0 && <span className="directory-empty">No child folders</span>}
        </div>
        <div className="directory-browser-footer">
          <button type="button" className="button" onClick={() => setOpen(false)}>Close</button>
          <button type="button" className="button primary" disabled={!listing} onClick={() => { if (listing) onChange(listing.path); setOpen(false); }}>Choose This Folder</button>
        </div>
      </div>}
    </div>
  );
}

export function AddDeviceDialog({ snapshot }: { snapshot: AppSnapshot }): ReactNode {
  const { dialog, closeDialog } = useWorkbenchStore();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [codexRecordingEnabled, setCodexRecordingEnabled] = useState(true);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("22");
  const [tunnels, setTunnels] = useState<SshTunnelConfig[]>([]);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const tunnelConnection = { deviceId: "new-device", transport: "ssh" as const, config: { host, user, port: Number(port), tunnels } };
  const conflicts = tunnelConflicts(tunnelConnection, snapshot.connections);
  const parsedPort = Number(port);
  const valid = Boolean(name.trim() && host.trim() && user.trim() && Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true);
    try {
      await window.desktop.addDevice({ name, host, user, port: Number(port), tunnels, codexRecordingEnabled });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success(`${name} added`); closeDialog(); setName(""); setHost(""); setTunnels([]); setCodexRecordingEnabled(true);
    } catch (error) { toast.error(message(error)); } finally { setBusy(false); }
  };
  return (
    <Modal open={dialog === "device"} title="Add remote device" description="Connect through SSH. SuperThread never stores your password." busy={busy} submitDisabled={!valid || conflicts.length > 0} submitLabel="Add Device" onClose={closeDialog} onSubmit={submit}>
      <div className="form-grid two"><Field label="Name" error={touched.name && !name.trim() ? "Enter a device name." : undefined}><input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched((value) => ({ ...value, name: true }))} placeholder="dev-cuda" /></Field><Field label="Host" error={touched.host && !host.trim() ? "Enter a host name or address." : undefined}><input value={host} onChange={(e) => setHost(e.target.value)} onBlur={() => setTouched((value) => ({ ...value, host: true }))} placeholder="dev-cuda.local" /></Field></div>
      <div className="form-grid two"><Field label="SSH user" error={touched.user && !user.trim() ? "Enter the SSH user." : undefined}><input value={user} onChange={(e) => setUser(e.target.value)} onBlur={() => setTouched((value) => ({ ...value, user: true }))} placeholder="allen" /></Field><Field label="Port" error={touched.port && !(Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) ? "Use a port from 1 to 65535." : undefined}><input type="number" value={port} onChange={(e) => setPort(e.target.value)} onBlur={() => setTouched((value) => ({ ...value, port: true }))} min="1" max="65535" /></Field></div>
      <SshTunnelFields value={tunnels} onChange={setTunnels} connection={tunnelConnection} connections={snapshot.connections} devices={snapshot.devices} />
      <CodexRecordingField enabled={codexRecordingEnabled} onChange={setCodexRecordingEnabled} disabled={busy} />
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
  const [projectName, setProjectName] = useState("");
  const [projectCode, setProjectCode] = useState("");
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const device = snapshot.devices.find((item) => item.id === deviceId);
  const codeError = projectCodeError(projectCode, snapshot.projects);
  const valid = !codeError && Boolean(device) && (mode === "import"
    ? Boolean(path.trim())
    : Boolean(url.trim() && parent.trim()));
  useEffect(() => {
    if (!snapshot.devices.some((item) => item.id === deviceId)) {
      setDeviceId(snapshot.devices[0]?.id || ""); setPath(""); setParent("");
    }
  }, [snapshot.devices, deviceId]);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true);
    try {
      const name = projectName.trim();
      if (mode === "import") await window.desktop.addProject({ mode, deviceId, path, projectCode, ...(name ? { projectName: name } : {}) });
      else await window.desktop.addProject({ mode, deviceId, repositoryUrl: url, parentDirectory: parent, projectCode, ...(name ? { projectName: name } : {}) });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success("Project added"); closeDialog(); setPath(""); setUrl(""); setParent(""); setProjectName(""); setProjectCode("");
    } catch (error) {
      toast.error(message(error));
    } finally { setBusy(false); }
  };
  return (
    <Modal open={dialog === "project"} title="Add project" description="Add a folder with or without Git. Each directory can be added once per device." busy={busy} submitDisabled={!valid} submitLabel={mode === "import" ? "Import Project" : "Clone Project"} onClose={closeDialog} onSubmit={submit}>
      <div className="segmented"><button type="button" className={mode === "import" ? "active" : ""} onClick={() => setMode("import")}><HardDrive size={15} /> Import existing</button><button type="button" className={mode === "clone" ? "active" : ""} onClick={() => setMode("clone")}><Link size={15} /> Clone URL</button></div>
      <Field label="Device"><select name="deviceId" value={deviceId} disabled={busy} onChange={(e) => { setDeviceId(e.target.value); setPath(""); setParent(""); setTouched((value) => ({ ...value, path: false, parent: false })); }} required>{snapshot.devices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      {mode === "import" ? <>
        <Field label="Project directory" hint="Git is optional. The selected folder will be used as the project directory." error={touched.path && !path.trim() ? "Choose or enter a project directory." : undefined}><div onBlur={() => setTouched((value) => ({ ...value, path: true }))}><DirectoryField key={deviceId} value={path} onChange={setPath} remote={device?.type === "remote"} deviceId={deviceId} placeholder={device?.type === "remote" ? "~" : "/Users/you/code/project"} /></div></Field>
      </> : <>
        <Field label="Git repository URL" error={touched.url && !url.trim() ? "Enter a Git repository URL." : undefined}><input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => setTouched((value) => ({ ...value, url: true }))} placeholder="git@github.com:org/repository.git" required autoCorrect="off" autoCapitalize="none" spellCheck={false} /></Field>
        <Field label="Parent directory" error={touched.parent && !parent.trim() ? "Choose or enter a parent directory." : undefined}><div onBlur={() => setTouched((value) => ({ ...value, parent: true }))}><DirectoryField key={deviceId} value={parent} onChange={setParent} remote={device?.type === "remote"} deviceId={deviceId} placeholder={device?.type === "remote" ? "~/code" : "/Users/you/code"} /></div></Field>
      </>}
      <Field label="Project code" hint="Required and unique across projects. Used as the folder name for new worktrees." error={touched.projectCode || projectCode ? codeError : undefined}><input value={projectCode} disabled={busy} onChange={(event) => setProjectCode(event.target.value)} onBlur={() => setTouched((value) => ({ ...value, projectCode: true }))} placeholder="project-code" required maxLength={80} /></Field>
      <Field label="Project name (optional)" hint="Defaults to the folder name. Names can be reused."><input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="project-name" maxLength={80} /></Field>
    </Modal>
  );
}

export function SetupProjectDialog({ snapshot }: { snapshot: AppSnapshot }): ReactNode {
  const { dialog, closeDialog, setupProjectTarget } = useWorkbenchStore();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"clone" | "import">("clone");
  const [projectId, setProjectId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [path, setPath] = useState("");
  const project = snapshot.projects.find((item) => item.id === projectId);
  const device = snapshot.devices.find((item) => item.id === deviceId);
  const setupMode = project?.repositoryUrl ? mode : "import";
  const checkout = snapshot.checkouts.find((item) => item.projectId === projectId && item.deviceId === deviceId);

  useEffect(() => {
    if (dialog !== "setupProject") return;
    setProjectId(setupProjectTarget?.projectId ?? snapshot.projects[0]?.id ?? "");
    setDeviceId(setupProjectTarget?.deviceId ?? snapshot.devices[0]?.id ?? "");
    setMode("clone");
    setPath("");
  }, [dialog, setupProjectTarget, snapshot.projects, snapshot.devices]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!project || !device || checkout) return;
    setBusy(true);
    try {
      if (setupMode === "clone") await window.desktop.setupProject({ projectId, deviceId, mode: setupMode, parentDirectory: path });
      else await window.desktop.setupProject({ projectId, deviceId, mode: setupMode, path });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success(`${project.name} is now available on ${device.name}`);
      closeDialog();
    } catch (error) { toast.error(message(error)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={dialog === "setupProject"} title="Set up project on device" description="Choose a project directory on this device. Projects with a Git remote can also be cloned." busy={busy} submitDisabled={!project || !device || Boolean(checkout) || !path.trim()} submitLabel={setupMode === "clone" ? "Clone Project" : "Import Existing"} onClose={closeDialog} onSubmit={submit}>
      <div className="form-grid two"><Field label="Project"><select value={projectId} onChange={(event) => { setProjectId(event.target.value); setPath(""); }}>{snapshot.projects.map((item) => <option key={item.id} value={item.id}>{projectLabel(snapshot, item)}</option>)}</select></Field><Field label="Device"><select value={deviceId} onChange={(event) => { setDeviceId(event.target.value); setPath(""); }}>{snapshot.devices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
      {checkout ? <div className="callout"><HardDrive size={16} /><span>{project?.name} is already available on {device?.name} at <code>{checkout.path}</code>.</span></div> : <>
        <div className="segmented"><button type="button" disabled={!project?.repositoryUrl} className={setupMode === "clone" ? "active" : ""} onClick={() => { setMode("clone"); setPath(""); }}><Link size={15} /> Clone project</button><button type="button" className={setupMode === "import" ? "active" : ""} onClick={() => { setMode("import"); setPath(""); }}><HardDrive size={15} /> Import existing</button></div>
        <Field label={setupMode === "clone" ? "Base directory" : "Project directory"} hint={setupMode === "clone" ? `The repository will be cloned into a subdirectory named after its Git URL.` : "Choose an existing directory; Git is optional."}><DirectoryField value={path} onChange={setPath} remote={device?.type === "remote"} deviceId={deviceId} placeholder={device?.type === "remote" ? "~/code" : "/Users/you/code"} /></Field>
      </>}
    </Modal>
  );
}

function NewWorkspaceDialog({ snapshot }: { snapshot: AppSnapshot }): ReactNode {
  const { closeDialog, projectFilter, workspaceDialogThreadId, activeWorkspaceId, openWorkspace, openDialog, openSetupProject } = useWorkbenchStore();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const activeWorkspace = snapshot.workspaces.find((item) => item.id === activeWorkspaceId);
  const activeWorkThreads = sortedWorkThreads(snapshot.workThreads.filter((thread) => thread.status === "active"));
  const [workThreadId, setWorkThreadId] = useState(workspaceDialogThreadId ?? "");
  const [configuration, setConfiguration] = useState(() => initialWorkspaceConfiguration(snapshot, projectFilter ?? activeWorkspace?.projectId ?? snapshot.projects[0]?.id, activeWorkspace?.deviceId));
  const workThread = activeWorkThreads.find((item) => item.id === workThreadId);
  const valid = !configurationError(snapshot, configuration, workThread?.id) && (!workspaceDialogThreadId || Boolean(workThread));
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      const id = await window.desktop.createWorkspace({ ...configuration, ...(workThread ? { workThreadId: workThread.id } : {}) });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      openWorkspace({ id, workThreadId: workThread?.id });
      toast.success(`Workspace ${configuration.name.trim()} created`);
      closeDialog();
    } catch (error) { toast.error(message(error)); } finally { setBusy(false); }
  };
  return <Modal open title="New workspace" description="Use a prepared project directory directly or create an isolated Git worktree." busy={busy} submitDisabled={!valid} submitLabel="Create Workspace" onClose={closeDialog} onSubmit={submit}>
    {snapshot.projects.length === 0 ? <div className="empty-dialog"><GitBranch size={24} /><h3>Set up a project first</h3><p>Add or set up a project directory before creating a workspace.</p><button type="button" className="button primary" onClick={() => openDialog("project")}><Plus size={14} /> Add Project</button></div> : <>
      {workspaceDialogThreadId && <Field label="Work Thread"><select disabled={busy} value={workThread?.id ?? ""} onChange={(event) => setWorkThreadId(event.target.value)} required>
        {!workThread && <option value="" disabled>Select an active work thread</option>}
        {activeWorkThreads.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></Field>}
      <WorkspaceConfigurationForm workThreadId={workThread?.id} snapshot={snapshot} value={configuration} onChange={setConfiguration} disabled={busy} preparedOnly={false} onSetup={() => openSetupProject(configuration.projectId, configuration.deviceId)} />
    </>}
  </Modal>;
}

export function WorkspaceDialogs({ snapshot }: { snapshot: AppSnapshot }): ReactNode {
  const dialog = useWorkbenchStore((state) => state.dialog);
  const deleteWorkspaceId = useWorkbenchStore((state) => state.deleteWorkspaceId);
  return <>{dialog === "deleteWorkspace" && <DeleteWorkspaceDialog key={deleteWorkspaceId} />}{dialog === "finishThread" && <FinishWorkThreadDialog snapshot={snapshot} />}<AddProjectDialog snapshot={snapshot} /><SetupProjectDialog snapshot={snapshot} /><AddDeviceDialog snapshot={snapshot} />{dialog === "workThread" && <NewWorkThreadDialog snapshot={snapshot} />}{dialog === "settings" && <SettingsDialog settings={snapshot.settings} />}{dialog === "workspace" && <NewWorkspaceDialog snapshot={snapshot} />}</>;
}
