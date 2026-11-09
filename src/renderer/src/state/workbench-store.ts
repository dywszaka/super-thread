import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { WorkspaceScope } from "../features/workspace/selection";
import type { ManagedSessionKind, Workspace } from "@/shared/domain";

type SidebarSection = "workThreads" | "workspaces";

type DialogName = "settings" | "project" | "setupProject" | "device" | "workThread" | "workspace" | null;

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
  collapsedSidebarSections: Record<SidebarSection, boolean>;
  sessionCreateRequests: Array<{ id: string; workspaceId: string; kind: ManagedSessionKind }>;
  dialog: DialogName;
  workspaceDialogThreadId: string | null;
  setupProjectTarget: { projectId: string; deviceId: string } | null;
  showAllWorkspaces(): void;
  showAllProjects(): void;
  showAllWorkThreads(): void;
  showAllDevices(): void;
  showAllTodos(): void;
  setProjectFilter(id: string | null): void;
  setWorkThreadFilter(id: string, workspaceId?: string): void;
  openWorkspace(workspace: Pick<Workspace, "id" | "workThreadId">): void;
  setActiveWorkspace(id: string | null): void;
  setActiveSession(workspaceId: string, id: string | null): void;
  setSidebarCollapsed(collapsed: boolean): void;
  setSidebarWidth(width: number): void;
  enterFocusMode(): void;
  exitFocusMode(): void;
  toggleThreadExpanded(id: string): void;
  toggleSidebarSection(section: SidebarSection): void;
  requestSessionCreate(workspaceId: string, kind: ManagedSessionKind): void;
  acknowledgeSessionCreateRequest(id: string): void;
  openDialog(name: Exclude<DialogName, "workspace" | null>): void;
  openWorkspaceDialog(workThreadId?: string): void;
  openSetupProject(projectId: string, deviceId: string): void;
  closeDialog(): void;
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist((set, get) => ({
    scope: { type: "all-workspaces" },
    projectFilter: null,
    workThreadFilter: null,
    activeWorkspaceId: null,
    activeSessionIds: {},
    sidebarCollapsed: false,
    sidebarWidth: 240,
    focusMode: false,
    expandedThreadIds: [],
    collapsedSidebarSections: { workThreads: false, workspaces: false },
    sessionCreateRequests: [],
    setupProjectTarget: null,
    dialog: null,
    workspaceDialogThreadId: null,
    showAllWorkspaces: () => set({ scope: { type: "all-workspaces" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: null }),
    showAllProjects: () => set({ scope: { type: "all-projects" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: null }),
    showAllWorkThreads: () => set({ scope: { type: "all-work-threads" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: null }),
    showAllTodos: () => set({ scope: { type: "all-todos" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: null }),
    showAllDevices: () => set({ scope: { type: "all-devices" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: null }),
    setProjectFilter: (projectFilter) => set({
      scope: projectFilter ? { type: "project", id: projectFilter } : { type: "all-workspaces" },
      projectFilter,
      workThreadFilter: null
    }),
    setWorkThreadFilter: (workThreadFilter, workspaceId) => set((state) => ({
      scope: { type: "work-thread", id: workThreadFilter },
      activeWorkspaceId: workspaceId ?? null,
      projectFilter: null,
      workThreadFilter,
      expandedThreadIds: state.expandedThreadIds.includes(workThreadFilter) ? state.expandedThreadIds : [...state.expandedThreadIds, workThreadFilter]
    })),
    openWorkspace: (workspace) => {
      if (workspace.workThreadId) get().setWorkThreadFilter(workspace.workThreadId, workspace.id);
      else set({ scope: { type: "all-workspaces" }, projectFilter: null, workThreadFilter: null, activeWorkspaceId: workspace.id });
    },
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
    toggleSidebarSection: (section) => set(({ collapsedSidebarSections }) => ({
      collapsedSidebarSections: { ...collapsedSidebarSections, [section]: !collapsedSidebarSections[section] }
    })),
    requestSessionCreate: (workspaceId, kind) => set((state) => ({
      sessionCreateRequests: [...state.sessionCreateRequests, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, workspaceId, kind }]
    })),
    acknowledgeSessionCreateRequest: (id) => set((state) => ({
      sessionCreateRequests: state.sessionCreateRequests.filter((request) => request.id !== id)
    })),
    openDialog: (dialog) => set({ dialog }),
    openWorkspaceDialog: (workThreadId) => set({ dialog: "workspace", workspaceDialogThreadId: workThreadId ?? null }),
    openSetupProject: (projectId, deviceId) => set({ dialog: "setupProject", setupProjectTarget: { projectId, deviceId } }),
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
      collapsedSidebarSections: state.collapsedSidebarSections,
      expandedThreadIds: state.expandedThreadIds
    })
  })
);
