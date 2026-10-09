import { BrowserPane } from "./BrowserPane";
import { FitAddon } from "@xterm/addon-fit";
import { useQueryClient } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { AlertTriangle, Globe, Bot, LoaderCircle, Plus, RotateCcw, TerminalSquare, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppSnapshot, ManagedSessionKind, Session, SessionKind, TerminalOutput, Workspace } from "@/shared/domain";
import { useWorkbenchStore } from "../../../state/workbench-store";
import { terminalInputForKeyEvent } from "../terminal-keyboard";
import { CustomTerminalDialog } from "./CustomTerminalDialog";

interface PendingSession {
  id: string;
  workspaceId: string;
  kind: ManagedSessionKind;
  name: string;
  status: "creating" | "failed";
  error?: string;
  terminalPresetId?: string;
}

const pendingName = (kind: ManagedSessionKind): string => {
  if (kind === "codex") return "Codex";
  return "Terminal";
};

const sessionIcon = (kind?: SessionKind, size = 13): React.ReactNode => (
  kind === "codex" ? <Bot size={size} /> : <TerminalSquare size={size} />
);

function TerminalView({ session, active, resuming, onResume, onCreate }: { session: Session; active: boolean; resuming: boolean; onResume: () => void; onCreate: (kind: ManagedSessionKind) => void }): React.ReactNode {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  useEffect(() => {
    if (!container.current || session.status !== "running") return;
    const terminal = new Terminal({
      cursorBlink: true, fontFamily: '"SFMono-Regular", "SF Mono", Menlo, monospace', fontSize: 12.5, lineHeight: 1.25,
      theme: { background: "#121211", foreground: "#dedbd6", cursor: "#d6a861", selectionBackground: "#4a4137", black: "#232220", brightBlack: "#6f6b65", red: "#d16d67", green: "#87a968", yellow: "#d6a861", blue: "#7196c9", magenta: "#ad7eb7", cyan: "#6ca6a1", white: "#dedbd6" },
      macOptionClickForcesSelection: true,
      allowProposedApi: false, scrollback: 10_000
    });
    const copySelection = (): void => {
      const text = terminal.getSelection();
      if (text) void window.desktop.writeClipboard(text).catch(() => toast.error("Could not copy terminal selection."));
    };
    const copy = (event: ClipboardEvent): void => {
      if (!terminal.hasSelection()) return;
      event.preventDefault();
      event.stopPropagation();
      copySelection();
    };
    // Native menu Copy and keyboard Copy must use xterm's buffer selection,
    // including alternate-screen applications whose input textarea is empty.
    container.current.addEventListener("copy", copy, true);
    const host = container.current;
    const fit = new FitAddon();
    terminal.attachCustomKeyEventHandler((event) => {
      if (terminal.hasSelection() && event.key.toLowerCase() === "c" && !event.altKey
        && (window.desktop.platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey)) {
        if (event.type === "keydown") { event.preventDefault(); copySelection(); }
        return false;
      }
      const input = terminalInputForKeyEvent(session.kind, event);
      if (input === undefined) return true;
      event.preventDefault();
      void window.desktop.writeSession(session.id, input);
      return false;
    });
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
      host.removeEventListener("copy", copy, true);
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
  if (session.status === "exited" || session.status === "restore-failed") {
    const replacementKind: ManagedSessionKind = session.kind === "codex" ? "codex" : "shell";
    return <div className={`terminal-view terminal-exited ${active ? "active" : ""}`} aria-hidden={!active}>{sessionIcon(session.kind, 28)}<h3>{session.status === "restore-failed" ? "Restore failed" : "Session exited"}</h3><p>{session.restoreError || "The workspace is intact. Resume this session to continue."}</p><div className="terminal-empty-actions"><button className="button primary" disabled={resuming} onClick={onResume}><RotateCcw size={14} /> {resuming ? "Resuming…" : "Resume"}</button>{session.status === "restore-failed" && <button className="button" onClick={() => onCreate(replacementKind)}><Plus size={14} /> New {pendingName(replacementKind)}</button>}</div></div>;
  }
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
  const [commandHeld, setCommandHeld] = useState(false);
  const dialog = useWorkbenchStore((state) => state.dialog);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [createMenu, setCreateMenu] = useState(false);
  const [customDialog, setCustomDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingSessions, setPendingSessions] = useState<PendingSession[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const createMenuAnchor = useRef<HTMLDivElement>(null);
  const creatingRef = useRef(false);
  const device = snapshot.devices.find((item) => item.id === workspace.deviceId);
  const terminalPresets = device?.terminalPresets ?? [];
  const sessions = useMemo(() => snapshot.sessions.filter((item) => item.workspaceId === workspace.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [snapshot.sessions, workspace.id]);
  const browsers = useMemo(() => (snapshot.browserTabs ?? []).filter((tab) => tab.workspaceId === workspace.id), [snapshot.browserTabs, workspace.id]);
  const tabs = useMemo(() => [...sessions, ...browsers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [sessions, browsers]);
  const pendingForWorkspace = useMemo(() => pendingSessions.filter((item) => item.workspaceId === workspace.id), [pendingSessions, workspace.id]);
  const shortcutTabs = [...tabs, ...pendingForWorkspace];
  const shortcutsEnabled = visible && !dialog && !customDialog;
  useEffect(() => {
    if (!visible) return;
    window.desktop.setWorkspaceShortcutCount(shortcutsEnabled ? Math.min(shortcutTabs.length, 9) : 0);
    return () => window.desktop.setWorkspaceShortcutCount(0);
  }, [visible, shortcutsEnabled, shortcutTabs.length]);
  useEffect(() => {
    if (!shortcutsEnabled) { setCommandHeld(false); return; }
    const unsubscribe = window.desktop.onWorkspaceShortcut((shortcut) => {
      setCommandHeld(shortcut.commandHeld);
      const target = shortcut.tabIndex === undefined ? undefined : shortcutTabs[shortcut.tabIndex];
      if (target) setActiveSession(workspace.id, target.id);
    });
    const clear = (): void => setCommandHeld(false);
    window.addEventListener("blur", clear);
    return () => { unsubscribe(); window.removeEventListener("blur", clear); };
  }, [shortcutsEnabled, tabs, pendingForWorkspace, workspace.id, setActiveSession]);
  const shortcutHint = (index: number): React.ReactNode => commandHeld && index < 9
    ? <kbd className="workspace-shortcut-hint" aria-label={`Command ${index + 1}`}>⌘{index + 1}</kbd> : null;
  const activeSessionId = activeSessionIds[workspace.id];
  const activeStoredSession = sessions.find((item) => item.id === activeSessionId);
  const active = tabs.find((item) => item.id === activeSessionId) ?? pendingForWorkspace.find((item) => item.id === activeSessionId) ?? sessions.find((item) => item.status === "running") ?? pendingForWorkspace[0] ?? tabs[0];
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
    if (!visible) { setCreateMenu(false); setCustomDialog(false); }
  }, [visible]);
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
  const create = useCallback(async (kind: ManagedSessionKind, pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`, terminalPresetId?: string): Promise<void> => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateMenu(false);
    const name = terminalPresets.find((preset) => preset.id === terminalPresetId)?.name ?? pendingName(kind);
    setPendingSessions((items) => items.some((item) => item.id === pendingId)
      ? items.map((item) => item.id === pendingId ? { ...item, status: "creating", error: undefined } : item)
      : [...items, { id: pendingId, workspaceId: workspace.id, kind, name, terminalPresetId, status: "creating" }]);
    setActiveSession(workspace.id, pendingId);
    try {
      const result = await window.desktop.createSession({ workspaceId: workspace.id, kind, terminalPresetId });
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
  }, [client, setActiveSession, workspace.id, device?.terminalPresets]);
  useEffect(() => {
    for (const request of sessionCreateRequests.filter((item) => item.workspaceId === workspace.id)) {
      acknowledgeSessionCreateRequest(request.id);
      void create(request.kind);
    }
  }, [acknowledgeSessionCreateRequest, create, sessionCreateRequests, workspace.id]);
  const close = async (sessionId: string): Promise<void> => {
    try { await window.desktop.killSession(sessionId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
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
    const ids = tabs.map((session) => session.id);
    const from = ids.indexOf(draggingId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    if (!moved) return;
    ids.splice(to, 0, moved);
    try { await window.desktop.reorderWorkspaceTabs({ workspaceId: workspace.id, tabIds: ids }); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  };
  const createBrowser = async (): Promise<void> => {
    setCreateMenu(false);
    try {
      const tab = await window.desktop.createBrowser({ workspaceId: workspace.id });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      setActiveSession(workspace.id, tab.id);
    } catch (error) { toast.error(String(error)); }
  };
  return (
    <section className="terminal-pane">
      <div className="terminal-tabs no-drag">
        <div className="terminal-tab-scroll">{tabs.map((session, index) => "url" in session ? <div key={session.id} role="button" tabIndex={0} draggable className={`terminal-tab ${active?.id === session.id ? "active" : ""}`} onDragStart={(event) => { setDraggingId(session.id); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (draggingId) event.preventDefault(); }} onDrop={() => void reorder(session.id)} onDragEnd={() => setDraggingId(null)} onClick={() => setActiveSession(workspace.id, session.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setActiveSession(workspace.id, session.id); }} title={session.url || "Browser"}><Globe size={13} /><span>{session.title}</span>{shortcutHint(index)}{active?.id === session.id && <button type="button" className="tab-close" title="Close browser" onClick={(event) => { event.stopPropagation(); void window.desktop.closeBrowser(session.id).catch((error) => toast.error(String(error))); }}><X size={12} /></button>}</div> : <div key={session.id} role="button" tabIndex={0} draggable className={`terminal-tab ${active?.id === session.id ? "active" : ""} ${session.resultUnread ? "unread" : ""}`} onDragStart={(event) => { setDraggingId(session.id); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (draggingId) event.preventDefault(); }} onDrop={() => void reorder(session.id)} onDragEnd={() => setDraggingId(null)} onClick={() => setActiveSession(workspace.id, session.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setActiveSession(workspace.id, session.id); }}>{sessionIcon(session.kind)}{editingId === session.id ? <input className="terminal-tab-name-input" value={draftName} onChange={(event) => setDraftName(event.target.value)} onClick={(event) => event.stopPropagation()} onBlur={() => void saveRename()} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(); if (event.key === "Escape") { setEditingId(null); setDraftName(""); } }} autoFocus maxLength={80} required /> : <span onDoubleClick={(event) => { event.stopPropagation(); beginRename(session); }}>{session.name}</span>}{shortcutHint(index)}<i className={session.status === "running" ? session.activityStatus ?? "running" : session.status} />{active?.id === session.id && <button type="button" className="tab-close" title="Close terminal" onClick={(event) => { event.stopPropagation(); void close(session.id); }}><X size={12} /></button>}</div>)}{pendingForWorkspace.map((pending, index) => <div key={pending.id} role="button" tabIndex={0} className={`terminal-tab pending ${active?.id === pending.id ? "active" : ""}`} onClick={() => setActiveSession(workspace.id, pending.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setActiveSession(workspace.id, pending.id); }}>{sessionIcon(pending.kind)}<span>{pending.name}</span>{shortcutHint(tabs.length + index)}<i className={pending.status} />{active?.id === pending.id && <button type="button" className="tab-close" title="Close terminal" onClick={(event) => { event.stopPropagation(); closePending(pending.id); }}><X size={12} /></button>}</div>)}</div>
        <div ref={createMenuAnchor} className="terminal-add-menu">
          <button className="icon-button terminal-add" disabled={creating} onClick={() => setCreateMenu(!createMenu)} title="New tab"><Plus size={15} /></button>
          {createMenu && <div className="terminal-kind-menu"><button onClick={() => void createBrowser()}><Globe size={14} /> Browser</button><button disabled={creating} onClick={() => void create("shell")}><TerminalSquare size={14} /> Terminal</button><button disabled={creating} onClick={() => void create("codex")}><Bot size={14} /> Codex</button><div className="context-menu-separator" />{terminalPresets.map((preset) => <button key={preset.id} disabled={creating} title={preset.path} onClick={() => void create("shell", undefined, preset.id)}><TerminalSquare size={14} /><span>{preset.name}</span></button>)}<button disabled={creating || !device} onClick={() => { setCreateMenu(false); setCustomDialog(true); }}><Plus size={14} /> Custom…</button></div>}
        </div>
      </div>
      <div className="terminal-stage">{visible && active && "url" in active && <BrowserPane key={active.id} tab={active} />}{tabs.length + pendingForWorkspace.length > 0 ? <>{sessions.map((session) => <TerminalView key={session.id} session={session} active={visible && active?.id === session.id} resuming={resumingId === session.id} onResume={() => void resume(session.id)} onCreate={(kind) => void create(kind)} />)}{pendingForWorkspace.map((pending) => <PendingTerminalView key={pending.id} pending={pending} active={visible && active?.id === pending.id} onRetry={() => void create(pending.kind, pending.id, pending.terminalPresetId)} onClose={() => closePending(pending.id)} />)}</> : <div className="terminal-empty"><TerminalSquare size={30} /><h3>No terminal sessions</h3><div className="terminal-empty-actions"><button className="button primary" disabled={creating} onClick={() => void create("shell")}><Plus size={14} /> {creating ? "Creating…" : "Terminal"}</button><button className="button" disabled={creating} onClick={() => void create("codex")}><Bot size={14} /> Codex</button></div></div>}</div>
      {customDialog && device && <CustomTerminalDialog device={device} onClose={() => setCustomDialog(false)} />}
    </section>
  );
}
