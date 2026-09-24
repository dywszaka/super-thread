import assert from "node:assert/strict";
import test from "node:test";
import { useWorkbenchStore } from "../src/renderer/src/state/workbench-store";

test("each workspace remembers its last active terminal session", () => {
  useWorkbenchStore.setState({ activeWorkspaceId: null, activeSessionIds: {}, focusMode: false });

  useWorkbenchStore.getState().setActiveWorkspace("workspace-a");
  useWorkbenchStore.getState().setActiveSession("workspace-a", "session-a2");
  useWorkbenchStore.getState().setActiveWorkspace("workspace-b");
  useWorkbenchStore.getState().setActiveSession("workspace-b", "session-b3");
  useWorkbenchStore.getState().setActiveWorkspace("workspace-a");

  const state = useWorkbenchStore.getState();
  assert.equal(state.activeSessionIds["workspace-a"], "session-a2");
  assert.equal(state.activeSessionIds["workspace-b"], "session-b3");
});

test("clearing a missing session only removes that workspace selection", () => {
  useWorkbenchStore.setState({
    activeSessionIds: { "workspace-a": "session-a2", "workspace-b": "session-b3" }
  });

  useWorkbenchStore.getState().setActiveSession("workspace-a", null);

  assert.deepEqual(useWorkbenchStore.getState().activeSessionIds, { "workspace-b": "session-b3" });
});

test("focus mode toggles for the current renderer run", () => {
  useWorkbenchStore.setState({ focusMode: false });

  useWorkbenchStore.getState().enterFocusMode();
  assert.equal(useWorkbenchStore.getState().focusMode, true);

  useWorkbenchStore.getState().exitFocusMode();
  assert.equal(useWorkbenchStore.getState().focusMode, false);
});

test("focus mode is excluded from persisted workbench state", () => {
  useWorkbenchStore.setState({
    activeWorkspaceId: "workspace-a",
    activeSessionIds: { "workspace-a": "session-a2" },
    focusMode: true
  });

  const partialize = useWorkbenchStore.persist.getOptions().partialize ?? ((state) => state);
  const persisted = partialize(useWorkbenchStore.getState()) as Record<string, unknown>;

  assert.equal(persisted.activeWorkspaceId, "workspace-a");
  assert.equal("focusMode" in persisted, false);
});
