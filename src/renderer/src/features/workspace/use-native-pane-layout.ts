import { useLayoutEffect, useRef } from "react";
import type { BrowserLayoutInput } from "@/shared/domain";

/** Native surfaces must yield to dialogs, menus, drag gestures, and renderer errors. */
export function useNativePaneLayout(id: string, enabled: boolean, kind: "browser" | "preview", onError: (error: string) => void) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layout = (input: BrowserLayoutInput): Promise<void> => kind === "browser" ? window.desktop.browserLayout(input) : window.desktop.filePreviewLayout(input);
    const element = host.current;
    if (!element) return;
    let frame = 0, last = "", dragging = false;
    const sync = (): void => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const covered = dragging || !!document.querySelector('.dialog-overlay, .context-menu, .workspace-popover, .terminal-kind-menu, .work-thread-context-menu, [data-sonner-toast]');
      const input = {
        id: !covered && enabled ? id : null,
        bounds: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height }
      };
      const key = JSON.stringify(input);
      if (key === last) return;
      last = key;
      void layout(input).catch((cause) => onError(String(cause)));
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
      void layout({ id: null, bounds: { x: 0, y: 0, width: 0, height: 0 } });
    };
  }, [id, enabled, kind, onError]);
  return host;
}
