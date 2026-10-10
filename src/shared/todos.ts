import type { Todo, WorkThread } from "./domain";

export function localTodoDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function visibleThreadTodos(todos: readonly Todo[], now = Date.now()): Todo[] {
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  return todos.filter((todo) => !todo.completedAt || Date.parse(todo.completedAt) >= cutoff);
}

export function todoEntries(threads: readonly WorkThread[], recentOnly = false, now = Date.now()): Array<{ thread: WorkThread; todo: Todo }> {
  return threads.flatMap((thread) => (recentOnly ? visibleThreadTodos(thread.todos ?? [], now) : thread.todos ?? [])
    .map((todo) => ({ thread, todo })))
    .sort((a, b) => a.todo.date.localeCompare(b.todo.date) || b.todo.createdAt.localeCompare(a.todo.createdAt) || a.todo.id.localeCompare(b.todo.id));
}
