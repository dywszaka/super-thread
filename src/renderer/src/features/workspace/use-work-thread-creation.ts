import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { WorkThreadCreation } from "@/shared/work-thread-creation";
import { workThreadType } from "@/shared/work-thread-type";
import { useWorkbenchStore } from "../../state/workbench-store";

export function useWorkThreadCreationLifecycle(): void {
  const client = useQueryClient();
  useEffect(() => {
    let disposed = false;
    let events = 0;
    const notified = new Set<string>();
    const receive = (creation: WorkThreadCreation | null): void => {
      if (disposed) return;
      const store = useWorkbenchStore.getState();
      store.setWorkThreadCreation(creation);
      if (!creation) return;
      if (creation.status === "paused" && (store.workThreadCreation?.operationId !== creation.operationId || store.workThreadCreation.status !== "paused")) toast.error(`${creation.name}: ${creation.error ?? "Workspace creation paused"}`);
      if (!store.workThreadDraft) store.setWorkThreadDraft({ operationId: creation.operationId, name: creation.name, type: creation.type, content: creation.content, workspaces: creation.workspaces, step: 2 });
      if (creation.status !== "completed" || notified.has(creation.operationId)) return;
      notified.add(creation.operationId);
      void client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success(`${creation.name} and all workspaces created`);
      if (store.dialog === "workThread") {
        store.revealWorkThreadType(workThreadType(creation));
        if (creation.threadId) store.setWorkThreadFilter(creation.threadId);
        store.closeDialog();
      }
      void window.desktop.discardWorkThreadCreation(creation.operationId).then(() => {
        if (useWorkbenchStore.getState().workThreadDraft?.operationId === creation.operationId) useWorkbenchStore.getState().setWorkThreadDraft(null);
      }).catch((error) => toast.error(String(error)));
    };
    const unsubscribe = window.desktop.onWorkThreadCreationChanged((state) => { events += 1; receive(state); });
    const before = events;
    void window.desktop.workThreadCreation().then((state) => { if (events === before) receive(state); }).catch((error) => toast.error(String(error)));
    return () => { disposed = true; unsubscribe(); };
  }, [client]);
}
