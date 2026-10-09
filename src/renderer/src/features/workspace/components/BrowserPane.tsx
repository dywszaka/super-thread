import { ArrowLeft, ArrowRight, Globe, LoaderCircle, RotateCw } from "lucide-react";
import { useLayoutEffect, useEffect, useRef, useState } from "react";
import type { BrowserState, BrowserTab } from "@/shared/domain";

export function BrowserPane({ tab }: { tab: BrowserTab }): React.ReactNode {
  const [address, setAddress] = useState(tab.url);
  const [state, setState] = useState<BrowserState>({ id: tab.id, loading: false, canGoBack: false, canGoForward: false });
  const [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { setAddress(tab.url); }, [tab.id, tab.url]);
  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.desktop.onBrowserStateChanged((next) => { if (next.id === tab.id) setState(next); });
    void window.desktop.browserStates().then((states) => {
      if (!disposed) setState(states.find((item) => item.id === tab.id) ?? { id: tab.id, loading: false, canGoBack: false, canGoForward: false });
    });
    return () => { disposed = true; unsubscribe(); };
  }, [tab.id]);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let frame = 0, last = "", dragging = false;
    const sync = (): void => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const covered = dragging || !!document.querySelector('.dialog-overlay, .context-menu, .workspace-popover, .terminal-kind-menu, .work-thread-context-menu, [data-sonner-toast]');
      const input = {
        id: !covered && tab.url && !state.error && !error ? tab.id : null,
        bounds: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height }
      };
      const key = JSON.stringify(input);
      if (key === last) return;
      last = key;
      void window.desktop.browserLayout(input).catch((cause) => setError(String(cause)));
    };
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(sync); };
    const startDrag = (): void => { dragging = true; sync(); };
    const endDrag = (): void => { dragging = false; schedule(); };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-state"] });
    window.addEventListener("resize", schedule);
    document.addEventListener("dragstart", startDrag);
    document.addEventListener("dragend", endDrag);
    document.addEventListener("drop", endDrag);
    sync();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("dragstart", startDrag);
      document.removeEventListener("dragend", endDrag);
      document.removeEventListener("drop", endDrag);
      void window.desktop.browserLayout({ id: null, bounds: { x: 0, y: 0, width: 0, height: 0 } });
    };
  }, [tab.id, tab.url, state.error, error]);
  const command = async (command: "back" | "forward" | "reload"): Promise<void> => {
    setError("");
    try { await window.desktop.browserCommand({ id: tab.id, command }); }
    catch (cause) { setError(String(cause)); }
  };
  return <div className="browser-pane no-drag">
    <form className="browser-toolbar no-drag" onSubmit={async (event) => {
      event.preventDefault(); setError("");
      try { await window.desktop.navigateBrowser({ id: tab.id, url: address }); }
      catch (cause) { setError(String(cause)); }
    }}>
      <button type="button" className="icon-button" aria-label="Back" disabled={!state.canGoBack} onClick={() => void command("back")}><ArrowLeft size={15} /></button>
      <button type="button" className="icon-button" aria-label="Forward" disabled={!state.canGoForward} onClick={() => void command("forward")}><ArrowRight size={15} /></button>
      <button type="button" className="icon-button" aria-label="Reload" disabled={!tab.url} onClick={() => void command("reload")}>{state.loading ? <LoaderCircle size={15} className="spinning" /> : <RotateCw size={15} />}</button>
      <input aria-label="Browser address" placeholder="Enter a URL or localhost:3000" value={address} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.target.select()} spellCheck={false} />
      <button className="button" type="submit">Go</button>
    </form>
    <div className="browser-content" ref={host}>
      {(state.error || error) ? <div className="browser-message" role="alert"><Globe size={28} /><h3>Page unavailable</h3><p className="selectable">{error || state.error}</p><button className="button" onClick={() => void command("reload")}>Retry</button></div> : !tab.url && <div className="browser-message"><Globe size={28} /><h3>Browse in this workspace</h3><p>Enter an address above. Localhost refers to this Mac, including in remote workspaces.</p></div>}
    </div>
  </div>;
}
