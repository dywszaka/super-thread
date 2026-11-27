import type { AppSnapshot, CodexSessionRecord, WorkThread } from "@/shared/domain";

export function CodexSessionList({ thread, snapshot }: { thread: WorkThread; snapshot: AppSnapshot }): React.ReactNode {
  const sessions = thread.codexSessions ?? [];
  const groups = new Map<string, CodexSessionRecord[]>();
  for (const session of sessions) {
    const group = groups.get(session.projectId) ?? [];
    group.push(session);
    groups.set(session.projectId, group);
  }
  return <div className="codex-session-list selectable">
    <p>{sessions.length} Codex {sessions.length === 1 ? "session" : "sessions"} · grouped by project</p>
    <p className="codex-session-hint">Only sessions observed after recording was enabled are listed. Resuming a recorded session does not add another entry. Titles use the first observed prompt summary.</p>
    {!sessions.length && <p>No Codex sessions recorded. Enable Codex session recording in Devices, trust the hooks in Codex /hooks, then run codex --no-daemon in a new embedded terminal belonging to this Work Thread. This opts into recording without desktop sharing; plain codex keeps desktop sharing.</p>}
    {[...groups].map(([projectId, records]) => {
      const project = snapshot.projects.find((item) => item.id === projectId);
      const first = records[0]!;
      return <section key={projectId} className="codex-project-group" aria-label={`${project?.name ?? first.projectName} Codex sessions`}>
        <h2>{project?.name ?? first.projectName} <span>{project?.code ?? first.projectCode} · {records.length}</span></h2>
        <ul>{[...records].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).map((record) => <li key={`${record.deviceId}:${record.codexSessionId}`}>
          <strong>{record.title || "Untitled Codex session"}</strong>
          {record.title && <span className="codex-session-hint">提问摘要</span>}
          <code>{record.codexSessionId}</code>
          <span>{snapshot.devices.find((device) => device.id === record.deviceId)?.name ?? record.deviceName} · {record.workspaceName}</span>
          <code>{record.cwd}</code>
          <span>First observed: <time dateTime={record.firstSeenAt}>{new Date(record.firstSeenAt).toLocaleString()}</time></span>
          <span>Last observed: <time dateTime={record.lastSeenAt}>{new Date(record.lastSeenAt).toLocaleString()}</time></span>
        </li>)}</ul>
      </section>;
    })}
  </div>;
}
