export interface MergeRequestContext {
  branch: string;
  targetBranch: string;
  remoteUrl: string;
  provider: "github" | "gitlab";
}

export type WorkspaceMergeRequest =
  | { state: "unavailable"; reason: string }
  | { state: "available"; context: MergeRequestContext }
  | { state: "existing"; url: string };

export interface CreateWorkspaceMergeRequestInput {
  workspaceId: string;
  context: MergeRequestContext;
}

export interface WorkspaceMergeRequestResult {
  url: string;
  created: boolean;
}
