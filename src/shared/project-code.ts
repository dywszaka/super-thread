import { z } from "zod";
import type { Project } from "./domain";

export const projectCodeSchema = z.string().trim()
  .min(1, "Project code is required")
  .max(80, "Project code must be 80 characters or fewer")
  .refine((value) => value !== "." && value !== "..", "Project code cannot be . or ..")
  .refine((value) => !/[\\/\u0000-\u001f\u007f]/.test(value), "Project code cannot contain path separators or control characters");

export const canonicalProjectCode = (code: string): string => code.normalize("NFC").toLowerCase();

export function projectCodeError(code: string, projects: readonly Project[], excludeId?: string): string | undefined {
  const parsed = projectCodeSchema.safeParse(code);
  if (!parsed.success) return parsed.error.issues[0]?.message;
  if (projects.some((project) => project.id !== excludeId && canonicalProjectCode(project.code) === canonicalProjectCode(parsed.data))) {
    return `Project code ${parsed.data} already exists`;
  }
  return undefined;
}

export function repositoryCodeFromUrl(repositoryUrl: string): string {
  return repositoryUrl.trim().split(/[?#]/)[0]!.replace(/\/+$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/i, "") ?? "";
}
