import { ListTodo, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AppSnapshot, Todo, WorkThread } from "@/shared/domain";
import { localTodoDate, todoEntries } from "@/shared/todos";
import { SidebarReopenButton } from "./Sidebar";

export function AllTodos({ snapshot }: { snapshot: AppSnapshot }): React.ReactNode {
  return <main className="work-thread-page">
    <header className="work-thread-page-header drag"><SidebarReopenButton /><div><h1>All todos</h1><p>Every TODO, including archived work threads and completed history.</p></div></header>
    <TodoList threads={snapshot.workThreads} />
  </main>;
}

export function TodoList({ threads, recentOnly = false }: { threads: WorkThread[]; recentOnly?: boolean }): React.ReactNode {
  const client = useQueryClient();
  const [clock, setClock] = useState(Date.now());
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(localTodoDate());
  const [threadId, setThreadId] = useState(threads[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const mutationBusy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const refresh = (): void => setClock(Date.now());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  const selectedThread = threads.some((thread) => thread.id === threadId) ? threadId : threads[0]?.id ?? "";
  const entries = todoEntries(threads, recentOnly, clock);
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    if (mutationBusy.current) return false;
    mutationBusy.current = true;
    setBusy(true);
    try {
      await action();
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      setClock(Date.now());
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error));
      return false;
    } finally { mutationBusy.current = false; setBusy(false); }
  };
  return <section className="todo-pane no-drag" aria-label="Todos">
    <form className="todo-create" onSubmit={(event) => {
      event.preventDefault();
      void run(() => window.desktop.createTodo({ workThreadId: selectedThread, title, date })).then((saved) => {
        if (saved) { setTitle(""); input.current?.focus(); }
      });
    }}>
      {threads.length !== 1 && <select aria-label="TODO work thread" value={selectedThread} disabled={busy || !threads.length} onChange={(event) => setThreadId(event.target.value)}>
        {!threads.length && <option value="">No work threads</option>}
        {threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.name}{thread.status === "archived" ? " (Archived)" : ""}</option>)}
      </select>}
      <input ref={input} aria-label="New TODO" placeholder="Add a TODO…" maxLength={500} required value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
      <input aria-label="TODO date" type="date" required value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} />
      <button className="button primary" disabled={busy || !selectedThread || !title.trim()}><Plus size={14} /> Add</button>
    </form>
    {recentOnly && <p className="todo-hint">All incomplete TODOs · Completed in the last 7 days</p>}
    {!threads.length && <p className="todo-hint">Create a work thread to add your first TODO.</p>}
    {[false, true].map((completed) => {
      const group = entries.filter(({ todo }) => Boolean(todo.completedAt) === completed);
      const dates = [...new Set(group.map(({ todo }) => todo.date))];
      return <section className="todo-status-group" key={String(completed)} aria-label={completed ? "Completed todos" : "Incomplete todos"}>
        <h2><ListTodo size={15} /> {completed ? "Completed" : "Incomplete"}<span>{group.length}</span></h2>
        {!group.length && <p className="todo-hint">{completed ? "No completed TODOs" : "No incomplete TODOs"}</p>}
        {dates.map((day) => <div className="todo-date-group" key={day}><h3><time dateTime={day}>{day}{day === localTodoDate(new Date(clock)) ? " · Today" : ""}</time></h3>
          {group.filter(({ todo }) => todo.date === day).map(({ thread, todo }) => <TodoRow key={todo.id} todo={todo} thread={thread} showThread={!recentOnly} busy={busy} run={run} />)}
        </div>)}
      </section>;
    })}
  </section>;
}

function TodoRow({ todo, thread, showThread, busy, run }: { todo: Todo; thread: WorkThread; showThread: boolean; busy: boolean; run(action: () => Promise<void>): Promise<boolean> }): React.ReactNode {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(todo.title);
  const [date, setDate] = useState(todo.date);
  const target = { workThreadId: thread.id, id: todo.id };
  if (editing) return <form className="todo-row todo-edit" onSubmit={(event) => {
    event.preventDefault();
    void run(() => window.desktop.updateTodo({ ...target, title, date })).then((saved) => { if (saved) setEditing(false); });
  }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); } }}>
    <input aria-label="Edit TODO title" autoFocus required maxLength={500} value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
    <input aria-label="Edit TODO date" type="date" required value={date} disabled={busy} onChange={(event) => setDate(event.target.value)} />
    <button className="button" disabled={busy || !title.trim()}>Save</button><button type="button" className="icon-button" aria-label="Cancel TODO edit" onClick={() => setEditing(false)}><X size={14} /></button>
  </form>;
  return <div className={`todo-row ${todo.completedAt ? "completed" : ""}`}>
    <input type="checkbox" aria-label={`${todo.completedAt ? "Reopen" : "Complete"} ${todo.title}`} checked={Boolean(todo.completedAt)} disabled={busy} onChange={(event) => void run(() => window.desktop.updateTodo({ ...target, completed: event.target.checked }))} />
    <div className="todo-copy"><span className="todo-title selectable">{todo.title}</span><small>{showThread && <span>{thread.name}{thread.status === "archived" ? " · Archived" : ""}</span>}{todo.completedAt && <span>Completed <time dateTime={todo.completedAt}>{new Date(todo.completedAt).toLocaleString()}</time></span>}</small></div>
    <button className="icon-button" disabled={busy} aria-label={`Edit ${todo.title}`} onClick={() => { setTitle(todo.title); setDate(todo.date); setEditing(true); }}><Pencil size={14} /></button>
    <button className="icon-button danger-button" disabled={busy} aria-label={`Delete ${todo.title}`} onClick={() => {
      if (confirm(`Delete TODO “${todo.title}”?`)) void run(() => window.desktop.deleteTodo(target));
    }}><Trash2 size={14} /></button>
  </div>;
}
