import type { GitHostingConnection, GitHostingFailure, GitHostingProvider, GitRemote } from "./git-hosting";

export interface GitMergeRequestPreparation {
  branch: string;
  targetBranch: string;
  remoteUrl: string;
  headCommit: string;
  defaultTitle: string;
  hasUncommittedChanges: boolean;
  remote: GitRemote;
}
export interface MergeRequestContext extends GitMergeRequestPreparation {
  provider: GitHostingProvider;
  connectionId: string;
  connectionVersion: string;
  repository: string;
}

export type WorkspaceMergeRequest =
  | { state: "unavailable"; reason: string }
  | { state: "needs-connection"; preparation: GitMergeRequestPreparation; connection?: GitHostingConnection; failure?: GitHostingFailure }
  | { state: "available"; context: MergeRequestContext; connection: GitHostingConnection }
  | { state: "existing"; url: string }
  | { state: "error"; failure: GitHostingFailure; preparation?: GitMergeRequestPreparation; connection?: GitHostingConnection };

export interface CreateWorkspaceMergeRequestInput {
  workspaceId: string;
  context: MergeRequestContext;
  title: string;
  description: string;
}

export interface WorkspaceMergeRequestResult {
  url: string;
  created: boolean;
}

export interface WorkspaceMergeRequestOperation {
  workspaceId: string;
  context: MergeRequestContext;
  stage: "checking" | "pushing" | "creating" | "succeeded" | "failed";
  title: string;
  description: string;
  pushed: boolean;
  result?: WorkspaceMergeRequestResult;
  failure?: GitHostingFailure;
}

export function mergeRequestIsRunning(operation: WorkspaceMergeRequestOperation | null | undefined): boolean {
  return Boolean(operation && ["checking", "pushing", "creating"].includes(operation.stage));
}
