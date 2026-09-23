import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Bot, Layers3, Plus, RotateCcw, TerminalSquare, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Session, SessionKind, TerminalOutput, Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";

function TerminalView({ session, active, resuming, onResume }: { session: Session; active: boolean; resuming: boolean; onResume: () => void }): React.ReactNode {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  useEffect(() => {
    if (!container.current || session.status !== "running") return;
    const terminal = new Terminal({
      cursorBlink: true, fontFamily: '"SFMono-Regular", "SF Mono", Menlo, monospace', fontSize: 12.5, lineHeight: 1.25,
      theme: { background: "#121211", foreground: "#dedbd6", cursor: "#d6a861", selectionBackground: "#4a4137", black: "#232220", brightBlack: "#6f6b65", red: "#d16d67", green: "#87a968", yellow: "#d6a861", blue: "#7196c9", magenta: "#ad7eb7", cyan: "#6ca6a1", white: "#dedbd6" },
      allowProposedApi: false, scrollback: 10_000
    });
    const fit = new FitAddon();
    // Let IME Process keys reach the textarea/input path so macOS punctuation mode is preserved.
    terminal.attachCustomKeyEventHandler((event) => event.key !== "Process" && event.keyCode !== 229);
    terminal.loadAddon(fit); terminal.open(container.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    let disposed = false;
    let replayComplete = false;
    let input: { dispose(): void } | undefined;
    let resizeFrame = 0;
    const pending: TerminalOutput[] = [];
    const syncSize = (): void => {
      try {
        fit.fit();
        terminal.refresh(0, terminal.rows - 1);
        window.desktop.resizeSession(session.id, terminal.cols, terminal.rows);
      } catch { /* hidden during resize */ }
    };
    const scheduleResize = (): void => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (!disposed) syncSize();
      });
    };
    syncSize();
    const unsubscribe = window.desktop.onTerminalOutput((event) => {
      if (event.sessionId !== session.id) return;
      if (!replayComplete) pending.push(event);
      else terminal.write(event.data);
    });
    const observer = new ResizeObserver(scheduleResize);
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
    return () => {
      disposed = true;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      unsubscribe();
      input?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, [session.id, session.status]);
  useEffect(() => {
    if (!active || session.status !== "running") return;
    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      if (!terminal || !fit) return;
      try {
        fit.fit();
        terminal.refresh(0, terminal.rows - 1);
        terminal.focus();
        void window.desktop.resizeSession(session.id, terminal.cols, terminal.rows);
      } catch { /* the workspace may be transitioning out */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, session.id, session.status]);
  if (session.status === "exited" || session.status === "restore-failed") return <div className={`terminal-view terminal-exited ${active ? "active" : ""}`} aria-hidden={!active}><TerminalSquare size={28} /><h3>{session.status === "restore-failed" ? "Restore failed" : "Session exited"}</h3><p>{session.restoreError || "The workspace is intact. Resume this session to continue."}</p><div className="terminal-empty-actions"><button className="button primary" disabled={resuming} onClick={onResume}><RotateCcw size={14} /> {resuming ? "Resuming…" : "Resume"}</button>{session.status === "restore-failed" && <button className="button" onClick={() => void window.desktop.createSession({ workspaceId: session.workspaceId, kind: "shell" })}><Plus size={14} /> New Terminal</button>}</div></div>;
  return <div ref={container} className={`terminal-view terminal-host selectable ${active ? "active" : ""}`} aria-hidden={!active} />;
}

export function TerminalPane({ snapshot, workspace, visible }: { snapshot: AppSnapshot; workspace: Workspace; visible: boolean }): React.ReactNode {
  const { activeSessionIds, setActiveSession } = useWorkbenchStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [replayVersions, setReplayVersions] = useState<Record<string, number>>({});
  const [createMenu, setCreateMenu] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sessions = useMemo(() => snapshot.sessions.filter((item) => item.workspaceId === workspace.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [snapshot.sessions, workspace.id]);
  const activeSessionId = activeSessionIds[workspace.id];
  const active = sessions.find((item) => item.id === activeSessionId) ?? sessions.find((item) => item.status === "running") ?? sessions[0];
  useEffect(() => {
    if (active && active.id !== activeSessionId) setActiveSession(workspace.id, active.id);
    if (!active && activeSessionId) setActiveSession(workspace.id, null);
  }, [active?.id, activeSessionId, workspace.id]);
  useEffect(() => {
    if (visible && active?.codexResultUnread) void window.desktop.markSessionViewed(active.id);
  }, [active?.id, active?.codexResultUnread, visible]);
  const create = async (kind: SessionKind): Promise<void> => {
    setCreateMenu(false);
    try {
      const result = await window.desktop.createSession({ workspaceId: workspace.id, kind });
      if (result.warning) toast.warning(result.warning);
    }
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
  const reorder = async (targetId: string): Promise<void> => {
    if (!draggingId || draggingId === targetId) return;
    const ids = sessions.map((session) => session.id);
    const from = ids.indexOf(draggingId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    if (!moved) return;
    ids.splice(to, 0, moved);
    try { await window.desktop.reorderSessions({ workspaceId: workspace.id, sessionIds: ids }); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <section className="terminal-pane">
      <div className="terminal-tabs no-drag">
        <div className="terminal-tab-scroll">{sessions.map((session) => <div key={session.id} role="button" tabIndex={0} draggable className={`terminal-tab ${active?.id === session.id ? "active" : ""} ${session.codexResultUnread ? "unread" : ""}`} onDragStart={(event) => { setDraggingId(session.id); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (draggingId) event.preventDefault(); }} onDrop={() => void reorder(session.id)} onDragEnd={() => setDraggingId(null)} onClick={() => setActiveSession(workspace.id, session.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setActiveSession(workspace.id, session.id); }}>{session.kind === "codex" ? <Bot size={13} /> : session.kind === "tmux" ? <Layers3 size={13} /> : <TerminalSquare size={13} />}{editingId === session.id ? <input className="terminal-tab-name-input" value={draftName} onChange={(event) => setDraftName(event.target.value)} onClick={(event) => event.stopPropagation()} onBlur={() => void saveRename()} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(); if (event.key === "Escape") { setEditingId(null); setDraftName(""); } }} autoFocus maxLength={80} required /> : <span onDoubleClick={(event) => { event.stopPropagation(); beginRename(session); }}>{session.name}</span>}<i className={session.status === "running" ? session.activityStatus ?? "running" : session.status} />{active?.id === session.id && <button type="button" className="tab-close" title="Close terminal" onClick={(event) => { event.stopPropagation(); void close(session.id); }}><X size={12} /></button>}</div>)}</div>
        <div className="terminal-add-menu">
          <button className="icon-button terminal-add" onClick={() => setCreateMenu(!createMenu)} title="New terminal"><Plus size={15} /></button>
          {createMenu && <div className="terminal-kind-menu"><button onClick={() => void create("shell")}><TerminalSquare size={14} /> Terminal</button><button onClick={() => void create("codex")}><Bot size={14} /> Codex</button><button onClick={() => void create("tmux")}><Layers3 size={14} /> tmux</button></div>}
        </div>
      </div>
      <div className="terminal-stage">{sessions.length > 0 ? sessions.map((session) => <TerminalView key={`${session.id}:${replayVersions[session.id] ?? 0}`} session={session} active={visible && active?.id === session.id} resuming={resumingId === session.id} onResume={() => void resume(session.id)} />) : <div className="terminal-empty"><TerminalSquare size={30} /><h3>No terminal sessions</h3><div className="terminal-empty-actions"><button className="button primary" onClick={() => void create("shell")}><Plus size={14} /> Terminal</button><button className="button" onClick={() => void create("codex")}><Bot size={14} /> Codex</button><button className="button" onClick={() => void create("tmux")}><Layers3 size={14} /> tmux</button></div></div>}</div>
      <div className="terminal-status"><span><i className={active?.status === "running" ? "online" : "offline"} /> {active?.activityStatus ?? active?.status ?? "no session"}</span><span>{active?.kind ?? "shell"}</span><span>{active?.cwd}</span>{active?.status === "running" && <button title="Replay terminal output" onClick={() => setReplayVersions((versions) => ({ ...versions, [active.id]: (versions[active.id] ?? 0) + 1 }))}><RotateCcw size={11} /></button>}</div>
    </section>
  );
}
