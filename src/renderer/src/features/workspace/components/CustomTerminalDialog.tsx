import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Device } from "@/shared/domain";
import { DirectoryField } from "./Dialogs";
import { Field, Modal } from "./Modal";

const message = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);

export function CustomTerminalDialog({ device, onClose }: { device: Device; onClose(): void }): React.ReactNode {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const presets = device.terminalPresets ?? [];
  const duplicate = presets.some((preset) => preset.id !== selectedId && preset.name.trim().toLowerCase() === name.trim().toLowerCase());
  const select = (id: string): void => {
    const preset = presets.find((item) => item.id === id);
    setSelectedId(id);
    setName(preset?.name ?? "");
    setPath(preset?.path ?? "");
    setError("");
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !name.trim() || !path.trim() || duplicate) return;
    setBusy(true); setError("");
    try {
      await window.desktop.saveTerminalPreset({ deviceId: device.id, id: selectedId || undefined, name, path });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success("Custom terminal entry saved");
      onClose();
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  const remove = async (): Promise<void> => {
    if (!selectedId || busy) return;
    setBusy(true); setError("");
    try {
      await window.desktop.deleteTerminalPreset({ deviceId: device.id, id: selectedId });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      select("");
      toast.success("Custom terminal entry deleted");
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  };
  return (
    <Modal open title="Custom terminal" description={`Save a terminal entry for ${device.name}. Available in every workspace on this device.`} busy={busy} submitDisabled={!name.trim() || !path.trim() || duplicate} submitLabel="Save Entry" onClose={onClose} onSubmit={save}>
      {presets.length > 0 && <Field label="Entry"><div className="custom-terminal-selection"><select value={selectedId} disabled={busy} onChange={(event) => select(event.target.value)}><option value="">New entry</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>{selectedId && <button type="button" className="icon-button danger-button" title="Delete entry (open terminals are kept)" aria-label="Delete custom terminal entry" disabled={busy} onClick={() => void remove()}><Trash2 size={15} /></button>}</div></Field>}
      <fieldset className="custom-terminal-fields" disabled={busy}>
        <Field label="Name" hint={duplicate ? "This name is already used on this device." : "Names must be unique on this device."}><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoFocus placeholder="Tools" /></Field>
        <Field label="Directory" hint={`The shell starts in this directory on ${device.name}.`}><DirectoryField value={path} onChange={setPath} remote={device.type === "remote"} deviceId={device.id} placeholder={device.type === "remote" ? "~/tools" : "/Users/you/tools"} /></Field>
      </fieldset>
      {error && <div className="directory-error" role="alert">{error}</div>}
    </Modal>
  );
}
