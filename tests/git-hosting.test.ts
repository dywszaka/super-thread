import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitHostingStore } from "../src/main/persistence/git-hosting-store";
import { GitHostingClient, gitHostingFailure, type HostingFetch } from "../src/main/runtime/git-hosting-client";
import { parseGitRemote } from "../src/shared/git-hosting";
import { testEncryption } from "./helpers/git-hosting";

test("credentials remain encrypted, survive restart, bind aliases, and replace atomically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hosting-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "connections.json"), cipher = testEncryption();
  const store = new GitHostingStore(path, cipher);
  const input = { provider: "gitlab" as const, baseUrl: "https://gitlab.test/gitlab", username: "alice", token: "test-token-not-for-production" };
  const connection = await store.save(input, { deviceId: "gpu", host: "git-alias" });
  const disk = await readFile(path, "utf8");
  assert.doesNotMatch(disk, /test-token-not-for-production/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal("encryptedToken" in (await store.list())[0]!, false);
  const reloaded = new GitHostingStore(path, cipher);
  assert.deepEqual((await reloaded.credential(connection.id)).connection, connection);
  assert.equal((await reloaded.credential(connection.id)).token, input.token);
  assert.equal((await reloaded.resolve("gpu", parseGitRemote("git@git-alias:team/repo.git")!))?.id, connection.id);
  assert.equal(await reloaded.resolve("another-device", parseGitRemote("git@git-alias:team/repo.git")!), undefined);
  const replaced = await reloaded.save({ ...input, token: "new-test-token", username: "bob" });
  assert.equal(replaced.id, connection.id);
  assert.equal((await reloaded.list()).length, 1);
  assert.equal((await reloaded.credential(connection.id)).token, "new-test-token");
  await reloaded.remove(connection.id);
  assert.deepEqual(await new GitHostingStore(path, cipher).list(), []);
  await assert.rejects(reloaded.credential(connection.id), /no longer exists/);
});

test("keychain unavailability, corrupted ciphertext, and altered destinations cannot reveal or redirect Tokens", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hosting-keychain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "connections.json"), encryption = testEncryption();
  const store = new GitHostingStore(path, encryption);
  const input = { provider: "gitlab" as const, baseUrl: "https://gitlab.test", username: "alice", token: "secret-test-token" };
  encryption.isEncryptionAvailable = () => false;
  await assert.rejects(store.save(input), /cannot be saved as plaintext/);
  await assert.rejects(stat(path), /ENOENT/);
  encryption.isEncryptionAvailable = () => true;
  const saved = await store.save(input);
  const disk = JSON.parse(await readFile(path, "utf8"));
  disk.connections[0].baseUrl = "https://unconfirmed.test";
  await writeFile(path, JSON.stringify(disk));
  await assert.rejects(new GitHostingStore(path, encryption).credential(saved.id), /Could not unlock/);
});

test("failed writes preserve credentials and failed initial reads can recover", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hosting-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "connections.json"), cipher = testEncryption();
  await writeFile(path, "broken");
  const store = new GitHostingStore(path, cipher);
  await assert.rejects(store.list(), /Could not read/);
  await rm(path);
  const saved = await store.save({ provider: "github", baseUrl: "https://github.com", username: "alice", token: "old-token" });
  await rm(path);
  await mkdir(path);
  await assert.rejects(store.save({ provider: "github", baseUrl: "https://github.com", username: "bob", token: "replacement" }), /Existing credentials were kept/);
  assert.equal((await store.credential(saved.id)).token, "old-token");
  await rm(path, { recursive: true });
  await store.remove(saved.id);
  assert.deepEqual(await store.list(), []);
});

for (const provider of ["github", "gitlab"] as const) {
  test(`${provider}: API handles prefixes, pagination, fork identity, all states, and explicit creation contents`, async () => {
    const baseUrl = provider === "github" ? "https://github.com" : "https://gitlab.test:8443/prefix";
    const path = provider === "github" ? "team/repo" : "team/sub/repo";
    const webUrl = `${baseUrl}/${path}/${provider === "github" ? "pull" : "-/merge_requests"}/42`;
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const entry = (id: number) => provider === "github" ? { head: { repo: { id }, ref: "work/demo" }, state: "closed", html_url: webUrl }
      : { source_project_id: id, source_branch: "work/demo", state: "merged", web_url: webUrl };
    const fetcher: HostingFetch = async (input, init) => {
      const url = new URL(input); calls.push({ url, init });
      assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
      const headers = init.headers as Record<string, string>;
      assert.equal(provider === "github" ? headers.Authorization : headers["PRIVATE-TOKEN"], provider === "github" ? "Bearer test-token" : "test-token");
      assert.equal(url.origin, provider === "github" ? "https://api.github.com" : "https://gitlab.test:8443");
      if (url.pathname.endsWith("/user")) return Response.json(provider === "github" ? { login: "alice" } : { username: "alice" });
      if (init.method === "POST") return Response.json(provider === "github" ? { html_url: webUrl } : { web_url: webUrl });
      if (url.searchParams.has("page")) {
        assert.equal(url.searchParams.get("state"), "all");
        return Response.json(url.searchParams.get("page") === "1" ? Array.from({ length: 100 }, () => entry(99)) : [entry(1)]);
      }
      return Response.json({ id: 1, full_name: path, path_with_namespace: path });
    };
    const client = new GitHostingClient({ provider, baseUrl }, "test-token", fetcher);
    assert.equal(await client.user(), "alice");
    const repository = await client.repository(path);
    await client.checkTarget(repository, "release/stable");
    assert.equal(await client.existing(repository, "work/demo"), webUrl);
    const title = "Fix 'quotes' $() 中文", description = "First line\n\nSecond line";
    assert.equal(await client.create(repository, "work/demo", "release/stable", title, description), webUrl);
    const posted = JSON.parse(calls.at(-1)!.init.body as string);
    assert.equal(posted.title, title);
    assert.equal(provider === "github" ? posted.body : posted.description, description);
    assert.equal(calls.filter((call) => call.url.searchParams.has("page")).length, 2);
    if (provider === "gitlab") assert.match(calls[1]!.url.href, /\/prefix\/api\/v4\/projects\/team%2Fsub%2Frepo/);
  });
}

test("API errors distinguish authorization, access, rate limits, and network without reflecting secrets", async () => {
  for (const [status, code] of [[401, "authentication"], [403, "permission"], [404, "not-found"], [429, "rate-limit"], [422, "validation"], [503, "network"]] as const) {
    const client = new GitHostingClient({ provider: "github", baseUrl: "https://github.com" }, "sensitive-test-token", async () => new Response("sensitive-test-token", { status }));
    await assert.rejects(client.user(), (error: Error) => { assert.equal(gitHostingFailure(error).code, code); assert.doesNotMatch(error.message, /sensitive-test-token/); return true; });
  }
  const client = new GitHostingClient({ provider: "gitlab", baseUrl: "https://gitlab.test" }, "secret", async () => { throw new Error("secret"); });
  await assert.rejects(client.user(), /Cannot reach the platform from this Mac/);
});

test("malformed responses and request URLs outside the confirmed platform fail closed", async () => {
  for (const url of ["https://other.test/team/repo/pull/3", "https://github.com/other/repo/pull/3", "https://github.com/team/repo/pull/3?token=secret", "https://github.com/team/repo/pull/3#fragment", "javascript:alert(1)"]) {
    const client = new GitHostingClient({ provider: "github", baseUrl: "https://github.com" }, "test", async () => Response.json({ html_url: url }));
    await assert.rejects(client.create({ id: 1, path: "team/repo" }, "feature", "main", "Title", ""), /valid merge request URL/);
  }
  const malformed = new GitHostingClient({ provider: "github", baseUrl: "https://github.com" }, "test", async () => new Response("not-json"));
  await assert.rejects(malformed.user(), /invalid API response/);
});
