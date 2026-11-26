import { z } from "zod";

export type GitHostingProvider = "github" | "gitlab";
export interface GitHostingConnection {
  id: string;
  provider: GitHostingProvider;
  baseUrl: string;
  username: string;
  verifiedAt: string;
}
export interface GitHostingFailure {
  code: "authentication" | "permission" | "network" | "rate-limit" | "not-found" | "validation" | "storage" | "git";
  message: string;
}
export interface GitRemote {
  host: string;
  hostname: string;
  path: string;
  transport: "ssh" | "https" | "http";
  suggestedBaseUrl: string;
  suggestedProvider: GitHostingProvider;
}

export function normalizeGitHostingUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /[\\\s]/.test(input)) throw new Error("Enter an HTTPS platform address without credentials, query parameters, or fragments.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function parseGitRemote(remote: string): GitRemote | undefined {
  try {
    const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(remote);
    const url = new URL(remote.includes("://") ? remote : scp ? `ssh://${scp[1]}/${scp[2]}` : remote);
    if (!["ssh:", "http:", "https:"].includes(url.protocol) || url.password || (url.protocol !== "ssh:" && url.username) || url.search || url.hash) return undefined;
    const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    if (path.split("/").length < 2 || path.split("/").some((part) => !part || part === "." || part === "..") || /[\u0000-\u0020\\?#]/.test(path)) return undefined;
    return { host: url.host, hostname: url.hostname, path, transport: url.protocol.slice(0, -1) as GitRemote["transport"],
      suggestedBaseUrl: `https://${url.protocol === "ssh:" ? url.hostname : url.host}`, suggestedProvider: url.hostname === "github.com" ? "github" : "gitlab" };
  } catch { return undefined; }
}

export function hostingRepositoryPath(remote: GitRemote, baseUrl: string): string {
  const prefix = decodeURIComponent(new URL(baseUrl).pathname).replace(/^\/+|\/+$/g, "");
  return remote.transport !== "ssh" && prefix && remote.path.startsWith(`${prefix}/`) ? remote.path.slice(prefix.length + 1) : remote.path;
}

export function gitHostingTokenUrl(provider: GitHostingProvider, baseUrl: string): string {
  const base = normalizeGitHostingUrl(baseUrl);
  return provider === "github" ? "https://github.com/settings/personal-access-tokens/new?name=SuperThread&contents=read&pull_requests=write"
    : `${base}/-/user_settings/personal_access_tokens?name=SuperThread&scopes=api`;
}

export const saveGitHostingConnectionSchema = z.object({
  provider: z.enum(["github", "gitlab"]),
  baseUrl: z.string().max(2048).transform((value, context) => {
    try { return normalizeGitHostingUrl(value); }
    catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Enter an HTTPS platform address." }); return z.NEVER; }
  }),
  token: z.string().trim().min(1).max(16384).regex(/^\S+$/, "Token cannot contain whitespace"),
  workspaceId: z.string().min(1).optional()
}).strict().refine((value) => value.provider !== "github" || value.baseUrl === "https://github.com", "GitHub connections currently support github.com only.");
export const bindGitHostingConnectionSchema = z.object({ workspaceId: z.string().min(1), connectionId: z.string().min(1) }).strict();
export type SaveGitHostingConnectionInput = z.input<typeof saveGitHostingConnectionSchema>;
export type BindGitHostingConnectionInput = z.infer<typeof bindGitHostingConnectionSchema>;
