import { bindGitHostingConnectionSchema, hostingRepositoryPath, saveGitHostingConnectionSchema } from "../../shared/git-hosting";
import type { GitHostingConnection, SaveGitHostingConnectionInput } from "../../shared/git-hosting";
import type { GitMergeRequestPreparation, WorkspaceMergeRequest } from "../../shared/merge-request";
import { GitHostingStore } from "../persistence/git-hosting-store";
import { GitHostingClient, gitHostingFailure, type HostingFetch } from "../runtime/git-hosting-client";

export class GitHostingService {
  constructor(private readonly store: GitHostingStore, private readonly fetcher?: HostingFetch) {}
  list(): Promise<GitHostingConnection[]> { return this.store.list(); }
  remove(id: string): Promise<void> { return this.store.remove(id); }
  async client(id: string): Promise<GitHostingClient> {
    const { connection, token } = await this.store.credential(id);
    return new GitHostingClient(connection, token, this.fetcher);
  }
  async verify(id: string): Promise<void> {
    const username = await (await this.client(id)).user();
    await this.store.markVerified(id, username);
  }
  async save(raw: SaveGitHostingConnectionInput, workspace?: { deviceId: string; preparation: GitMergeRequestPreparation }): Promise<GitHostingConnection> {
    const input = saveGitHostingConnectionSchema.parse(raw);
    const client = new GitHostingClient(input, input.token, this.fetcher);
    const username = await client.user();
    if (workspace) await client.repository(hostingRepositoryPath(workspace.preparation.remote, input.baseUrl));
    return this.store.save({ ...input, username }, workspace ? { deviceId: workspace.deviceId, host: workspace.preparation.remote.host } : undefined);
  }
  async bind(raw: { workspaceId: string; connectionId: string }, deviceId: string, preparation: GitMergeRequestPreparation): Promise<void> {
    const input = bindGitHostingConnectionSchema.parse(raw);
    const connection = (await this.store.list()).find((item) => item.id === input.connectionId);
    if (!connection) throw new Error("Connection no longer exists.");
    await (await this.client(connection.id)).repository(hostingRepositoryPath(preparation.remote, connection.baseUrl));
    await this.store.bind(deviceId, preparation.remote.host, connection.id);
  }
  async inspect(deviceId: string, preparation: GitMergeRequestPreparation): Promise<WorkspaceMergeRequest> {
    let connection: GitHostingConnection | undefined;
    try {
      connection = await this.store.resolve(deviceId, preparation.remote);
      if (!connection) return { state: "needs-connection", preparation };
      const client = await this.client(connection.id);
      const repository = await client.repository(hostingRepositoryPath(preparation.remote, connection.baseUrl));
      const existing = await client.existing(repository, preparation.branch);
      if (existing) return { state: "existing", url: existing };
      await client.checkTarget(repository, preparation.targetBranch);
      return { state: "available", context: { ...preparation, connectionId: connection.id, connectionVersion: `${connection.username}:${connection.verifiedAt}`, provider: connection.provider, repository: repository.path }, connection };
    } catch (error) {
      const failure = gitHostingFailure(error);
      return failure.code === "authentication" || failure.code === "storage"
        ? { state: "needs-connection", preparation, connection, failure }
        : { state: "error", preparation, connection, failure };
    }
  }
}
