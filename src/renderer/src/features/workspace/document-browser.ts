import type { AppSnapshot, Workspace } from "@/shared/domain";
import { visibleWorkspaces } from "./selection";

export function documentBrowserWorkspaces(snapshot: AppSnapshot, threadId: string): Workspace[] {
  return visibleWorkspaces(snapshot, { type: "work-thread", id: threadId })
    .filter((workspace) => workspace.status === "ready");
}
