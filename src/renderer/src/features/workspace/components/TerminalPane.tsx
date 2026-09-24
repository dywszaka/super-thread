import { FitAddon } from "@xterm/addon-fit";
import { useQueryClient } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { AlertTriangle, Bot, Layers3, LoaderCircle, Plus, RotateCcw, TerminalSquare, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, Session, SessionKind, TerminalOutput, Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";

interface PendingSession {
  id: string;
  workspaceId: string;
  kind: SessionKind;
  name: string;
  status: "creating" | "failed";
  error?: string;
}

const pendingName = (kind: SessionKind): string => {
  if (kind === "codex") return "Codex";
  if (kind === "tmux") return "tmux";
  return "Terminal";
};

const sessionIcon = (kind?: SessionKind, size = 13): React.ReactNode => (
  kind === "codex" ? <Bot size={size} /> : kind === "tmux" ? <Layers3 size={size} /> : <TerminalSquare size={size} />
);

function TerminalView({ session, active, resuming, onResume, onCreate }: { session: Session; active: boolean; resuming: boolean; onResume: () => void; onCreate: (kind: SessionKind) => void }): React.ReactNode {
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
  if (session.status === "exited" || session.status === "restore-failed") return <div className={`terminal-view terminal-exited ${active ? "active" : ""}`} aria-hidden={!active}>{sessionIcon(session.kind, 28)}<h3>{session.status === "restore-failed" ? "Restore failed" : "Session exited"}</h3><p>{session.restoreError || "The workspace is intact. Resume this session to continue."}</p><div className="terminal-empty-actions"><button className="button primary" disabled={resuming} onClick={onResume}><RotateCcw size={14} /> {resuming ? "Resuming…" : "Resume"}</button>{session.status === "restore-failed" && <button className="button" onClick={() => onCreate(session.kind ?? "shell")}><Plus size={14} /> New {pendingName(session.kind ?? "shell")}</button>}</div></div>;
  return <div ref={container} className={`terminal-view terminal-host selectable ${active ? "active" : ""}`} aria-hidden={!active} />;
}

function PendingTerminalView({ pending, active, onRetry, onClose }: { pending: PendingSession; active: boolean; onRetry: () => void; onClose: () => void }): React.ReactNode {
  const creating = pending.status === "creating";
  return (
    <div className={`terminal-view terminal-exited terminal-pending ${active ? "active" : ""}`} aria-hidden={!active}>
      {creating ? <LoaderCircle className="spinning" size={28} /> : <AlertTriangle size={28} />}
      <h3>{creating ? `Starting ${pending.name}…` : `${pending.name} failed to start`}</h3>
      <p>{creating ? "Preparing the terminal session." : pending.error}</p>
      {!creating && <div className="terminal-empty-actions"><button className="button primary" onClick={onRetry}><RotateCcw size={14} /> Retry</button><button className="button" onClick={onClose}><X size={14} /> Close</button></div>}
    </div>
  );
}

export function TerminalPane({ snapshot, workspace, visible }: { snapshot: AppSnapshot; workspace: Workspace; visible: boolean }): React.ReactNode {
  const client = useQueryClient();
  const { activeSessionIds, setActiveSession, sessionCreateRequests, acknowledgeSessionCreateRequest } = useWorkbenchStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [createMenu, setCreateMenu] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingSessions, setPendingSessions] = useState<PendingSession[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const createMenuAnchor = useRef<HTMLDivElement>(null);
  const creatingRef = useRef(false);
  const sessions = useMemo(() => snapshot.sessions.filter((item) => item.workspaceId === workspace.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [snapshot.sessions, workspace.id]);
  const pendingForWorkspace = useMemo(() => pendingSessions.filter((item) => item.workspaceId === workspace.id), [pendingSessions, workspace.id]);
  const activeSessionId = activeSessionIds[workspace.id];
  const activeStoredSession = sessions.find((item) => item.id === activeSessionId);
  const active = sessions.find((item) => item.id === activeSessionId) ?? pendingForWorkspace.find((item) => item.id === activeSessionId) ?? sessions.find((item) => item.status === "running") ?? pendingForWorkspace[0] ?? sessions[0];
  useEffect(() => {
    if (active && active.id !== activeSessionId) setActiveSession(workspace.id, active.id);
    if (!active && activeSessionId) setActiveSession(workspace.id, null);
  }, [active?.id, activeSessionId, setActiveSession, workspace.id]);
  useEffect(() => {
    if (!visible || !activeStoredSession?.resultUnread) return;
    const markIfViewed = (): void => {
      if (document.visibilityState === "visible" && document.hasFocus()) void window.desktop.markSessionViewed(activeStoredSession.id);
    };
    markIfViewed();
    window.addEventListener("focus", markIfViewed);
    document.addEventListener("visibilitychange", markIfViewed);
    return () => {
      window.removeEventListener("focus", markIfViewed);
      document.removeEventListener("visibilitychange", markIfViewed);
    };
  }, [activeStoredSession?.id, activeStoredSession?.resultUnread, visible]);
  useEffect(() => {
    if (!createMenu) return;
    const closeCreateMenu = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && !createMenuAnchor.current?.contains(target)) setCreateMenu(false);
    };
    window.addEventListener("pointerdown", closeCreateMenu);
    return () => window.removeEventListener("pointerdown", closeCreateMenu);
  }, [createMenu]);
  const closePending = useCallback((pendingId: string): void => {
    setPendingSessions((items) => items.filter((item) => item.id !== pendingId));
    if (activeSessionIds[workspace.id] === pendingId) setActiveSession(workspace.id, null);
  }, [activeSessionIds, setActiveSession, workspace.id]);
  const create = useCallback(async (kind: SessionKind, pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`): Promise<void> => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateMenu(false);
    const name = pendingName(kind);
    setPendingSessions((items) => items.some((item) => item.id === pendingId)
      ? items.map((item) => item.id === pendingId ? { ...item, status: "creating", error: undefined } : item)
      : [...items, { id: pendingId, workspaceId: workspace.id, kind, name, status: "creating" }]);
    setActiveSession(workspace.id, pendingId);
    try {
      const result = await window.desktop.createSession({ workspaceId: workspace.id, kind });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      setPendingSessions((items) => items.filter((item) => item.id !== pendingId));
      setActiveSession(workspace.id, result.session.id);
      if (result.warning) toast.warning(result.warning);
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingSessions((items) => items.map((item) => item.id === pendingId ? { ...item, status: "failed", error: message } : item));
      setActiveSession(workspace.id, pendingId);
      toast.error(message);
    }
    finally { creatingRef.current = false; setCreating(false); }
  }, [client, setActiveSession, workspace.id]);
  useEffect(() => {
    for (const request of sessionCreateRequests.filter((item) => item.workspaceId === workspace.id)) {
      acknowledgeSessionCreateRequest(request.id);
      void create(request.kind);
    }
  }, [acknowledgeSessionCreateRequest, create, sessionCreateRequests, workspace.id]);
  const close = async (sessionId: string): Promise<void> => {
    const session = sessions.find((item) => item.id === sessionId);
    let force = false;
    if (session?.kind === "tmux" && session.status === "running" && session.activityStatus === "busy") {
      const resource = sessions.some((item) => item.id !== session.id && item.kind === "tmux") ? "window" : "session";
      force = confirm(`“${session.name}” is running a task.\n\nClosing it will stop the task and delete its tmux ${resource}. Continue?`);
      if (!force) return;
    }
    try { await window.desktop.killSession(sessionId, force); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!force && message.includes("This tmux terminal is running a task") && confirm(`${message}\n\nContinue?`)) {
        try { await window.desktop.killSession(sessionId, true); }
        catch (retryError) { toast.error(retryError instanceof Error ? retryError.message : String(retryError)); }
      } else toast.error(message);
    }
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
        <div className="terminal-tab-scroll">{sessions.map((session) => <div key={session.id} role="button" tabIndex={0} draggable className={`terminal-tab ${active?.id === session.id ? "active" : ""} ${session.resultUnread ? "unread" : ""}`} onDragStart={(event) => { setDraggingId(session.id); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (draggingId) event.preventDefault(); }} onDrop={() => void reorder(session.id)} onDragEnd={() => setDraggingId(null)} onClick={() => setActiveSession(workspace.id, session.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setActiveSession(workspace.id, session.id); }}>{sessionIcon(session.kind)}{editingId === session.id ? <input className="terminal-tab-name-input" value={draftName} onChange={(event) => setDraftName(event.target.value)} onClick={(event) => event.stopPropagation()} onBlur={() => void saveRename()} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(); if (event.key === "Escape") { setEditingId(null); setDraftName(""); } }} autoFocus maxLength={80} required /> : <span onDoubleClick={(event) => { event.stopPropagation(); beginRename(session); }}>{session.name}</span>}<i className={session.status === "running" ? session.activityStatus ?? "running" : session.status} />{active?.id === session.id && <button type="button" className="tab-close" title="Close terminal" onClick={(event) => { event.stopPropagation(); void close(session.id); }}><X size={12} /></button>}</div>)}{pendingForWorkspace.map((pending) => <div key={pending.id} role="button" tabIndex={0} className={`terminal-tab pending ${active?.id === pending.id ? "active" : ""}`} onClick={() => setActiveSession(workspace.id, pending.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setActiveSession(workspace.id, pending.id); }}>{sessionIcon(pending.kind)}<span>{pending.name}</span><i className={pending.status} />{active?.id === pending.id && <button type="button" className="tab-close" title="Close terminal" onClick={(event) => { event.stopPropagation(); closePending(pending.id); }}><X size={12} /></button>}</div>)}</div>
        <div ref={createMenuAnchor} className="terminal-add-menu">
          <button className="icon-button terminal-add" disabled={creating} onClick={() => setCreateMenu(!createMenu)} title="New terminal"><Plus size={15} /></button>
          {createMenu && <div className="terminal-kind-menu"><button disabled={creating} onClick={() => void create("shell")}><TerminalSquare size={14} /> Terminal</button><button disabled={creating} onClick={() => void create("codex")}><Bot size={14} /> Codex</button><button disabled={creating} onClick={() => void create("tmux")}><Layers3 size={14} /> tmux</button></div>}
        </div>
      </div>
      <div className="terminal-stage">{sessions.length + pendingForWorkspace.length > 0 ? <>{sessions.map((session) => <TerminalView key={session.id} session={session} active={visible && active?.id === session.id} resuming={resumingId === session.id} onResume={() => void resume(session.id)} onCreate={(kind) => void create(kind)} />)}{pendingForWorkspace.map((pending) => <PendingTerminalView key={pending.id} pending={pending} active={visible && active?.id === pending.id} onRetry={() => void create(pending.kind, pending.id)} onClose={() => closePending(pending.id)} />)}</> : <div className="terminal-empty"><TerminalSquare size={30} /><h3>No terminal sessions</h3><div className="terminal-empty-actions"><button className="button primary" disabled={creating} onClick={() => void create("shell")}><Plus size={14} /> {creating ? "Creating…" : "Terminal"}</button><button className="button" disabled={creating} onClick={() => void create("codex")}><Bot size={14} /> Codex</button><button className="button" disabled={creating} onClick={() => void create("tmux")}><Layers3 size={14} /> tmux</button></div></div>}</div>
    </section>
  );
}
