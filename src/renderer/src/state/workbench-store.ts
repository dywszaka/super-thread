import { create } from "zustand";

type DialogName = "project" | "device" | "workspace" | null;

interface WorkbenchState {
  projectFilter: string | null;
  deviceFilter: string | null;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  dialog: DialogName;
  setProjectFilter(id: string | null): void;
  setDeviceFilter(id: string | null): void;
  setActiveWorkspace(id: string | null): void;
  setActiveSession(id: string | null): void;
  openDialog(name: Exclude<DialogName, null>): void;
  closeDialog(): void;
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  projectFilter: null,
  deviceFilter: null,
  activeWorkspaceId: null,
  activeSessionId: null,
  dialog: null,
  setProjectFilter: (projectFilter) => set({ projectFilter, deviceFilter: null }),
  setDeviceFilter: (deviceFilter) => set({ deviceFilter, projectFilter: null }),
  setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId, activeSessionId: null }),
  setActiveSession: (activeSessionId) => set({ activeSessionId }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null })
}));
