import type { WorkThread } from "./domain";

export function compareWorkThreads(left: WorkThread, right: WorkThread): number {
  return Number(right.pinned) - Number(left.pinned)
    || (left.sidebarOrder ?? Number.MAX_SAFE_INTEGER) - (right.sidebarOrder ?? Number.MAX_SAFE_INTEGER)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

export function sortedWorkThreads(workThreads: readonly WorkThread[]): WorkThread[] {
  return [...workThreads].sort(compareWorkThreads);
}
