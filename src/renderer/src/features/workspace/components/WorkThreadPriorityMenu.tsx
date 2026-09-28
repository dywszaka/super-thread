import { ArrowDown, ArrowUp, Check, Minus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { WorkThreadPriority } from "@/shared/domain";

const priorities: ReadonlyArray<{ value: WorkThreadPriority; label: string; icon: typeof ArrowUp }> = [
  { value: "high", label: "High", icon: ArrowUp },
  { value: "normal", label: "Normal", icon: Minus },
  { value: "low", label: "Low", icon: ArrowDown }
];
const priorityMenuEvent = "superthread:open-work-thread-priority";

export function openWorkThreadPriorityMenu(id: string): void {
  window.dispatchEvent(new CustomEvent<string>(priorityMenuEvent, { detail: id }));
}

const cleanError = (error: unknown): string => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': /, "")
  : String(error);

export function WorkThreadPriorityIcon({ priority, size = 13 }: { priority: WorkThreadPriority; size?: number }): ReactNode {
  const item = priorities.find((candidate) => candidate.value === priority)!;
  const Icon = item.icon;
  return <Icon size={size} aria-hidden="true" />;
}

export function WorkThreadPriorityMenu({ id, priority, compact = false }: { id: string; priority: WorkThreadPriority; compact?: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = priorities.find((item) => item.value === priority)!;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    const handleOpen = (event: Event): void => setOpen((event as CustomEvent<string>).detail === id);
    window.addEventListener(priorityMenuEvent, handleOpen);
    return () => window.removeEventListener(priorityMenuEvent, handleOpen);
  }, [id]);

  const select = async (next: WorkThreadPriority): Promise<void> => {
    setOpen(false);
    if (next === priority) return;
    setBusy(true);
    try {
      await window.desktop.setWorkThreadPriority({ id, priority: next });
    } catch (error) {
      toast.error(cleanError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`thread-priority-menu ${compact ? "compact" : ""} ${open ? "open" : ""}`} ref={root}>
      <button
        type="button"
        className="thread-priority-trigger"
        disabled={busy}
        aria-label={`Priority: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Priority: ${current.label}`}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      >
        <WorkThreadPriorityIcon priority={priority} />
        {!compact && <span>{current.label}</span>}
      </button>
      {open && <div className="thread-priority-popover" role="menu" aria-label="Work thread priority">
        {priorities.map((item) => {
          const Icon = item.icon;
          return <button type="button" role="menuitemradio" aria-checked={item.value === priority} key={item.value} onClick={(event) => { event.stopPropagation(); void select(item.value); }}><Icon size={13} /><span>{item.label}</span>{item.value === priority && <Check size={13} />}</button>;
        })}
      </div>}
    </div>
  );
}
