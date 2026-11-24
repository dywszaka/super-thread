import { useId } from "react";

export function CodexRecordingField({ enabled, onChange, disabled = false }: { enabled: boolean; onChange(enabled: boolean): void; disabled?: boolean }): React.ReactNode {
  const hintId = useId();
  return <div className="codex-recording-field">
    <label className="codex-recording-toggle"><input type="checkbox" name="codexRecordingEnabled" checked={enabled} disabled={disabled} aria-describedby={hintId} onChange={(event) => onChange(event.target.checked)} /><span>启用 Codex 会话记录</span></label>
    <p id={hintId}>Record new Codex sessions from embedded terminals in Work Threads. Requires Python 3, bash or zsh, and a recent Codex CLI. Trust the SuperThread hooks in Codex /hooks, then open a new terminal. Disabling keeps existing records.</p>
  </div>;
}
