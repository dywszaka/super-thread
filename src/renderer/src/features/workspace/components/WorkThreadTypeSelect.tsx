import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { WorkThreadType } from "@/shared/domain";
import { workThreadTypes } from "@/shared/work-thread-type";

export function WorkThreadTypeSelect({ value, onChange }: {
  value: WorkThreadType;
  onChange(value: WorkThreadType): void;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const label = workThreadTypes.find((type) => type.value === value)!.label;
  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false);
    };
    const dismiss = (): void => setOpen(false);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", dismiss);
    };
  }, [open]);

  return <div ref={anchor} className="thread-type-select no-drag" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="thread-type-trigger" aria-label={`Work thread type: ${label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((current) => !current)} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
    }}>
      <span>{label}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && <div ref={menu} id={id} className="work-thread-context-menu thread-type-menu no-drag" role="menu" aria-label="Work thread type" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") close();
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      {workThreadTypes.map(({ value: type, label: name }) => <button key={type} type="button" role="menuitemradio" aria-checked={value === type} tabIndex={-1} onClick={() => {
        close();
        onChange(type);
      }}><span>{name}</span>{value === type && <Check size={14} aria-hidden="true" />}</button>)}
    </div>}
  </div>;
}
