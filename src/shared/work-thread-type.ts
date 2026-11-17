import type { WorkThread, WorkThreadType } from "./domain";

export const workThreadTypes = [
  { value: "work", label: "Work" },
  { value: "life", label: "Life" }
] as const;

export function workThreadType(thread: Pick<WorkThread, "type">): WorkThreadType {
  return thread.type === "life" ? "life" : "work";
}

export function threadsOfType(threads: WorkThread[], type: WorkThreadType): WorkThread[] {
  return threads.filter((thread) => workThreadType(thread) === type);
}
