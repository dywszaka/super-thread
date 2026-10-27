import { Download, FileText, FolderOpen, LoaderCircle, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { FilePreviewState, FilePreviewTab } from "@/shared/domain";
import { useNativePaneLayout } from "../use-native-pane-layout";

export function FilePreviewPane({ tab, onChooseFile }: { tab: FilePreviewTab; onChooseFile(): void }): React.ReactNode {
  const [state, setState] = useState<FilePreviewState>({ id: tab.id, loading: true });
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const host = useNativePaneLayout(tab.id, !state.error && !error, "preview", setError);
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
  const download = async (): Promise<void> => {
    if (downloading) return;
    setDownloading(true);
    try {
      if (await window.desktop.downloadFilePreview(tab.id)) toast.success("File saved to this Mac");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': /, "") : String(cause);
      toast.error(`Download failed: ${message}`);
    } finally { setDownloading(false); }
  };
  return <div className="browser-pane file-preview-pane no-drag">
    <div className="browser-toolbar file-preview-toolbar no-drag">
      <button type="button" className="icon-button" aria-label="Refresh file preview" onClick={() => void refresh()}>{state.loading ? <LoaderCircle size={15} className="spinning" /> : <RotateCw size={15} />}</button>
      <input aria-label="Preview file path" title={tab.path} value={tab.path} readOnly onFocus={(event) => event.target.select()} spellCheck={false} />
      <button type="button" className="icon-button" aria-label="Download file" title={downloading ? "Downloading file…" : "Download file to this Mac"} disabled={downloading} aria-busy={downloading} onClick={() => void download()}>{downloading ? <LoaderCircle size={15} className="spinning" /> : <Download size={15} />}</button>
      <button type="button" className="icon-button" aria-label="Choose preview file" title="Choose a file" onClick={onChooseFile}><FolderOpen size={15} /></button>
    </div>
    <div className="browser-content" ref={host}>
      {(error || state.error) && <div className="browser-message" role="alert"><FileText size={28} /><h3>File unavailable</h3><p className="selectable">{error || state.error}</p><button className="button" onClick={() => void refresh()}>Retry</button></div>}
    </div>
  </div>;
}
