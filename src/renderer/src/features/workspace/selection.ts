import type { AppSnapshot, WorkThread, Workspace } from "@/shared/domain";

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
  return `${pad(date.getMonth() + 1)}${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    if (!activeThreadIds.has(workspace.workThreadId)) return false;
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

export function workspaceOverview(snapshot: AppSnapshot): Array<{ workspace: Workspace; terminals: number; codex: number }> {
  const counts = new Map<string, { terminals: number; codex: number }>();
  for (const session of snapshot.sessions) {
    if (session.status !== "running" || session.activityStatus !== "busy") continue;
    const count = counts.get(session.workspaceId) ?? { terminals: 0, codex: 0 };
    if (session.kind === "codex") count.codex++;
    else count.terminals++;
    counts.set(session.workspaceId, count);
  }
  return visibleWorkspaces(snapshot, { type: "all-workspaces" })
    .map((workspace) => ({ workspace, ...(counts.get(workspace.id) ?? { terminals: 0, codex: 0 }) }))
    .sort((left, right) => (right.terminals + right.codex) - (left.terminals + left.codex));
}
