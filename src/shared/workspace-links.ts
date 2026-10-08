/** Link paths are relative to the base checkout and keep their relative names. */
export function isWorkspaceLinkPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !path.includes("\0")
    && !path.includes("\\") && path.split("/").every((part) =>
      part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}
