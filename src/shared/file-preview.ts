import type { PreviewFileType } from "./domain";

export const MAX_PREVIEW_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024;
export function previewFileType(path: string): PreviewFileType | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "pdf") return "pdf";
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "md" || extension === "markdown") return "markdown";
  return undefined;
}
