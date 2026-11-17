import type { AppSnapshot, CreateWorkThreadInput, CreateWorkspaceInput } from "./domain";

export type WorkspaceConfiguration =
  | Omit<Extract<CreateWorkspaceInput, { kind: "main" }>, "workThreadId">
  | Omit<Extract<CreateWorkspaceInput, { kind: "worktree" }>, "workThreadId">;

export interface WorkThreadCreationInput extends CreateWorkThreadInput {
  operationId: string;
  workspaces: Array<{ entryId: string; configuration: WorkspaceConfiguration }>;
}

export interface WorkThreadCreation extends WorkThreadCreationInput {
  threadId?: string;
  status: "running" | "paused" | "completed";
  error?: string;
  entries: Array<{
    entryId: string;
    status: "pending" | "creating" | "succeeded" | "failed";
    workspaceId?: string;
    error?: string;
  }>;
}

/**
 * Domain checks shared by forms and the main-process coordinator.
 * A null owner represents a new thread; undefined represents the standalone group.
 */
export function workspaceConfigurationError(snapshot: AppSnapshot, input: WorkspaceConfiguration, options: { ignoreWorkspaceId?: string; workThreadId?: string | null } = {}): string | undefined {
  const project = snapshot.projects.find((item) => item.id === input.projectId);
  const device = snapshot.devices.find((item) => item.id === input.deviceId);
  const checkout = snapshot.checkouts.find((item) => item.projectId === input.projectId && item.deviceId === input.deviceId);
  if (!project || !device || !checkout) return "Choose a project already set up on the selected device.";
  if (input.kind === "worktree" && checkout.isGit === false) return "This folder requires a project-directory workspace.";
  const workspaces = snapshot.workspaces.filter((item) => item.id !== options.ignoreWorkspaceId);
  if (workspaces.some((item) => item.deviceId === input.deviceId && item.name === input.name.trim())) return `A workspace named ${input.name.trim()} already exists on ${device.name}.`;
  if (input.kind === "main") {
    const existing = workspaces.find((item) => item.projectId === input.projectId && item.deviceId === input.deviceId && item.kind === "main" && item.workThreadId === options.workThreadId);
    if (existing) {
      const owner = snapshot.workThreads.find((item) => item.id === existing.workThreadId);
      return `The project directory is already used in this group by ${existing.name}${owner ? ` in ${owner.name}` : ""}.`;
    }
  }
  return undefined;
}

/** Informational only: shared checkouts retain separate workspace/session identities. */
export function projectDirectorySharingWarning(snapshot: AppSnapshot, input: WorkspaceConfiguration, ignoreWorkspaceId?: string): string | undefined {
  if (input.kind !== "main") return undefined;
  const existing = snapshot.workspaces.filter((item) => item.id !== ignoreWorkspaceId && item.kind === "main" && item.projectId === input.projectId && item.deviceId === input.deviceId);
  if (!existing.length) return undefined;
  const users = existing.map((workspace) => {
    const owner = snapshot.workThreads.find((item) => item.id === workspace.workThreadId);
    return `“${workspace.name}” (${owner ? `Work Thread: ${owner.name}` : "Standalone"})`;
  });
  return `This project directory is shared with ${users.join(", ")}. File changes and Git branch switches affect every workspace using it. Use an isolated worktree if you need separate files and branches.`;
}

export function batchWorkspaceError(input: WorkThreadCreationInput): string | undefined {
  const names = new Set<string>();
  const mains = new Set<string>();
  for (const { configuration } of input.workspaces) {
    const nameKey = JSON.stringify([configuration.deviceId, configuration.name.trim()]);
    if (names.has(nameKey)) return `Workspace ${configuration.name.trim()} is configured twice on the same device.`;
    names.add(nameKey);
    if (configuration.kind === "main") {
      const key = JSON.stringify([configuration.projectId, configuration.deviceId]);
      if (mains.has(key)) return "A project directory can only be used once per work thread on each device.";
      mains.add(key);
    }
  }
  return undefined;
}
