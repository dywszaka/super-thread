import { randomUUID } from "node:crypto";
import type { AppSnapshot, CreateWorkThreadInput, CreateWorkspaceInput } from "../../shared/domain";
import { workThreadCreationSchema } from "../../shared/contract";
import { batchWorkspaceError, workspaceConfigurationError, type WorkThreadCreation, type WorkThreadCreationInput } from "../../shared/work-thread-creation";

interface CreationServices {
  snapshot(): AppSnapshot;
  createWorkThread(input: CreateWorkThreadInput, threadId: string): Promise<string>;
  createWorkspace(input: CreateWorkspaceInput, workspaceId: string): Promise<string>;
}

/** Lives with the app runtime, independently of any renderer or dialog. */
export class WorkThreadCreationCoordinator {
  private state: WorkThreadCreation | null = null;

  constructor(private readonly services: CreationServices, private readonly changed: (state: WorkThreadCreation | null) => void) {}

  current(): WorkThreadCreation | null { return structuredClone(this.state); }

  isCreatingThread(threadId: string): boolean {
    return this.state?.status === "running" && this.state.threadId === threadId;
  }

  isCreatingWorkspace(workspaceId: string): boolean {
    return this.state?.status === "running" && this.state.entries.some((entry) => entry.workspaceId === workspaceId);
  }

  submit(raw: WorkThreadCreationInput): WorkThreadCreation {
    const input = workThreadCreationSchema.parse(raw);
    const previous = this.state;
    if (previous && previous.operationId !== input.operationId) throw new Error("Continue or discard the current creation first.");
    if (previous?.status === "running" || previous?.status === "completed") return this.current()!;
    const snapshot = this.services.snapshot();
    const thread = snapshot.workThreads.find((item) => item.id === previous?.threadId);
    if (previous?.threadId && thread?.status !== "active") throw new Error("The work thread is missing or archived. Restore it or discard this creation.");
    if (!previous?.threadId && snapshot.workThreads.some((item) => item.name.trim().toLowerCase() === input.name.toLowerCase())) throw new Error(`A work thread named ${input.name} already exists.`);
    for (const entry of previous?.entries ?? []) {
      const existing = entry.workspaceId && snapshot.workspaces.find((item) => item.id === entry.workspaceId);
      if (entry.status === "succeeded") {
        const before = previous!.workspaces.find((item) => item.entryId === entry.entryId);
        const after = input.workspaces.find((item) => item.entryId === entry.entryId);
        if (!existing || existing.status !== "ready" || JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Successfully created workspaces must be preserved. Discard the remaining configuration to start over.");
      } else if (existing) {
        throw new Error(`Remove the leftover workspace ${existing.name} before retrying: ${existing.error ?? "cleanup did not finish"}`);
      }
    }
    const batchError = batchWorkspaceError(input);
    if (batchError) throw new Error(batchError);
    for (const item of input.workspaces) {
      const entry = previous?.entries.find((entry) => entry.entryId === item.entryId);
      const error = workspaceConfigurationError(snapshot, item.configuration, entry?.status === "succeeded" ? entry.workspaceId : undefined);
      if (error) throw new Error(`${item.configuration.name}: ${error}`);
    }
    this.state = {
      ...input,
      // Thread content is captured once; retries never overwrite an independently edited Doc.
      name: previous?.threadId ? previous.name : input.name,
      type: previous?.threadId ? previous.type : input.type,
      content: previous?.threadId ? previous.content : input.content,
      threadId: previous?.threadId,
      status: "running",
      entries: input.workspaces.map((item) => {
        const entry = previous?.entries.find((entry) => entry.entryId === item.entryId);
        return entry?.status === "succeeded" ? entry : { entryId: item.entryId, status: "pending" };
      })
    };
    this.publish();
    void this.run();
    return this.current()!;
  }

  discard(operationId: string): void {
    if (!this.state) return;
    if (this.state.operationId !== operationId) throw new Error("Creation has changed. Reopen the dialog.");
    if (this.state.status === "running") throw new Error("Wait for creation to finish before discarding configuration.");
    this.state = null;
    this.publish();
  }

  private publish(): void { this.changed(this.current()); }

  private async run(): Promise<void> {
    const state = this.state!;
    try {
      if (!state.threadId) {
        const threadId = `thread_${randomUUID().slice(0, 8)}`;
        // Reserve identity before the asynchronous write, so archive/delete cannot race it.
        state.threadId = threadId;
        try { await this.services.createWorkThread({ name: state.name, type: state.type, content: state.content }, threadId); }
        catch (error) { state.threadId = undefined; throw error; }
      }
      for (const item of state.workspaces) {
        const entry = state.entries.find((entry) => entry.entryId === item.entryId)!;
        if (entry.status === "succeeded") continue;
        entry.workspaceId = `ws_${randomUUID().slice(0, 8)}`;
        entry.status = "creating";
        this.publish();
        try {
          await this.services.createWorkspace({ ...item.configuration, workThreadId: state.threadId }, entry.workspaceId);
          const snapshot = this.services.snapshot();
          const workspace = snapshot.workspaces.find((workspace) => workspace.id === entry.workspaceId);
          if (workspace?.status !== "ready" || !snapshot.sessions.some((session) => session.workspaceId === entry.workspaceId && session.status === "running")) throw new Error("Workspace terminal initialization did not complete. Remove the leftover workspace before retrying.");
          entry.status = "succeeded";
          this.publish();
        } catch (error) {
          entry.status = "failed";
          const leftover = this.services.snapshot().workspaces.find((workspace) => workspace.id === entry.workspaceId);
          entry.error = leftover?.error ?? (error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
      state.status = "completed";
    } catch (error) {
      state.status = "paused";
      state.error = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }
}
