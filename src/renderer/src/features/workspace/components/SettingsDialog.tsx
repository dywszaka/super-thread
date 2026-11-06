import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AppSettings } from "@/shared/domain";
import { defaultAppSettings, MAX_WORK_THREAD_DOCUMENT_LENGTH } from "@/shared/app-settings";
import { appSettingsSchema } from "@/shared/contract";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { Field, Modal } from "./Modal";

export function SettingsDialog({ settings }: { settings: AppSettings }): React.ReactNode {
  const closeDialog = useWorkbenchStore((state) => state.closeDialog);
  const client = useQueryClient();
  const [template, setTemplate] = useState(settings.workThreadTemplate);
  const [reminder, setReminder] = useState(String(settings.workThreadReminderDays));
  const [strongReminder, setStrongReminder] = useState(String(settings.workThreadStrongReminderDays));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parsed = appSettingsSchema.safeParse({ workThreadTemplate: template, workThreadReminderDays: Number(reminder), workThreadStrongReminderDays: Number(strongReminder) });
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!parsed.success || busy) return;
    setBusy(true); setError("");
    try {
      await window.desktop.saveSettings(parsed.data);
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      toast.success("Settings saved");
      closeDialog();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': /, "") : String(cause));
    } finally { setBusy(false); }
  };
  return <Modal open title="Settings" description="Define new work threads and choose when to revisit longer-running work." busy={busy} submitLabel="Save Settings" submitDisabled={!parsed.success} onClose={closeDialog} onSubmit={submit}>
    <Field label="Work thread template" hint="Markdown prefilled for new work threads. Existing documents keep their content.">
      <textarea className="markdown-input" value={template} disabled={busy} maxLength={MAX_WORK_THREAD_DOCUMENT_LENGTH} rows={10} onChange={(event) => setTemplate(event.target.value)} />
    </Field>
    <div className="form-grid two">
      <Field label="First reminder (days)"><input type="number" min={1} step={1} value={reminder} disabled={busy} onChange={(event) => setReminder(event.target.value)} /></Field>
      <Field label="Stronger reminder (days)"><input type="number" min={Number(reminder) + 1 || 2} step={1} value={strongReminder} disabled={busy} onChange={(event) => setStrongReminder(event.target.value)} /></Field>
    </div>
    {!parsed.success && <p className="field-error" role="alert">Use positive whole days, with the stronger reminder after the first.</p>}
    <p className="settings-hint">Time is counted from creation, including time spent archived. Only active work threads show reminders.</p>
    <button type="button" className="button" disabled={busy} onClick={() => {
      const defaults = defaultAppSettings();
      setTemplate(defaults.workThreadTemplate);
      setReminder(String(defaults.workThreadReminderDays));
      setStrongReminder(String(defaults.workThreadStrongReminderDays));
    }}>Restore Defaults</button>
    {error && <p className="field-error selectable" role="alert">Could not save settings: {error}. Your changes are kept here; try saving again.</p>}
  </Modal>;
}
