import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  busy?: boolean;
  submitLabel?: string;
  onClose(): void;
  onSubmit?(event: FormEvent<HTMLFormElement>): void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, title, description, busy, submitLabel = "Create", onClose, onSubmit, children, footer }: ModalProps): ReactNode {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content no-drag" aria-describedby={description ? undefined : undefined}>
          <form onSubmit={onSubmit}>
            <div className="dialog-heading">
              <div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div>
              <Dialog.Close className="icon-button" disabled={busy} aria-label="Close"><X size={16} /></Dialog.Close>
            </div>
            <div className="dialog-body">{children}</div>
            <div className="dialog-footer">
              {footer ?? <><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Working…" : submitLabel}</button></>}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
