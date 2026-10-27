import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { WorkspaceService } from "../application/workspace-service";
import { MAX_PREVIEW_FILE_BYTES, MAX_PREVIEW_TEXT_BYTES } from "../../shared/file-preview";

type DownloadSource = Pick<WorkspaceService, "snapshot" | "workspaceFiles"> & {
  on(event: "changed", listener: () => void): unknown;
  off(event: "changed", listener: () => void): unknown;
};

/** Only the app's save dialog supplies destinations; preview pages never receive this capability. */
export class FilePreviewDownloader {
  private pending = new Set<string>();

  constructor(private readonly service: DownloadSource) {}

  async download(id: string, chooseDestination: (name: string) => Promise<string | null>, signal?: AbortSignal): Promise<boolean> {
    const tab = this.service.snapshot().filePreviewTabs.find((item) => item.id === id);
    if (!tab) throw new Error("File preview no longer exists");
    if (this.pending.has(id)) throw new Error("This file is already being downloaded");
    this.pending.add(id);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const reconcile = (): void => {
      const snapshot = this.service.snapshot();
      const current = snapshot.filePreviewTabs.find((item) => item.id === id);
      if (!current || current.path !== tab.path || current.workspaceId !== tab.workspaceId || current.fileType !== tab.fileType
        || !snapshot.workspaces.some((workspace) => workspace.id === tab.workspaceId)) abort();
    };
    this.service.on("changed", reconcile);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let temporary: string | undefined;
    let cancelDialog: (() => void) | undefined;
    try {
      if (controller.signal.aborted) return false;
      // A native save sheet may outlive its owner; cancellation must not wait for its result.
      const cancelled = new Promise<null>((resolve) => {
        cancelDialog = () => resolve(null);
        controller.signal.addEventListener("abort", cancelDialog, { once: true });
      });
      const destination = await Promise.race([chooseDestination(basename(tab.path)), cancelled]);
      reconcile();
      if (!destination || controller.signal.aborted) return false;
      const maxBytes = tab.fileType === "pdf" ? MAX_PREVIEW_FILE_BYTES : MAX_PREVIEW_TEXT_BYTES;
      const bytes = await this.service.workspaceFiles(tab.workspaceId).read(tab.path, maxBytes, controller.signal);
      reconcile();
      if (controller.signal.aborted) return false;
      // Stage beside the destination so failures never truncate an existing file.
      temporary = await mkdtemp(join(dirname(destination), ".superthread-download-"));
      const staged = join(temporary, "file");
      await writeFile(staged, bytes, { flag: "wx", mode: 0o600, signal: controller.signal });
      reconcile();
      if (controller.signal.aborted) return false;
      await rename(staged, destination);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      throw error;
    } finally {
      this.pending.delete(id);
      this.service.off("changed", reconcile);
      signal?.removeEventListener("abort", abort);
      if (cancelDialog) controller.signal.removeEventListener("abort", cancelDialog);
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
}
