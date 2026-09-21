import type { AppSnapshot, Workspace } from "@/shared/domain";

export interface SelectableItem {
  id: string;
}

export type WorkspaceScope =
  | { type: "all-workspaces" }
  | { type: "all-work-threads" }
  | { type: "project"; id: string }
  | { type: "work-thread"; id: string };

export function visibleWorkspaces(snapshot: AppSnapshot, scope: WorkspaceScope): Workspace[] {
  if (scope.type === "all-work-threads") return [];
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
