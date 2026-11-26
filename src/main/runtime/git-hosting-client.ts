import type { GitHostingConnection, GitHostingFailure, GitHostingProvider } from "../../shared/git-hosting";

export class GitHostingError extends Error {
  constructor(readonly code: GitHostingFailure["code"], message: string) { super(message); }
}
export function gitHostingFailure(error: unknown, code: GitHostingFailure["code"] = "storage"): GitHostingFailure {
  return error instanceof GitHostingError ? { code: error.code, message: error.message }
    : { code, message: error instanceof Error ? error.message : "The operation failed. Please retry." };
}
export type HostingFetch = (input: string, init: RequestInit) => Promise<Response>;
export interface HostingRepository { id: number; path: string; }

export class GitHostingClient {
  private readonly api: string;
  constructor(private readonly connection: Pick<GitHostingConnection, "provider" | "baseUrl">, private readonly token: string, private readonly fetcher: HostingFetch = globalThis.fetch) {
    this.api = connection.provider === "github" ? "https://api.github.com" : `${connection.baseUrl}/api/v4`;
  }
  private get provider(): GitHostingProvider { return this.connection.provider; }

  async user(): Promise<string> {
    const user = await this.request("/user");
    const username = this.provider === "github" ? user.login : user.username;
    if (typeof username !== "string" || !username) throw new GitHostingError("validation", "The platform did not return a valid account. Check the platform type and address.");
    return username;
  }

  async repository(path: string): Promise<HostingRepository> {
    if (!path.includes("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new GitHostingError("validation", "Invalid repository path.");
    const result = await this.request(this.provider === "github" ? `/repos/${path.split("/").map(encodeURIComponent).join("/")}` : `/projects/${encodeURIComponent(path)}`);
    const canonical = this.provider === "github" ? result.full_name : result.path_with_namespace;
    if (!Number.isSafeInteger(result.id) || typeof canonical !== "string" || !canonical.includes("/")) throw new GitHostingError("validation", "The platform returned an invalid repository. Check its address and access permissions.");
    return { id: result.id, path: canonical };
  }

  async checkTarget(repository: HostingRepository, branch: string): Promise<void> {
    await this.request(`${this.repositoryEndpoint(repository)}${this.provider === "github" ? "/branches/" : "/repository/branches/"}${encodeURIComponent(branch)}`);
  }

  async existing(repository: HostingRepository, branch: string): Promise<string | undefined> {
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ state: "all", per_page: "100", page: String(page) });
      if (this.provider === "github") query.set("head", `${repository.path.split("/")[0]}:${branch}`);
      else { query.set("source_branch", branch); query.set("scope", "all"); }
      const entries = await this.request(`${this.repositoryEndpoint(repository)}/${this.provider === "github" ? "pulls" : "merge_requests"}?${query}`);
      if (!Array.isArray(entries)) throw new GitHostingError("validation", "Invalid merge request lookup response. Creation is unavailable; retry.");
      for (const entry of entries) {
        if (this.provider === "github") {
          if (entry?.head?.repo === null) continue; // A deleted fork cannot be this existing push repository.
          if (!entry?.head?.repo || !Number.isSafeInteger(entry.head.repo.id) || typeof entry.head.ref !== "string") throw new GitHostingError("validation", "Could not verify the source repository of an existing request.");
          if (entry.head.repo.id !== repository.id || entry.head.ref !== branch) continue;
        } else {
          if (typeof entry?.source_project_id !== "number" || typeof entry.source_branch !== "string") throw new GitHostingError("validation", "Could not verify the source repository of an existing request.");
          if (entry.source_project_id !== repository.id || entry.source_branch !== branch) continue;
        }
        return this.requestUrl(this.provider === "github" ? entry.html_url : entry.web_url, repository);
      }
      if (entries.length < 100) return undefined;
    }
  }

  async create(repository: HostingRepository, branch: string, target: string, title: string, description: string): Promise<string> {
    const input = this.provider === "github" ? { head: branch, base: target, title, body: description }
      : { source_branch: branch, target_branch: target, title, description };
    const result = await this.request(`${this.repositoryEndpoint(repository)}/${this.provider === "github" ? "pulls" : "merge_requests"}`, input);
    return this.requestUrl(this.provider === "github" ? result.html_url : result.web_url, repository);
  }

  private repositoryEndpoint(repository: HostingRepository): string {
    return this.provider === "github" ? `/repos/${repository.path.split("/").map(encodeURIComponent).join("/")}` : `/projects/${repository.id}`;
  }
  private requestUrl(value: unknown, repository: HostingRepository): string {
    try {
      if (typeof value !== "string") throw new Error();
      const url = new URL(value), base = new URL(this.connection.baseUrl);
      const prefix = `${decodeURIComponent(base.pathname).replace(/\/$/, "")}/${repository.path}/${this.provider === "github" ? "pull/" : "-/merge_requests/"}`;
      if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || !decodeURIComponent(url.pathname).startsWith(prefix) || !/^\d+$/.test(url.pathname.slice(url.pathname.lastIndexOf("/") + 1))) throw new Error();
      return url.href;
    } catch { throw new GitHostingError("validation", "The platform did not return a valid merge request URL."); }
  }

  private async request(path: string, body?: object): Promise<any> {
    const headers: Record<string, string> = this.provider === "github"
      ? { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
      : { "PRIVATE-TOKEN": this.token };
    headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      // Credentials belong only to this explicitly selected API destination.
      response = await this.fetcher(`${this.api}${path}`, { method: body ? "POST" : "GET", headers, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30_000), ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new GitHostingError("network", "Cannot reach the platform from this Mac. Check its address, VPN/proxy, and trusted certificates, then retry."); }
    if (!response.ok) {
      // Never echo provider bodies or fetch exceptions: either may contain credentials.
      if (response.status === 401) throw new GitHostingError("authentication", "Token is invalid or expired. Reconnect this platform with a new Token.");
      if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) throw new GitHostingError("rate-limit", "The platform rate limit was reached. Wait before retrying.");
      if (response.status === 403) throw new GitHostingError("permission", "Access denied. Check Token permissions, selected repositories, and organization approval or SSO authorization.");
      if (response.status === 404) throw new GitHostingError("not-found", "Repository or target branch is missing or inaccessible. Check its address, Token repository selection, and organization authorization.");
      throw new GitHostingError(response.status >= 500 ? "network" : "validation", `Platform returned HTTP ${response.status}. Check the branches, title, and permissions, then retry.`);
    }
    try {
      const text = await response.text();
      if (text.length > 8 * 1024 * 1024) throw new Error();
      const result = JSON.parse(text);
      if (!result || typeof result !== "object") throw new Error();
      return result;
    } catch { throw new GitHostingError("validation", "The platform returned an invalid API response. Check its type and address."); }
  }
}
