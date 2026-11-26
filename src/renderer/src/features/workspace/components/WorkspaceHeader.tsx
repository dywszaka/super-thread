import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Code2, ExternalLink, Focus, GitPullRequest, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { SidebarReopenButton } from "./Sidebar";
import { EditWorkspaceDialog } from "./EditWorkspaceDialog";

const cleanError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function WorkspaceHeader({ snapshot, workspace }: { snapshot: AppSnapshot; workspace: Workspace }): React.ReactNode {
  const client = useQueryClient();
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [openingInVSCode, setOpeningInVSCode] = useState(false);
  const [openingTmux, setOpeningTmux] = useState(false);
  const [creatingMergeRequest, setCreatingMergeRequest] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const detailsPopover = useRef<HTMLDivElement>(null);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const { enterFocusMode, openWorkspaceDialog, scope } = useWorkbenchStore();
  const workThread = snapshot.workThreads.find((item) => item.id === workspace.workThreadId);
  const project = snapshot.projects.find((item) => item.id === workspace.projectId);
  const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
  const checkout = snapshot.checkouts.find((item) => item.id === workspace.checkoutId);
  const canCheckMergeRequest = workspace.status === "ready" && checkout?.isGit !== false && Boolean(checkout);
  const mergeRequestKey = ["workspace-merge-request", workspace.id, workspace.baseBranch];
  const mergeRequest = useQuery({
    queryKey: mergeRequestKey,
    queryFn: () => window.desktop.inspectWorkspaceMergeRequest(workspace.id),
    enabled: menu && canCheckMergeRequest && !creatingMergeRequest,
    staleTime: 0,
    retry: false
  });
  const sessions = snapshot.sessions.filter((session) => session.workspaceId === workspace.id);
  const activeCount = sessions.filter((session) => session.status === "running" && session.activityStatus === "busy").length;
  const waitingCount = sessions.filter((session) => session.activityStatus === "waiting-input").length;
  const failedRestoreCount = sessions.filter((session) => session.status === "restore-failed").length;
  const attentionCount = activeCount + waitingCount + failedRestoreCount;
  const sessionSummary = `${activeCount} running · ${waitingCount} waiting · ${failedRestoreCount} restore failed`;
  useEffect(() => {
    if (!details && !menu) return;
    const closeFloatingPanels = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (details && !detailsButton.current?.contains(target) && !detailsPopover.current?.contains(target)) setDetails(false);
      if (menu && !menuAnchor.current?.contains(target)) setMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (details) detailsButton.current?.focus();
      if (menu) menuAnchor.current?.querySelector("button")?.focus();
      setDetails(false);
      setMenu(false);
    };
    window.addEventListener("pointerdown", closeFloatingPanels);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFloatingPanels);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [details, menu]);
  const openInVSCode = async (): Promise<void> => {
    setMenu(false);
    setOpeningInVSCode(true);
    try {
      await window.desktop.openWorkspaceInVSCode(workspace.id);
    } catch (error) {
      toast.error(cleanError(error));
    } finally {
      setOpeningInVSCode(false);
    }
  };
  const openTmuxInIterm = async (): Promise<void> => {
    setMenu(false);
    setOpeningTmux(true);
    try {
      await window.desktop.openWorkspaceTmuxInIterm(workspace.id);
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success("Opened workspace tmux session in iTerm");
    } catch (error) {
      toast.error(cleanError(error));
    } finally {
      setOpeningTmux(false);
    }
  };
  const remove = (): void => {
    setMenu(false);
    useWorkbenchStore.getState().openDeleteWorkspace(workspace.id);
  };
  const createMergeRequest = async (): Promise<void> => {
    if (mergeRequest.data?.state !== "available" || mergeRequest.isFetching || creatingMergeRequest) return;
    setMenu(false);
    menuAnchor.current?.querySelector("button")?.focus();
    setCreatingMergeRequest(true);
    const notification = toast.loading("Pushing branch and creating merge request…");
    try {
      const result = await window.desktop.createWorkspaceMergeRequest({ workspaceId: workspace.id, context: mergeRequest.data.context });
      client.setQueryData(mergeRequestKey, { state: "existing", url: result.url });
      toast.success(result.created ? "Merge request created" : "Merge request already exists", {
        id: notification,
        action: { label: "Open", onClick: () => void window.desktop.openDocumentLink(result.url).catch((error) => toast.error(cleanError(error))) }
      });
    } catch (error) {
      toast.error(cleanError(error), { id: notification });
      await client.invalidateQueries({ queryKey: mergeRequestKey });
    } finally {
      setCreatingMergeRequest(false);
    }
  };
  const retryMergeRequestCheck = async (): Promise<void> => {
    const result = await mergeRequest.refetch();
    if (result.error) toast.error(cleanError(result.error));
  };
  return (
    <header className="workspace-header drag">
      <SidebarReopenButton />
      <button ref={detailsButton} className="workspace-identity no-drag" aria-label="Workspace details" aria-expanded={details} title={`${workspace.name} · ${device?.name ?? ""} · ${workspace.branch}`} onClick={() => { setDetails((open) => !open); setMenu(false); }}>
        <strong title={workspace.name}>{workspace.name}</strong>
        <ChevronDown size={14} className={details ? "rotated" : ""} />
        <span className="workspace-context"><span>·</span><span title={device?.name}>{device?.name}</span>{workspace.branch && <><span>·</span><span title={workspace.branch}>{workspace.branch}</span></>}</span>
      </button>
      {attentionCount > 0 && <div className="session-summary no-drag" role="img" aria-label={sessionSummary} title={sessionSummary}><i className={failedRestoreCount ? "failed" : waitingCount ? "waiting" : "busy"} /><span>{attentionCount}</span></div>}
      <div className="header-actions no-drag">
        <button className="icon-button" disabled={workspace.status !== "ready"} aria-label="Enter Focus mode" title="Enter Focus mode" onClick={enterFocusMode}><Focus size={14} /></button>
        <div ref={menuAnchor} className="menu-anchor"><button className="icon-button" onClick={() => { setMenu((open) => !open); setDetails(false); }} aria-label="Workspace actions" title="Workspace actions" aria-expanded={menu}><MoreHorizontal size={17} /></button>{menu && <div className="context-menu">
          <button disabled={workspace.status !== "ready" || openingInVSCode} onClick={() => void openInVSCode()}><Code2 size={14} /> {openingInVSCode ? "Opening…" : "Open in VS Code"}</button>
          <button disabled={workspace.status !== "ready" || openingTmux} onClick={() => void openTmuxInIterm()}><ExternalLink size={14} /> {openingTmux ? "Opening…" : "tmux in iTerm"}</button>
          {canCheckMergeRequest && (creatingMergeRequest
            ? <button disabled><GitPullRequest size={14} /> Pushing and creating MR…</button>
            : mergeRequest.isFetching || mergeRequest.isPending
              ? <button disabled><GitPullRequest size={14} /> Checking MR…</button>
              : mergeRequest.isError
                ? <button title={cleanError(mergeRequest.error)} onClick={() => void retryMergeRequestCheck()}><GitPullRequest size={14} /> MR unavailable · retry</button>
                : mergeRequest.data?.state === "available"
                  ? <button title={`${mergeRequest.data.context.branch} → ${mergeRequest.data.context.targetBranch} · origin`} onClick={() => void createMergeRequest()}><GitPullRequest size={14} /> Push &amp; create {mergeRequest.data.context.provider === "github" ? "PR" : "MR"}</button>
                  : null)}
          <button onClick={() => { setMenu(false); openWorkspaceDialog(scope.type === "work-thread" ? scope.id : undefined); }}><Plus size={14} /> New Workspace</button>
          <button disabled={workspace.status === "creating"} onClick={() => { setMenu(false); setEditing(true); }}><Pencil size={14} /> Rename workspace…</button>
          <div className="context-menu-separator" />
          <button className="danger" disabled={workspace.status === "creating" || creatingMergeRequest} onClick={() => void remove()}><Trash2 size={14} /> Delete workspace</button>
        </div>}</div>
      </div>
      {details && <div ref={detailsPopover} className="workspace-popover no-drag"><dl><div><dt>Work Thread</dt><dd>{workThread?.name ?? (workspace.workThreadId ? "Unknown work thread" : "Standalone")}</dd></div><div><dt>Project</dt><dd>{project?.name}</dd></div><div><dt>Device</dt><dd>{device?.name}</dd></div><div><dt>Type</dt><dd>{workspace.kind === "main" ? "Project directory" : "Worktree"}</dd></div>{workspace.branch && <><div><dt>Branch</dt><dd>{workspace.branch}</dd></div><div><dt>Base</dt><dd>{workspace.baseBranch}</dd></div></>}<div className="full"><dt>Path</dt><dd className="selectable">{workspace.path}</dd></div></dl></div>}
      {editing && <EditWorkspaceDialog snapshot={snapshot} workspace={workspace} onClose={() => setEditing(false)} />}
    </header>
  );
}
