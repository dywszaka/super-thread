import type { AppSettings, WorkThread } from "./domain";

export const DAY_MS = 24 * 60 * 60 * 1000;
export interface WorkThreadAge {
  days: number;
  level: "normal" | "reminder" | "strong";
}

export function workThreadAge(thread: Pick<WorkThread, "createdAt" | "status">, settings: AppSettings, now: number): WorkThreadAge | null {
  const created = Date.parse(thread.createdAt);
  if (thread.status !== "active" || !Number.isFinite(created) || !Number.isFinite(now)) return null;
  const elapsed = Math.max(0, now - created);
  return {
    days: Math.floor(elapsed / DAY_MS),
    level: elapsed >= settings.workThreadStrongReminderDays * DAY_MS ? "strong"
      : elapsed >= settings.workThreadReminderDays * DAY_MS ? "reminder" : "normal"
  };
}
