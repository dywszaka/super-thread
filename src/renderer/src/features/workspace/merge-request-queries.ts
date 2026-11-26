import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export const mergeRequestKey = (id: string): string[] => ["workspace-merge-request", id];
export const mergeRequestOperationKey = (id: string): string[] => ["workspace-merge-request-operation", id];
export function useMergeRequestOperation(id: string) {
  const client = useQueryClient();
  useEffect(() => window.desktop.onWorkspaceMergeRequestChanged((operation) => {
    client.setQueryData(mergeRequestOperationKey(operation.workspaceId), operation);
    if (operation.stage === "succeeded" || operation.stage === "failed") void client.invalidateQueries({ queryKey: mergeRequestKey(operation.workspaceId) });
  }), [client]);
  return useQuery({ queryKey: mergeRequestOperationKey(id), queryFn: () => window.desktop.workspaceMergeRequestOperation(id), retry: false });
}
export function useGitHostingConnections() {
  const client = useQueryClient();
  useEffect(() => window.desktop.onGitHostingChanged(() => {
    void client.invalidateQueries({ queryKey: ["git-hosting-connections"] });
    void client.invalidateQueries({ queryKey: ["workspace-merge-request"] });
  }), [client]);
  return useQuery({ queryKey: ["git-hosting-connections"], queryFn: () => window.desktop.gitHostingConnections(), retry: false });
}
export const hostingErrorMessage = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : "The operation failed. Please retry.";
