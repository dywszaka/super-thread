import type { BrowserLayoutInput } from "../../../../shared/domain";

interface PresentationEffects {
  layout(input: BrowserLayoutInput): Promise<void>;
  prepareSnapshot(id: string): Promise<string | null>;
  showSnapshot(image: string | null): void;
  painted(): Promise<void>;
}

/** Hand off native content to a painted renderer snapshot before an overlay covers it. */
export class NativePanePresentation {
  private generation = 0;
  private last = "";
  private snapshot: Promise<string | null> | null = null;
  private disposed = false;

  constructor(private readonly effects: PresentationEffects) {}

  async update(input: BrowserLayoutInput, covered: boolean): Promise<void> {
    if (this.disposed) return;
    const key = JSON.stringify({ input, covered });
    if (this.last === key) return;
    this.last = key;
    const generation = ++this.generation;
    const current = (): boolean => !this.disposed && generation === this.generation;
    if (input.id && covered) {
      // Reuse one capture through mutations/resizes while the overlay remains open.
      this.snapshot ??= this.effects.prepareSnapshot(input.id).catch(() => null);
      const image = await this.snapshot;
      if (!current()) return;
      this.effects.showSnapshot(image);
      await this.effects.painted();
      if (current()) await this.effects.layout({ ...input, id: null });
    } else {
      this.snapshot = null;
      // Keep the snapshot until the live surface has been restored.
      await this.effects.layout(input);
      if (current()) this.effects.showSnapshot(null);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.snapshot = null;
    this.effects.showSnapshot(null);
    void this.effects.layout({ id: null, bounds: { x: 0, y: 0, width: 0, height: 0 } }).catch(() => {});
  }
}
