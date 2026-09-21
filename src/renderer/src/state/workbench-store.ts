import { create } from "zustand";
import type { WorkspaceScope } from "../features/workspace/selection";

type DialogName = "project" | "device" | "workThread" | "workspace" | null;

interface WorkbenchState {
  scope: WorkspaceScope;
  projectFilter: string | null;
  workThreadFilter: string | null;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  dialog: DialogName;
  showAllWorkspaces(): void;
  showAllWorkThreads(): void;
  showAllDevices(): void;
  setProjectFilter(id: string | null): void;
  setWorkThreadFilter(id: string): void;
  setActiveWorkspace(id: string | null): void;
  setActiveSession(id: string | null): void;
  openDialog(name: Exclude<DialogName, null>): void;
  closeDialog(): void;
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  scope: { type: "all-workspaces" },
  projectFilter: null,
  workThreadFilter: null,
  activeWorkspaceId: null,
  activeSessionId: null,
  dialog: null,
  showAllWorkspaces: () => set({ scope: { type: "all-workspaces" }, projectFilter: null, workThreadFilter: null }),
  showAllWorkThreads: () => set({ scope: { type: "all-work-threads" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: null, activeSessionId: null }),
  showAllDevices: () => set({ scope: { type: "all-devices" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: null, activeSessionId: null }),
  setProjectFilter: (projectFilter) => set({
    scope: projectFilter ? { type: "project", id: projectFilter } : { type: "all-workspaces" },
    projectFilter,
    workThreadFilter: null
  }),
  setWorkThreadFilter: (workThreadFilter) => set({
    scope: { type: "work-thread", id: workThreadFilter },
    projectFilter: null,
    workThreadFilter
  }),
  setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId, activeSessionId: null }),
  setActiveSession: (activeSessionId) => set({ activeSessionId }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null })
}));
