import assert from "node:assert/strict";
import test from "node:test";
import { useWorkbenchStore } from "../src/renderer/src/state/workbench-store";

test("each workspace remembers its last active terminal session", () => {
  useWorkbenchStore.setState({ activeWorkspaceId: null, activeSessionIds: {} });

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
