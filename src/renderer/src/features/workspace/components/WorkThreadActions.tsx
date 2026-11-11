import { Archive, MoreHorizontal, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function WorkThreadActions({ name, archived, busy, hasWorkspaces, onArchive, onDelete }: {
  name: string; archived: boolean; busy: boolean; hasWorkspaces: boolean;
  onArchive(): void; onDelete(): void;
}): React.ReactNode {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restoreFocus = false): void => {
    setPosition(null);
    if (restoreFocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!position) return;
    (menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu.current)?.focus();
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setPosition(null);
    };
    const dismiss = (): void => setPosition(null);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    // Portalled menus must not drift away from their row while a list scrolls.
    document.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [position]);
  return <>
    <button ref={trigger} type="button" className="icon-button" disabled={busy} title={`More actions for ${name}`} aria-label={`More actions for ${name}`} aria-haspopup="menu" aria-expanded={Boolean(position)} aria-controls={position ? id : undefined} onClick={() => {
      if (position) { close(true); return; }
      const rect = trigger.current!.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 150)) });
    }}><MoreHorizontal size={16} /></button>
    {position && createPortal(<div ref={menu} id={id} tabIndex={-1} className="work-thread-context-menu thread-actions-menu no-drag" role="menu" aria-label={`Actions for ${name}`} style={position} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === "Tab") close(true);
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      {!archived && <button type="button" role="menuitem" onClick={() => { close(true); onArchive(); }}><Archive size={14} /><span>Archive</span></button>}
      <button type="button" role="menuitem" className="danger-button" disabled={hasWorkspaces} aria-describedby={hasWorkspaces ? `${id}-reason` : undefined} onClick={() => { close(true); onDelete(); }}><Trash2 size={14} /><span>Delete work thread</span></button>
      {hasWorkspaces && <p id={`${id}-reason`}>Remove every workspace before deleting this work thread.</p>}
    </div>, document.body)}
  </>;
}
