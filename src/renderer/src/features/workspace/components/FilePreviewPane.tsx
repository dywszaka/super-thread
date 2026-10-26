import { FileText, LoaderCircle, RotateCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { FilePreviewState, FilePreviewTab } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { useNativePaneLayout } from "../use-native-pane-layout";

export function FilePreviewPane({ tab }: { tab: FilePreviewTab }): React.ReactNode {
  const client = useQueryClient();
  const setActiveSession = useWorkbenchStore((store) => store.setActiveSession);
  const [address, setAddress] = useState(tab.path);
  const [navigating, setNavigating] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const request = useRef(0);
  const [state, setState] = useState<FilePreviewState>({ id: tab.id, loading: true });
  const [error, setError] = useState("");
  const host = useNativePaneLayout(tab.id, !state.error && !error, "preview", setError);
  useEffect(() => { setAddress(tab.path); }, [tab.path]);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => {
    let disposed = false, received = false;
    setState({ id: tab.id, loading: true });
    setError("");
    const unsubscribe = window.desktop.onFilePreviewStateChanged((next) => {
      if (next.id === tab.id) { received = true; setState(next); }
    });
    void window.desktop.filePreviewStates().then((states) => {
      const current = states.find((item) => item.id === tab.id);
      if (!disposed && !received && current) setState(current);
    }).catch((cause) => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; unsubscribe(); };
  }, [tab.id, tab.path]);
  const refresh = async (): Promise<void> => {
    setError("");
    try { await window.desktop.refreshFilePreview(tab.id); }
    catch (cause) { setError(String(cause)); }
  };
  const navigate = async (): Promise<void> => {
    const current = ++request.current;
    setNavigating(true); setNavigationError("");
    try {
      const selected = await window.desktop.navigateFilePreview({ id: tab.id, path: address });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      if (current !== request.current) return;
      setAddress(selected.path);
      setActiveSession(tab.workspaceId, selected.id);
    } catch (cause) {
      if (current === request.current) setNavigationError(String(cause));
    } finally {
      if (current === request.current) setNavigating(false);
    }
  };
  return <div className="browser-pane file-preview-pane no-drag">
    <form className="browser-toolbar file-preview-toolbar no-drag" onSubmit={(event) => { event.preventDefault(); if (!navigating) void navigate(); }}>
      <button type="button" className="icon-button" aria-label="Refresh file preview" disabled={navigating} onClick={() => void refresh()}>{state.loading || navigating ? <LoaderCircle size={15} className="spinning" /> : <RotateCw size={15} />}</button>
      <input aria-label="Preview file path" title={tab.path} placeholder="Enter a workspace-relative file path" value={address} readOnly={navigating} aria-busy={navigating} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.target.select()} onKeyDown={(event) => { if (event.key === "Escape") { setAddress(tab.path); setNavigationError(""); } }} spellCheck={false} />
    </form>
    {navigationError && <p className="file-preview-navigation-error field-error selectable" role="alert">{navigationError}</p>}
    <div className="browser-content" ref={host}>
      {(error || state.error) && <div className="browser-message" role="alert"><FileText size={28} /><h3>File unavailable</h3><p className="selectable">{error || state.error}</p><button className="button" onClick={() => void refresh()}>Retry</button></div>}
    </div>
  </div>;
}
