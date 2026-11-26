import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkspaceService } from "../src/main/application/workspace-service";
import { GitHostingService } from "../src/main/application/git-hosting-service";
import { JsonStore } from "../src/main/persistence/json-store";
import { GitHostingStore } from "../src/main/persistence/git-hosting-store";
import type { CommandRunner } from "../src/main/runtime/command-runner";
import type { HostingFetch } from "../src/main/runtime/git-hosting-client";
import { createWorkspaceMergeRequestSchema } from "../src/shared/contract";
import type { DeviceConnection } from "../src/shared/domain";
import type { CreateWorkspaceMergeRequestInput, WorkspaceMergeRequestOperation } from "../src/shared/merge-request";
import { testEncryption } from "./helpers/git-hosting";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "workspace-mr-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { username: "alice", head: "a".repeat(40), pushError: false, createError: false, createdOnFailure: false, existing: false, authError: false, permissionError: false, createCount: 0, pushGate: undefined as Promise<void> | undefined, onPush: undefined as (() => void) | undefined };
  const calls: string[][] = [], connections: DeviceConnection[] = [], apiCalls: Array<{ url: string; init: RequestInit }> = [], stages: WorkspaceMergeRequestOperation[] = [];
  const runner: CommandRunner = { async run(program, args) {
    calls.push([program, ...args]);
    assert.equal(program, "git");
    let stdout = "";
    if (args[2] === "branch") stdout = "work/demo";
    else if (args[2] === "remote") stdout = args.length === 3 ? "origin" : "git@gitlab-alias:team/repo.git";
    else if (args[2] === "rev-parse") stdout = state.head;
    else if (args[2] === "log") stdout = "Feature title";
    else if (args[2] === "push") {
      state.onPush?.(); await state.pushGate;
      if (state.pushError) throw new Error("Permission denied (publickey)");
    }
    return { stdout, stderr: "", exitCode: 0 };
  } };
  const fetcher: HostingFetch = async (url, init) => {
    apiCalls.push({ url, init });
    assert.match(url, /^https:\/\/gitlab\.test\/prefix\/api\/v4\//);
    if (state.authError) return new Response("Token expired", { status: 401 });
    if (state.permissionError) return new Response("Forbidden", { status: 403 });
    if (url.endsWith("/user")) return Response.json({ username: state.username });
    if (init.method === "POST") {
      state.createCount++;
      if (state.createError) {
        if (state.createdOnFailure) state.existing = true;
        throw new Error("Network response lost");
      }
      state.existing = true;
      return Response.json({ web_url: "https://gitlab.test/prefix/team/repo/-/merge_requests/3" });
    }
    if (url.includes("/merge_requests?")) return Response.json(state.existing ? [{ source_project_id: 1, source_branch: "work/demo", state: "closed", web_url: "https://gitlab.test/prefix/team/repo/-/merge_requests/3" }] : []);
    return Response.json({ id: 1, path_with_namespace: "team/repo" });
  };
  const hosting = new GitHostingService(new GitHostingStore(join(root, "hosting.json"), testEncryption()), fetcher);
  const store = new JsonStore(join(root, "state.json"));
  const service = new WorkspaceService(store, undefined, undefined, undefined, undefined, (connection) => { connections.push(connection); return runner; }, undefined, undefined, hosting);
  await service.initialize(); t.after(() => service.shutdown());
  await store.update((draft) => {
    draft.devices.push({ id: "remote", name: "SSH", type: "remote", status: "online", createdAt: "now" });
    draft.connections.push({ deviceId: "remote", transport: "ssh", config: { host: "gpu.test", user: "builder", port: 2222 } });
    draft.projects.push({ id: "project", code: "demo", name: "Demo", createdAt: "now", updatedAt: "now" });
    draft.checkouts.push({ id: "checkout", projectId: "project", deviceId: "remote", path: "/srv/repo", isGit: true, createdAt: "now" });
    draft.workThreads.push({ id: "thread", name: "Demo", status: "active", pinned: false, createdAt: "now", updatedAt: "now" });
    draft.workspaces.push({ id: "workspace", workThreadId: "thread", name: "demo", projectId: "project", deviceId: "remote", checkoutId: "checkout", kind: "worktree", path: "/srv/work tree", branch: "work/demo", baseBranch: "main", status: "ready", createdAt: "now", updatedAt: "now" });
  });
  service.on("workspace-merge-request-changed", (operation) => stages.push(operation));
  const connect = () => service.saveGitHostingConnection({ workspaceId: "workspace", provider: "gitlab", baseUrl: "https://gitlab.test/prefix", token: "test-token-kept-on-Mac" });
  const input = async (): Promise<CreateWorkspaceMergeRequestInput> => {
    const inspected = await service.inspectWorkspaceMergeRequest("workspace");
    assert.equal(inspected.state, "available");
    if (inspected.state !== "available") throw new Error("Expected prepared workspace");
    return { workspaceId: "workspace", context: inspected.context, title: "Edited title", description: "Edited description\nsecond line" };
  };
  return { service, store, state, calls, apiCalls, connections, stages, connect, input };
}

test("first-time connection validates on Mac, maps an SSH alias, and only explicit submission pushes and creates", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.inspectWorkspaceMergeRequest("workspace")).state, "needs-connection");
  assert.equal(f.apiCalls.length, 0);
  await f.connect();
  const input = await f.input();
  assert.equal(f.state.createCount, 0);
  assert.equal(f.calls.some((call) => call[3] === "push"), false);
  assert.equal(input.context.remote.host, "gitlab-alias");
  const result = await f.service.createWorkspaceMergeRequest(input);
  assert.equal(result.created, true);
  assert.deepEqual(f.stages.map((stage) => stage.stage), ["checking", "pushing", "creating", "succeeded"]);
  assert.equal(f.service.workspaceMergeRequestOperation("workspace")?.pushed, true);
  const body = JSON.parse(f.apiCalls.find((call) => call.init.method === "POST")!.init.body as string);
  assert.equal(body.title, input.title); assert.equal(body.description, input.description);
  assert.equal((await f.service.inspectWorkspaceMergeRequest("workspace")).state, "existing");
  assert.equal((await f.service.createWorkspaceMergeRequest(input)).created, false);
  assert.equal(f.state.createCount, 1);
  assert.equal(f.calls.filter((call) => call[3] === "push").length, 1);
  assert.ok(f.connections.every((connection) => connection.transport === "ssh" && connection.config.host === "gpu.test"));
  assert.doesNotMatch(JSON.stringify(f.calls), /test-token-kept-on-Mac|gh|glab/);
  assert.doesNotMatch(JSON.stringify(f.service.snapshot()), /test-token-kept-on-Mac|Edited description/);
});

test("creation deduplicates clicks, survives UI disconnection, and blocks deletion and Finish while pushing", async (t) => {
  const f = await fixture(t); await f.connect();
  let release!: () => void, started!: () => void;
  f.state.pushGate = new Promise<void>((resolve) => { release = resolve; });
  const pushStarted = new Promise<void>((resolve) => { started = resolve; }); f.state.onPush = started;
  const input = await f.input(), creating = f.service.createWorkspaceMergeRequest(input);
  await pushStarted;
  assert.equal(f.service.createWorkspaceMergeRequest(input), creating);
  f.service.setWindowOpen(false);
  assert.equal(f.service.workspaceMergeRequestOperation("workspace")?.stage, "pushing");
  await assert.rejects(f.service.deleteWorkspace("workspace", true), /Wait for push and MR creation/);
  await assert.rejects(f.service.finishWorkThread({ id: "thread", workspaceIds: ["workspace"], forceWorkspaceIds: ["workspace"] }), /Wait for push and MR creation/);
  release(); await creating;
  f.service.setWindowOpen(true);
  assert.equal(f.service.workspaceMergeRequestOperation("workspace")?.stage, "succeeded");
  assert.equal(f.state.createCount, 1);
});

test("push failures stop API creation, and partial success is retained for a safe retry", async (t) => {
  const f = await fixture(t); await f.connect(); const input = await f.input();
  f.state.pushError = true;
  await assert.rejects(f.service.createWorkspaceMergeRequest(input), /Git push failed/);
  assert.equal(f.state.createCount, 0);
  assert.equal(f.service.workspaceMergeRequestOperation("workspace")?.pushed, false);
  f.state.pushError = false; f.state.createError = true;
  await assert.rejects(f.service.createWorkspaceMergeRequest(input), /Branch pushed, but MR creation failed/);
  assert.equal(f.service.workspaceMergeRequestOperation("workspace")?.pushed, true);
  assert.equal(f.service.workspaceMergeRequestOperation("workspace")?.failure?.code, "network");
  f.state.createError = false;
  assert.equal((await f.service.createWorkspaceMergeRequest(input)).created, true);
});

test("a server-created request with a lost response is reconciled instead of POSTed again", async (t) => {
  const f = await fixture(t); await f.connect(); const input = await f.input();
  f.state.createError = true; f.state.createdOnFailure = true;
  assert.equal((await f.service.createWorkspaceMergeRequest(input)).created, false);
  assert.equal((await f.service.createWorkspaceMergeRequest(input)).created, false);
  assert.equal(f.state.createCount, 1);
});

test("switching the account behind a connection requires fresh review before push", async (t) => {
  const f = await fixture(t); const first = await f.connect(); const input = await f.input();
  f.state.username = "bob";
  assert.equal((await f.connect()).id, first.id);
  await assert.rejects(f.service.createWorkspaceMergeRequest(input), /connection changed/);
  assert.equal(f.calls.some((call) => call[3] === "push"), false);
});

test("expired credentials, insufficient access, and changed commits fail before push and can reconnect", async (t) => {
  const f = await fixture(t); const connection = await f.connect(); const input = await f.input();
  f.state.authError = true;
  const expired = await f.service.inspectWorkspaceMergeRequest("workspace");
  assert.equal(expired.state, "needs-connection");
  if (expired.state === "needs-connection") assert.equal(expired.connection?.id, connection.id);
  await assert.rejects(f.service.createWorkspaceMergeRequest(input), /Token is invalid or expired/);
  f.state.authError = false; f.state.permissionError = true;
  const denied = await f.service.inspectWorkspaceMergeRequest("workspace");
  assert.equal(denied.state, "error");
  if (denied.state === "error") assert.equal(denied.failure.code, "permission");
  f.state.permissionError = false;
  f.state.head = "b".repeat(40);
  await assert.rejects(f.service.createWorkspaceMergeRequest(input), /changed/);
  assert.equal(f.calls.some((call) => call[3] === "push"), false);
  assert.equal(createWorkspaceMergeRequestSchema.safeParse({ ...input, token: "not-allowed" }).success, false);
  assert.equal(createWorkspaceMergeRequestSchema.safeParse({ ...input, title: " " }).success, false);
  assert.equal((await f.connect()).id, connection.id);
  await f.service.removeGitHostingConnection(connection.id);
  assert.equal((await f.service.inspectWorkspaceMergeRequest("workspace")).state, "needs-connection");
});
