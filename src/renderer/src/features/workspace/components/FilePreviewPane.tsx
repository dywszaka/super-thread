import { FileText, LoaderCircle, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { FilePreviewState, FilePreviewTab } from "@/shared/domain";
import { useNativePaneLayout } from "../use-native-pane-layout";

export function FilePreviewPane({ tab }: { tab: FilePreviewTab }): React.ReactNode {
  const [state, setState] = useState<FilePreviewState>({ id: tab.id, loading: true });
  const [error, setError] = useState("");
  const host = useNativePaneLayout(tab.id, !state.error && !error, "preview", setError);
  useEffect(() => {
    let disposed = false, received = false;
    const unsubscribe = window.desktop.onFilePreviewStateChanged((next) => {
      if (next.id === tab.id) { received = true; setState(next); }
    });
    void window.desktop.filePreviewStates().then((states) => {
      const current = states.find((item) => item.id === tab.id);
      if (!disposed && !received && current) setState(current);
    }).catch((cause) => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; unsubscribe(); };
  }, [tab.id]);
  const refresh = async (): Promise<void> => {
    setError("");
    try { await window.desktop.refreshFilePreview(tab.id); }
    catch (cause) { setError(String(cause)); }
  };
  return <div className="browser-pane file-preview-pane no-drag">
    <div className="browser-toolbar file-preview-toolbar no-drag">
      <FileText size={16} />
      <div className="file-preview-path" title={tab.path}><strong>{tab.path.split("/").at(-1)}</strong><span>{tab.path}</span></div>
      <button type="button" className="icon-button" aria-label="Refresh file preview" onClick={() => void refresh()}>{state.loading ? <LoaderCircle size={15} className="spinning" /> : <RotateCw size={15} />}</button>
    </div>
    <div className="browser-content" ref={host}>
      {(error || state.error) && <div className="browser-message" role="alert"><FileText size={28} /><h3>File unavailable</h3><p className="selectable">{error || state.error}</p><button className="button" onClick={() => void refresh()}>Retry</button></div>}
    </div>
  </div>;
}
