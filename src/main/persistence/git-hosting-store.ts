import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GitHostingConnection, GitHostingProvider, GitRemote } from "../../shared/git-hosting";

export interface CredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
const connectionSchema = z.object({ id: z.string(), provider: z.enum(["github", "gitlab"]), baseUrl: z.string(), username: z.string(), verifiedAt: z.string(), encryptedToken: z.string() }).strict();
const storageSchema = z.object({ version: z.literal(1), connections: z.array(connectionSchema), bindings: z.array(z.object({ deviceId: z.string(), host: z.string(), connectionId: z.string() }).strict()) }).strict();
type Storage = z.infer<typeof storageSchema>;
const metadata = ({ encryptedToken: _token, ...connection }: Storage["connections"][number]): GitHostingConnection => connection;

export class GitHostingStore {
  private data: Storage = { version: 1, connections: [], bindings: [] };
  private loaded?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly encryption: CredentialEncryption) {}

  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      try { this.data = storageSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read code hosting connections. Restore the connection file or retry."); }
    })().catch((error) => { this.loaded = undefined; throw error; });
  }

  async list(): Promise<GitHostingConnection[]> { await this.load(); return this.data.connections.map(metadata); }
  async credential(id: string): Promise<{ connection: GitHostingConnection; token: string }> {
    await this.load();
    const value = this.data.connections.find((item) => item.id === id);
    if (!value) throw new Error("Code hosting connection no longer exists. Connect again.");
    if (!this.encryption.isEncryptionAvailable()) throw new Error("Mac credential encryption is unavailable. Unlock your keychain and retry.");
    try {
      const secret = JSON.parse(this.encryption.decryptString(Buffer.from(value.encryptedToken, "base64")));
      // Bind ciphertext to its destination; changing metadata must never redirect a saved Token.
      if (secret.baseUrl !== value.baseUrl || secret.provider !== value.provider || typeof secret.token !== "string") throw new Error();
      return { connection: metadata(value), token: secret.token };
    } catch { throw new Error("Could not unlock this connection. Replace its Token to reconnect."); }
  }

  async resolve(deviceId: string, remote: GitRemote): Promise<GitHostingConnection | undefined> {
    await this.load();
    const binding = this.data.bindings.find((item) => item.deviceId === deviceId && item.host === remote.host);
    if (binding) return this.data.connections.filter((item) => item.id === binding.connectionId).map(metadata)[0];
    const matches = this.data.connections.filter((item) => {
      const url = new URL(item.baseUrl);
      return url.hostname === remote.hostname && (remote.transport === "ssh" || url.host === remote.host) &&
        (remote.transport === "ssh" || !url.pathname || remote.path.startsWith(url.pathname.replace(/^\//, "") + "/"));
    });
    return matches.length === 1 ? metadata(matches[0]!) : undefined;
  }

  async save(input: { provider: GitHostingProvider; baseUrl: string; username: string; token: string }, binding?: { deviceId: string; host: string }): Promise<GitHostingConnection> {
    if (!this.encryption.isEncryptionAvailable()) throw new Error("Mac credential encryption is unavailable. Unlock your keychain and retry; Tokens cannot be saved as plaintext.");
    let encryptedToken: string;
    try { encryptedToken = this.encryption.encryptString(JSON.stringify({ provider: input.provider, baseUrl: input.baseUrl, token: input.token })).toString("base64"); }
    catch { throw new Error("Could not encrypt this Token. Unlock your Mac keychain and retry."); }
    let saved!: GitHostingConnection;
    await this.update((draft) => {
      const existing = draft.connections.find((item) => item.baseUrl === input.baseUrl && item.provider === input.provider);
      saved = { id: existing?.id ?? `hosting_${randomUUID()}`, provider: input.provider, baseUrl: input.baseUrl, username: input.username, verifiedAt: new Date().toISOString() };
      draft.connections = draft.connections.filter((item) => item.id !== saved.id).concat({ ...saved, encryptedToken });
      if (binding) this.setBinding(draft, { ...binding, connectionId: saved.id });
    });
    return saved;
  }

  async bind(deviceId: string, host: string, connectionId: string): Promise<void> {
    await this.update((draft) => {
      if (!draft.connections.some((item) => item.id === connectionId)) throw new Error("Connection no longer exists.");
      this.setBinding(draft, { deviceId, host, connectionId });
    });
  }
  async markVerified(id: string, username: string): Promise<void> {
    await this.update((draft) => {
      const connection = draft.connections.find((item) => item.id === id);
      if (connection) Object.assign(connection, { username, verifiedAt: new Date().toISOString() });
    });
  }
  async remove(id: string): Promise<void> {
    await this.update((draft) => {
      draft.connections = draft.connections.filter((item) => item.id !== id);
      draft.bindings = draft.bindings.filter((item) => item.connectionId !== id);
    });
  }
  private setBinding(draft: Storage, binding: Storage["bindings"][number]): void {
    draft.bindings = draft.bindings.filter((item) => item.deviceId !== binding.deviceId || item.host !== binding.host).concat(binding);
  }
  private update(mutator: (draft: Storage) => void): Promise<void> {
    const write = this.writes.then(async () => {
      await this.load();
      const draft = structuredClone(this.data);
      mutator(draft);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(draft), { mode: 0o600, flag: "wx" });
        await rename(temporary, this.path);
      } catch { throw new Error("Could not save code hosting connections. Existing credentials were kept; retry."); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
      this.data = draft;
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
