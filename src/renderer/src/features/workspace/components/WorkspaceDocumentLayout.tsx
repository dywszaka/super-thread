import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppSnapshot, Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { threadDocumentAutosave } from "../document-autosave";
import { WorkThreadDocument } from "./WorkThreadDocument";

export function WorkspaceDocumentLayout({ snapshot, workspace, children }: { snapshot: AppSnapshot; workspace?: Workspace; children: React.ReactNode }): React.ReactNode {
  const collapsed = useWorkbenchStore((state) => state.workspaceDocumentCollapsed);
  const width = useWorkbenchStore((state) => state.workspaceDocumentWidth);
  const setWidth = useWorkbenchStore((state) => state.setWorkspaceDocumentWidth);
  const container = useRef<HTMLDivElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const thread = snapshot.workThreads.find((item) => item.id === workspace?.workThreadId && item.status === "active");
  const expanded = Boolean(thread && !collapsed);
  const minRatio = availableWidth ? Math.max(0.2, 260 / availableWidth) : 0.2;
  const maxRatio = availableWidth ? Math.min(0.65, (availableWidth - 245) / availableWidth) : 0.65;
  const displayedRatio = Math.min(maxRatio, Math.max(minRatio, width));
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setAvailableWidth(element.getBoundingClientRect().width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    drag.current = null;
    setResizing(false);
  }, [workspace?.id, expanded]);
  const close = (): void => {
    if (thread) void threadDocumentAutosave(thread.id, thread.document ?? "").flush();
    useWorkbenchStore.getState().setWorkspaceDocumentCollapsed(true);
    container.current?.querySelector<HTMLButtonElement>(".workspace-terminal-view.active .workspace-document-toggle")?.focus();
  };
  const resizeTo = (pixels: number): void => {
    const total = container.current?.getBoundingClientRect().width;
    if (!total) return;
    // Leave room for both panes even at the minimum window width.
    setWidth(Math.min(total - 245, Math.max(260, pixels)) / total);
  };
  return (
    <div ref={container} className={`workspace-content ${workspace ? "active" : ""} ${resizing && expanded ? "is-resizing" : ""}`}>
      {children}
      {expanded && thread && <>
        <div className="workspace-document-resize no-drag" role="separator" tabIndex={0} aria-label="Resize Doc" aria-orientation="vertical" aria-controls="workspace-document-drawer" aria-valuemin={Math.round(minRatio * 100)} aria-valuemax={Math.round(maxRatio * 100)} aria-valuenow={Math.round(displayedRatio * 100)} aria-valuetext={`${Math.round(displayedRatio * 100)}% document width`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, width: drawer.current?.getBoundingClientRect().width ?? 0 };
            setResizing(true);
          }}
          onPointerMove={(event) => { if (drag.current) resizeTo(drag.current.width + drag.current.x - event.clientX); }}
          onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); }}
          onLostPointerCapture={() => { drag.current = null; setResizing(false); }}
          onPointerCancel={() => { drag.current = null; setResizing(false); }}
          onDoubleClick={() => setWidth(1 / 3)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
            event.preventDefault();
            if (event.key === "Enter") setWidth(1 / 3);
            else if (event.key === "Home") setWidth(0.2);
            else if (event.key === "End") setWidth(0.65);
            else resizeTo((drawer.current?.getBoundingClientRect().width ?? 0) + (event.key === "ArrowLeft" ? 24 : -24));
          }} />
        <aside ref={drawer} id="workspace-document-drawer" className="workspace-document-drawer no-drag" style={{ width: `clamp(260px, ${width * 100}%, calc(100% - 245px))` }} aria-label={`${thread.name} Doc`}>
          <WorkThreadDocument key={thread.id} thread={thread} snapshot={snapshot} onClose={close} autoFocus={false} />
        </aside>
      </>}
    </div>
  );
}
