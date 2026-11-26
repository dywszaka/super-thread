import { useLayoutEffect, useRef } from "react";
import type { BrowserLayoutInput } from "@/shared/domain";
import { NativePanePresentation } from "./native-pane-presentation";

/** Native surfaces must yield to dialogs, menus, drag gestures, and renderer errors. */
export function useNativePaneLayout(id: string, enabled: boolean, kind: "browser" | "preview", onError: (error: string) => void) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layout = (input: BrowserLayoutInput): Promise<void> => kind === "browser" ? window.desktop.browserLayout(input) : window.desktop.filePreviewLayout(input);
    const element = host.current;
    if (!element) return;
    const presentation = new NativePanePresentation({
      layout,
      prepareSnapshot: async (paneId) => {
        const data = await window.desktop.nativePaneSnapshot({ id: paneId, kind });
        if (data) {
          const image = new Image();
          image.src = data;
          await image.decode();
        }
        return data;
      },
      showSnapshot: (image) => { element.style.backgroundImage = image ? `url("${image}")` : ""; },
      painted: () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    });
    let frame = 0, dragging = false;
    const sync = (): void => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const covered = dragging || !!document.querySelector('.dialog-overlay, .context-menu, .workspace-popover, .terminal-kind-menu, .work-thread-context-menu, .workspace-content.is-resizing, [data-sonner-toast]');
      const input = {
        id: enabled ? id : null,
        bounds: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height }
      };
      void presentation.update(input, covered).catch((cause) => onError(String(cause)));
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
      presentation.dispose();
    };
  }, [id, enabled, kind, onError]);
  return host;
}
