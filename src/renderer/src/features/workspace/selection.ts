import type { AppSnapshot, WorkThread, Workspace } from "@/shared/domain";
import { DAY_MS } from "@/shared/work-thread-age";

export { compareWorkThreads, sortedWorkThreads } from "@/shared/work-thread-order";

export function workThreadDocumentUpdate(thread: WorkThread): string {
  return thread.documentUpdatedAt ?? thread.createdAt;
}

export function workThreadsByDocumentUpdate(workThreads: readonly WorkThread[]): WorkThread[] {
  const timestamp = (thread: WorkThread): number => Date.parse(workThreadDocumentUpdate(thread)) || 0;
  return [...workThreads].sort((left, right) => timestamp(right) - timestamp(left) || left.id.localeCompare(right.id));
}

export function formatDocumentUpdate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function workThreadArchivedDuration(thread: Pick<WorkThread, "status" | "createdAt" | "archivedAt">): string | null {
  if (thread.status !== "archived" || !thread.archivedAt) return null;
  const elapsed = Date.parse(thread.archivedAt) - Date.parse(thread.createdAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const days = Math.floor(elapsed / DAY_MS);
  return days === 0 ? "<1d" : `${days}d`;
}

export interface SelectableItem {
  id: string;
}

export type WorkspaceScope =
  | { type: "all-workspaces" }
  | { type: "all-projects" }
  | { type: "all-work-threads" }
  | { type: "all-devices" }
  | { type: "all-todos" }
  | { type: "project"; id: string }
  | { type: "work-thread"; id: string };

export function visibleWorkspaces(snapshot: AppSnapshot, scope: WorkspaceScope): Workspace[] {
  if (scope.type === "all-todos" || scope.type === "all-projects" || scope.type === "all-work-threads" || scope.type === "all-devices") return [];
  const activeThreadIds = new Set(
    snapshot.workThreads.filter((thread) => thread.status === "active").map((thread) => thread.id)
  );
  return snapshot.workspaces.filter((workspace) => {
    if (workspace.workThreadId !== undefined && !activeThreadIds.has(workspace.workThreadId)) return false;
    if (scope.type === "project") return workspace.projectId === scope.id;
    if (scope.type === "work-thread") return workspace.workThreadId === scope.id;
    return true;
  });
}

export function resolveSelectionId(
  selectedId: string,
  preferredId: string | null,
  items: readonly SelectableItem[]
): string {
  if (items.some((item) => item.id === selectedId)) return selectedId;
  if (preferredId && items.some((item) => item.id === preferredId)) return preferredId;
  return items[0]?.id ?? "";
}

export function workspaceProjectName(snapshot: AppSnapshot, workspace: Workspace): string {
  return snapshot.projects.find((project) => project.id === workspace.projectId)?.name ?? "Unknown project";
}

export function workspaceOverview(snapshot: AppSnapshot): Array<{ workspace: Workspace; terminals: number; connected: number }> {
  const counts = new Map<string, { terminals: number; connected: number }>();
  for (const session of snapshot.sessions) {
    if (session.status !== "running") continue;
    const count = counts.get(session.workspaceId) ?? { terminals: 0, connected: 0 };
    if (session.activityStatus === "busy") count.terminals++;
    else if (session.activityStatus === "unknown") count.connected++;
    counts.set(session.workspaceId, count);
  }
  return visibleWorkspaces(snapshot, { type: "all-workspaces" })
    .map((workspace) => ({ workspace, ...(counts.get(workspace.id) ?? { terminals: 0, connected: 0 }) }))
    .sort((left, right) => (right.terminals + right.connected) - (left.terminals + left.connected));
}
