import type { WorkspaceChangeInspection } from "./workspace-changes";

export type WorkThreadFinishOutcome = "completed" | "cancelled";
export const MAX_WORK_THREAD_FINISH_NOTE_LENGTH = 5000;

export interface WorkThreadCompletion {
  outcome: WorkThreadFinishOutcome;
  note: string;
  finishedAt: string;
}

export interface FinishWorkThreadInput {
  id: string;
  workspaceIds: string[];
  forceWorkspaceIds: string[];
  outcome?: WorkThreadFinishOutcome;
  note?: string;
}

export interface WorkspaceDeleteInspection {
  workspaceId: string;
  name: string;
  projectName: string;
  deviceName: string;
  path: string;
  branch: string;
  keepsDirectory: boolean;
  runningSessionCount: number;
  risks: string[];
  checkedAt?: string;
  changes?: WorkspaceChangeInspection;
  recovery?: "directory" | "missing";
  error?: string;
}

export interface WorkThreadFinishInspection {
  threadId: string;
  workspaces: WorkspaceDeleteInspection[];
}
