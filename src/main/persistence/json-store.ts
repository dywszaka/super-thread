import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppSnapshot } from "../../shared/domain";
import { emptySnapshot } from "../../shared/domain";

export class JsonStore {
  private data: AppSnapshot = emptySnapshot();

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppSnapshot> {
    try {
      this.data = JSON.parse(await readFile(this.filePath, "utf8")) as AppSnapshot;
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
