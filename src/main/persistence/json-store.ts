import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppSnapshot, Session } from "../../shared/domain";
import { CURRENT_SCHEMA_VERSION, emptySnapshot } from "../../shared/domain";

export class JsonStore {
  private data: AppSnapshot = emptySnapshot();

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppSnapshot> {
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AppSnapshot>;
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

  async update(mutator: (draft: AppSnapshot) => void): Promise<AppSnapshot> {
    const next = this.snapshot();
    mutator(next);
    await this.save(next);
    this.data = next;
    return this.snapshot();
  }

  private async save(data: AppSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

function migrateSnapshot(stored: Partial<AppSnapshot>): AppSnapshot {
  const base = emptySnapshot();
  const data: AppSnapshot = {
    ...base,
    ...stored,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workThreads: stored.workThreads ?? base.workThreads,
    projects: stored.projects ?? base.projects,
    devices: stored.devices ?? base.devices,
    connections: stored.connections ?? base.connections,
    checkouts: stored.checkouts ?? base.checkouts,
    workspaces: stored.workspaces ?? base.workspaces,
    sessions: (stored.sessions ?? base.sessions).map(normalizeSession)
  };
  return data;
}

function normalizeSession(session: Session): Session {
  const { codexResultUnread, ...current } = session;
  const resultUnread = current.resultUnread ?? codexResultUnread;
  return {
    kind: "shell",
    order: 0,
    cwd: undefined,
    ...current,
    activityStatus: session.status === "running" ? resultUnread ? "waiting-input" : current.activityStatus ?? "idle" : undefined,
    resultUnread
  };
}
