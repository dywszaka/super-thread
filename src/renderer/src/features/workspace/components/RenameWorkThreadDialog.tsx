import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { WorkThread } from "@/shared/domain";
import { Field, Modal } from "./Modal";

const cleanError = (error: unknown): string => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': /, "")
  : String(error);

export function RenameWorkThreadDialog({ thread, onClose }: { thread?: WorkThread; onClose(): void }): React.ReactNode {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  useEffect(() => { setName(thread?.name ?? ""); }, [thread?.id, thread?.name]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!thread || !trimmed || trimmed.length > 80 || trimmed === thread.name) return;
    setBusy(true);
    try {
      await window.desktop.renameWorkThread({ id: thread.id, name: trimmed });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success(`Work thread renamed to ${trimmed}`);
      onClose();
    } catch (error) { toast.error(cleanError(error)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={Boolean(thread)} title="Rename work thread" busy={busy} submitDisabled={!trimmed || trimmed.length > 80 || trimmed === thread?.name} submitLabel="Save Changes" onClose={onClose} onSubmit={submit}>
      <Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus /></Field>
    </Modal>
  );
}
