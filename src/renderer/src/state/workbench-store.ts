import type { WorkThreadCreation, WorkThreadCreationInput } from "@/shared/work-thread-creation";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { WorkspaceScope } from "../features/workspace/selection";
import type { ManagedSessionKind, Workspace, WorkThreadType } from "@/shared/domain";

type SidebarSection = "workThreads" | "workspaces";

type DialogName = "mergeRequest" | "deleteWorkspace" | "finishThread" | "settings" | "project" | "setupProject" | "device" | "workThread" | "workspace" | null;

const memoryStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

export interface WorkThreadCreationDraft extends WorkThreadCreationInput { step: 0 | 1 | 2; }

interface WorkbenchState {
  mergeRequestWorkspaceId: string | null;
  mergeRequestDrafts: Record<string, { title: string; description: string }>;
  openMergeRequest(workspaceId: string): void;
  setMergeRequestDraft(workspaceId: string, draft: { title: string; description: string }): void;
  workThreadType: WorkThreadType;
  switchWorkThreadType(type: WorkThreadType): void;
  revealWorkThreadType(type: WorkThreadType): void;
  workThreadDraft: WorkThreadCreationDraft | null;
  workThreadCreation: WorkThreadCreation | null;
  beginWorkThreadDraft(draft: WorkThreadCreationDraft): void;
  setWorkThreadDraft(draft: WorkThreadCreationDraft | null): void;
  setWorkThreadCreation(creation: WorkThreadCreation | null): void;
  scope: WorkspaceScope;
  projectFilter: string | null;
  workThreadFilter: string | null;
  activeWorkspaceId: string | null;
  activeSessionIds: Record<string, string>;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  workspaceDocumentCollapsed: boolean;
  workspaceDocumentWidth: number;
  setWorkspaceDocumentCollapsed(collapsed: boolean): void;
  setWorkspaceDocumentWidth(ratio: number): void;
  focusMode: boolean;
  expandedThreadIds: string[];
  collapsedSidebarSections: Record<SidebarSection, boolean>;
  sessionCreateRequests: Array<{ id: string; workspaceId: string; kind: ManagedSessionKind }>;
  dialog: DialogName;
  finishThreadId: string | null;
  deleteWorkspaceId: string | null;
  openDeleteWorkspace(id: string): void;
  openFinishWorkThread(id: string): void;
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
    mergeRequestWorkspaceId: null,
    mergeRequestDrafts: {},
    openMergeRequest: (mergeRequestWorkspaceId) => set({ dialog: "mergeRequest", mergeRequestWorkspaceId }),
    setMergeRequestDraft: (workspaceId, draft) => set((state) => ({ mergeRequestDrafts: { ...state.mergeRequestDrafts, [workspaceId]: draft } })),
    workThreadType: "work",
    switchWorkThreadType: (workThreadType) => {
      if (get().workThreadType === workThreadType) return;
      set((state) => ({
        workThreadType,
        scope: state.scope.type === "all-todos" ? state.scope : { type: "all-work-threads" },
        activeWorkspaceId: null,
        projectFilter: null,
        workThreadFilter: null,
        focusMode: false
      }));
    },
    revealWorkThreadType: (workThreadType) => set({ workThreadType }),
    workThreadDraft: null,
    workThreadCreation: null,
    beginWorkThreadDraft: (workThreadDraft) => set((state) => ({ workThreadDraft: state.workThreadDraft ?? workThreadDraft })),
    setWorkThreadDraft: (workThreadDraft) => set({ workThreadDraft }),
    setWorkThreadCreation: (workThreadCreation) => set({ workThreadCreation }),
    scope: { type: "all-workspaces" },
    projectFilter: null,
    workThreadFilter: null,
    activeWorkspaceId: null,
    activeSessionIds: {},
    sidebarCollapsed: false,
    sidebarWidth: 240,
    workspaceDocumentCollapsed: false,
    workspaceDocumentWidth: 1 / 3,
    setWorkspaceDocumentCollapsed: (workspaceDocumentCollapsed) => set({ workspaceDocumentCollapsed }),
    setWorkspaceDocumentWidth: (ratio) => set({ workspaceDocumentWidth: Number.isFinite(ratio) ? Math.min(0.65, Math.max(0.2, ratio)) : 1 / 3 }),
    focusMode: false,
    expandedThreadIds: [],
    collapsedSidebarSections: { workThreads: false, workspaces: false },
    sessionCreateRequests: [],
    setupProjectTarget: null,
    dialog: null,
    finishThreadId: null,
    deleteWorkspaceId: null,
    openDeleteWorkspace: (deleteWorkspaceId) => set({ dialog: "deleteWorkspace", deleteWorkspaceId }),
    openFinishWorkThread: (finishThreadId) => set({ dialog: "finishThread", finishThreadId }),
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
      workThreadType: state.workThreadType,
      scope: state.scope,
      projectFilter: state.projectFilter,
      workThreadFilter: state.workThreadFilter,
      activeWorkspaceId: state.activeWorkspaceId,
      activeSessionIds: state.activeSessionIds,
      sidebarCollapsed: state.sidebarCollapsed,
      sidebarWidth: state.sidebarWidth,
      workspaceDocumentCollapsed: state.workspaceDocumentCollapsed,
      workspaceDocumentWidth: state.workspaceDocumentWidth,
      collapsedSidebarSections: state.collapsedSidebarSections,
      expandedThreadIds: state.expandedThreadIds
    })
  })
);
