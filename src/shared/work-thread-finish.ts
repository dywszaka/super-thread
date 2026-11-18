import type { WorkspaceChangeInspection } from "./workspace-changes";

export interface FinishWorkThreadInput {
  id: string;
  workspaceIds: string[];
  forceWorkspaceIds: string[];
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
  error?: string;
}

export interface WorkThreadFinishInspection {
  threadId: string;
  workspaces: WorkspaceDeleteInspection[];
}
