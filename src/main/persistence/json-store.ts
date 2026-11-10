import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppSnapshot, Project, Session, Workspace, WorkThread } from "../../shared/domain";
import { CURRENT_SCHEMA_VERSION, emptySnapshot } from "../../shared/domain";
import { appSettingsSchema } from "../../shared/contract";
import { canonicalProjectCode, projectCodeSchema, repositoryCodeFromUrl } from "../../shared/project-code";

export class JsonStore {
  private writes: Promise<unknown> = Promise.resolve();
  private data: AppSnapshot = emptySnapshot();

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppSnapshot> {
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8")) as StoredSnapshot;
      this.data = migrateSnapshot(stored);
      if (stored.schemaVersion !== CURRENT_SCHEMA_VERSION) await this.save(this.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save(this.data);
    }
    return this.snapshot();
  }

  snapshot(): AppSnapshot {
    return structuredClone(this.data);
  }

  update(mutator: (draft: AppSnapshot) => void): Promise<AppSnapshot> {
    // Autosave and runtime updates must mutate the latest committed snapshot in order.
    const write = this.writes.then(async () => {
      const next = this.snapshot();
      mutator(next);
      await this.save(next);
      this.data = next;
      return this.snapshot();
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private async save(data: AppSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

type StoredSession = Omit<Session, "kind"> & {
  kind?: string;
  tmuxSessionName?: string; tmuxClientSessionName?: string; tmuxWindowKey?: string; tmuxWindowName?: string;
  fallbackMessage?: string;
};
type StoredProject = Omit<Project, "code"> & { code?: string };
type StoredSnapshot = Omit<Partial<AppSnapshot>, "sessions" | "projects"> & { sessions?: StoredSession[]; projects?: StoredProject[] };

function migrateSnapshot(stored: StoredSnapshot): AppSnapshot {
  const base = emptySnapshot();
  const storedSessions: StoredSession[] = stored.sessions ?? base.sessions;
  const tmuxSessionNames = new Map(storedSessions
    .filter((session) => session.kind === "tmux" && session.tmuxSessionName)
    .map((session) => [session.workspaceId, session.tmuxSessionName!]));
  const data: AppSnapshot = {
    ...base,
    ...stored,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    settings: appSettingsSchema.parse({ ...base.settings, ...stored.settings }),
    workThreads: (stored.workThreads ?? base.workThreads).map(normalizeWorkThread),
    projects: migrateProjects(stored.projects ?? []),
    devices: stored.devices ?? base.devices,
    connections: stored.connections ?? base.connections,
    checkouts: stored.checkouts ?? base.checkouts,
    workspaces: (stored.workspaces ?? base.workspaces).map((workspace) => normalizeWorkspace(workspace, tmuxSessionNames.get(workspace.id))),
    browserTabs: stored.browserTabs ?? [],
    filePreviewTabs: stored.filePreviewTabs ?? [],
    sessions: storedSessions.filter((session) => session.kind !== "tmux").map(normalizeSession)
  };
  if ((stored.schemaVersion ?? 0) < 11) {
    for (const workspace of data.workspaces) {
      data.sessions.filter((session) => session.workspaceId === workspace.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .forEach((session, index) => { session.order = index; });
    }
  }
  return data;
}

function migrateProjects(projects: StoredProject[]): Project[] {
  // Reserve explicit codes first so legacy backfills cannot take an existing code.
  const reserved = new Set(projects.flatMap((project) => {
    const parsed = projectCodeSchema.safeParse(project.code);
    return parsed.success ? [canonicalProjectCode(parsed.data)] : [];
  }));
  const assigned = new Set<string>();
  return projects.map((project) => {
    const parsed = projectCodeSchema.safeParse(project.code);
    let code: string;
    if (parsed.success && !assigned.has(canonicalProjectCode(parsed.data))) {
      code = parsed.data;
    } else {
      const source = parsed.success ? parsed.data : (project.repositoryUrl ? repositoryCodeFromUrl(project.repositoryUrl) : "") || project.name;
      const candidate = source.trim().replace(/[\\/\u0000-\u001f\u007f]/g, "-").slice(0, 80).trim();
      const base = projectCodeSchema.safeParse(candidate).success ? candidate : "project";
      code = base;
      for (let suffix = 2; reserved.has(canonicalProjectCode(code)) || assigned.has(canonicalProjectCode(code)); suffix += 1) {
        const ending = `-${suffix}`;
        code = `${base.slice(0, 80 - ending.length)}${ending}`;
      }
    }
    assigned.add(canonicalProjectCode(code));
    return { ...project, code };
  });
}

function normalizeWorkspace(workspace: Workspace, legacyTmuxSessionName?: string): Workspace {
  return { ...workspace, kind: workspace.kind ?? "worktree", tmuxSessionName: workspace.tmuxSessionName ?? legacyTmuxSessionName };
}

/** Legacy persisted threads may carry a priority ("high" | "normal" | "low") instead of pinned. */
type StoredWorkThread = Omit<WorkThread, "pinned"> & { pinned?: boolean; priority?: unknown };

function normalizeWorkThread(workThread: StoredWorkThread): WorkThread {
  const { priority, ...rest } = workThread;
  return {
    ...rest,
    pinned: rest.pinned ?? priority === "high",
    sidebarOrder: Number.isSafeInteger(rest.sidebarOrder) && rest.sidebarOrder! >= 0 ? rest.sidebarOrder : undefined,
    document: workThread.document ?? "",
    todos: workThread.todos ?? []
  };
}

function normalizeSession(session: StoredSession): Session {
  const { codexResultUnread, fallbackMessage: _fallback,
    tmuxSessionName: _tmux, tmuxClientSessionName: _client, tmuxWindowKey: _key, tmuxWindowName: _window,
    kind, ...current } = session;
  const resultUnread = current.resultUnread ?? codexResultUnread;
  return {
    kind: "shell",
    order: 0,
    cwd: undefined,
    ...current,
    // Keep the tab and cwd, but never auto-launch removed managed tools.
    ...(kind === "codex" ? { status: "exited" as const, pid: undefined, shell: "shell", exitReason: "runtime-stopped" as const, restoreError: undefined } : {}),
    activityStatus: kind !== "codex" && session.status === "running" ? resultUnread ? "waiting-input" : current.activityStatus ?? "idle" : undefined,
    resultUnread
  };
}
