import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { WorkspaceScope } from "../features/workspace/selection";

type DialogName = "project" | "device" | "workThread" | "workspace" | null;

const memoryStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

interface WorkbenchState {
  scope: WorkspaceScope;
  projectFilter: string | null;
  workThreadFilter: string | null;
  activeWorkspaceId: string | null;
  activeSessionIds: Record<string, string>;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  focusMode: boolean;
  expandedThreadIds: string[];
  dialog: DialogName;
  showAllWorkspaces(): void;
  showAllProjects(): void;
  showAllWorkThreads(): void;
  showAllDevices(): void;
  setProjectFilter(id: string | null): void;
  setWorkThreadFilter(id: string): void;
  setActiveWorkspace(id: string | null): void;
  setActiveSession(workspaceId: string, id: string | null): void;
  setSidebarCollapsed(collapsed: boolean): void;
  setSidebarWidth(width: number): void;
  enterFocusMode(): void;
  exitFocusMode(): void;
  toggleThreadExpanded(id: string): void;
  openDialog(name: Exclude<DialogName, null>): void;
  closeDialog(): void;
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist((set) => ({
    scope: { type: "all-workspaces" },
    projectFilter: null,
    workThreadFilter: null,
    activeWorkspaceId: null,
    activeSessionIds: {},
    sidebarCollapsed: false,
    sidebarWidth: 226,
    focusMode: false,
    expandedThreadIds: [],
    dialog: null,
    showAllWorkspaces: () => set({ scope: { type: "all-workspaces" }, projectFilter: null, workThreadFilter: null }),
    showAllProjects: () => set({ scope: { type: "all-projects" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: null }),
    showAllWorkThreads: () => set({ scope: { type: "all-work-threads" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: null }),
    showAllDevices: () => set({ scope: { type: "all-devices" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: null }),
    setProjectFilter: (projectFilter) => set({
      scope: projectFilter ? { type: "project", id: projectFilter } : { type: "all-workspaces" },
      projectFilter,
      workThreadFilter: null
    }),
    setWorkThreadFilter: (workThreadFilter) => set((state) => ({
      scope: { type: "work-thread", id: workThreadFilter },
      projectFilter: null,
      workThreadFilter,
      expandedThreadIds: state.expandedThreadIds.includes(workThreadFilter) ? state.expandedThreadIds : [...state.expandedThreadIds, workThreadFilter]
    })),
    setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId }),
    setActiveSession: (workspaceId, id) => set((state) => {
      const activeSessionIds = { ...state.activeSessionIds };
      if (id) activeSessionIds[workspaceId] = id;
      else delete activeSessionIds[workspaceId];
      return { activeSessionIds };
    }),
    setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
    setSidebarWidth: (sidebarWidth) => set({ sidebarWidth: Math.min(340, Math.max(184, sidebarWidth)) }),
    enterFocusMode: () => set({ focusMode: true }),
    exitFocusMode: () => set({ focusMode: false }),
    toggleThreadExpanded: (id) => set((state) => ({
      expandedThreadIds: state.expandedThreadIds.includes(id)
        ? state.expandedThreadIds.filter((item) => item !== id)
        : [...state.expandedThreadIds, id]
    })),
    openDialog: (dialog) => set({ dialog }),
    closeDialog: () => set({ dialog: null })
  }), {
    name: "superthread-workbench",
    storage: createJSONStorage(() => typeof window === "undefined" ? memoryStorage : window.localStorage),
    partialize: (state) => ({
      scope: state.scope,
      projectFilter: state.projectFilter,
      workThreadFilter: state.workThreadFilter,
      activeWorkspaceId: state.activeWorkspaceId,
      activeSessionIds: state.activeSessionIds,
      sidebarCollapsed: state.sidebarCollapsed,
      sidebarWidth: state.sidebarWidth,
      expandedThreadIds: state.expandedThreadIds
    })
  })
);
