import type { WorkThread, Workspace } from "@/shared/domain";
import { workThreadDocumentUpdate } from "./selection";

export type WorkThreadTimeUnit = "all" | "weeks" | "months";

export function workThreadTimeCutoff(unit: WorkThreadTimeUnit, count: number, now: number): number | null {
  if (unit === "all") return null;
  if (unit === "weeks") return now - count * 7 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(now);
  const day = cutoff.getDate();
  // Clamp month ends (March 31 → February 28), retaining the local time of day.
  cutoff.setDate(1);
  cutoff.setMonth(cutoff.getMonth() - count);
  const lastDay = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
  cutoff.setDate(Math.min(day, lastDay));
  return cutoff.getTime();
}

export function filterWorkThreads(
  threads: readonly WorkThread[], workspaces: readonly Workspace[], projectId: string, cutoff: number | null
): WorkThread[] {
  const projectThreads = new Set(workspaces.filter((workspace) => workspace.projectId === projectId).map((workspace) => workspace.workThreadId));
  return threads.filter((thread) => {
    if (projectId && !projectThreads.has(thread.id) && !thread.projectIds?.includes(projectId)) return false;
    return cutoff === null || Date.parse(workThreadDocumentUpdate(thread)) >= cutoff;
  });
}
