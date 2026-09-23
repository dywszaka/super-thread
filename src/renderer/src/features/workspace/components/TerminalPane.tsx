import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Plus, RotateCcw, TerminalSquare, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Session, TerminalOutput, Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";

function TerminalView({ session, resuming, onResume }: { session: Session; resuming: boolean; onResume: () => void }): React.ReactNode {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current || session.status !== "running") return;
    const terminal = new Terminal({
      cursorBlink: true, fontFamily: '"SFMono-Regular", "SF Mono", Menlo, monospace', fontSize: 12.5, lineHeight: 1.25,
      theme: { background: "#121211", foreground: "#dedbd6", cursor: "#d6a861", selectionBackground: "#4a4137", black: "#232220", brightBlack: "#6f6b65", red: "#d16d67", green: "#87a968", yellow: "#d6a861", blue: "#7196c9", magenta: "#ad7eb7", cyan: "#6ca6a1", white: "#dedbd6" },
      allowProposedApi: false, scrollback: 10_000
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit); terminal.open(container.current); fit.fit(); terminal.focus();
    let disposed = false;
    let replayComplete = false;
    let input: { dispose(): void } | undefined;
    const pending: TerminalOutput[] = [];
    const unsubscribe = window.desktop.onTerminalOutput((event) => {
      if (event.sessionId !== session.id) return;
      if (!replayComplete) pending.push(event);
      else terminal.write(event.data);
    });
    const observer = new ResizeObserver(() => { try { fit.fit(); window.desktop.resizeSession(session.id, terminal.cols, terminal.rows); } catch { /* hidden during resize */ } });
    observer.observe(container.current);
    void window.desktop.attachSession(session.id).then((replay) => {
      if (disposed) return;
      const finishReplay = (): void => {
        if (disposed) return;
        for (const event of pending) {
          if (event.sequence > replay.sequence) terminal.write(event.data);
        }
        pending.length = 0;
        replayComplete = true;
        input = terminal.onData((data) => window.desktop.writeSession(session.id, data));
      };
      if (replay.data) terminal.write(replay.data, finishReplay);
      else finishReplay();
    }).catch(() => {
      if (disposed) return;
      replayComplete = true;
      input = terminal.onData((data) => window.desktop.writeSession(session.id, data));
    });
    return () => { disposed = true; observer.disconnect(); unsubscribe(); input?.dispose(); terminal.dispose(); };
  }, [session.id, session.status]);
  if (session.status === "exited") return <div className="terminal-exited"><TerminalSquare size={28} /><h3>Session exited</h3><p>The workspace is intact. Resume this session to continue.</p><button className="button primary" disabled={resuming} onClick={onResume}><RotateCcw size={14} /> {resuming ? "Resuming…" : "Resume"}</button></div>;
  return <div ref={container} className="terminal-host selectable" />;
}

export function TerminalPane({ snapshot, workspace }: { snapshot: AppSnapshot; workspace: Workspace }): React.ReactNode {
  const { activeSessionIds, setActiveSession } = useWorkbenchStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [replayNonce, setReplayNonce] = useState(0);
  const sessions = useMemo(() => snapshot.sessions.filter((item) => item.workspaceId === workspace.id), [snapshot.sessions, workspace.id]);
  const activeSessionId = activeSessionIds[workspace.id];
  const active = sessions.find((item) => item.id === activeSessionId) ?? sessions.find((item) => item.status === "running") ?? sessions[0];
  useEffect(() => {
    if (active && active.id !== activeSessionId) setActiveSession(workspace.id, active.id);
    if (!active && activeSessionId) setActiveSession(workspace.id, null);
  }, [active?.id, activeSessionId, workspace.id]);
  const create = async (): Promise<void> => {
    try { await window.desktop.createSession({ workspaceId: workspace.id }); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };
  const close = async (sessionId: string): Promise<void> => {
    try { await window.desktop.killSession(sessionId); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };
  const resume = async (sessionId: string): Promise<void> => {
    setResumingId(sessionId);
    try { await window.desktop.resumeSession(sessionId); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setResumingId(null); }
  };
  const beginRename = (session: Session): void => {
    setEditingId(session.id);
    setDraftName(session.name);
  };
  const saveRename = async (): Promise<void> => {
    if (!editingId) return;
    const name = draftName.trim();
    setEditingId(null);
    try { await window.desktop.renameSession({ id: editingId, name }); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <section className="terminal-pane">
      <div className="terminal-tabs no-drag">
        <div className="terminal-tab-scroll">{sessions.map((session) => <div key={session.id} role="button" tabIndex={0} className={`terminal-tab ${active?.id === session.id ? "active" : ""}`} onClick={() => setActiveSession(workspace.id, session.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setActiveSession(workspace.id, session.id); }}><TerminalSquare size={13} />{editingId === session.id ? <input className="terminal-tab-name-input" value={draftName} onChange={(event) => setDraftName(event.target.value)} onClick={(event) => event.stopPropagation()} onBlur={() => void saveRename()} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(); if (event.key === "Escape") { setEditingId(null); setDraftName(""); } }} autoFocus maxLength={80} required /> : <span onDoubleClick={(event) => { event.stopPropagation(); beginRename(session); }}>{session.name}</span>}<i className={session.status} />{active?.id === session.id && <button type="button" className="tab-close" title="Close terminal" onClick={(event) => { event.stopPropagation(); void close(session.id); }}><X size={12} /></button>}</div>)}</div>
        <button className="icon-button terminal-add" onClick={() => void create()} title="New terminal"><Plus size={15} /></button>
      </div>
      <div className="terminal-stage">{active ? <TerminalView key={`${active.id}:${replayNonce}`} session={active} resuming={resumingId === active.id} onResume={() => void resume(active.id)} /> : <div className="terminal-empty"><TerminalSquare size={30} /><h3>No terminal sessions</h3><button className="button primary" onClick={() => void create()}><Plus size={14} /> New Terminal</button></div>}</div>
      <div className="terminal-status"><span><i className={active?.status === "running" ? "online" : "offline"} /> {active?.status ?? "no session"}</span><span>{active?.shell}</span>{active?.status === "running" && <button title="Replay terminal output" onClick={() => setReplayNonce((value) => value + 1)}><RotateCcw size={11} /></button>}</div>
    </section>
  );
}
