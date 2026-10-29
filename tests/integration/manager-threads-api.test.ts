import { expect, test } from "bun:test";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import { buildAgentsTestApp, buildTestScopes, getJson, postJson } from "../helpers/test-app.js";
import { freshAgentEnv, NOOP_WAKE, seedFeature, seedProject } from "../helpers/fixtures.js";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { threadWorkerRefs } from "../../src/server/modules/agent/manager-threads.js";
import { ManagerThreadService } from "../../src/server/modules/agent/manager-threads.js";
import { ThreadArchive, type ThreadArchiveDeps } from "../../src/server/modules/agent/thread-archive.js";

async function patchJson(app: ReturnType<typeof buildAgentsTestApp>, path: string, body: unknown) {
  const res = await app.request(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** `archive` stands in for parts of the thread's archive: what it releases
 *  and remembers, and how a worker is checked and archived. */
function setup(prefix: string, archive: Partial<Pick<ThreadArchiveDeps, "releaseThreadResources" | "beforeThreadArchive" | "workers">> = {}) {
  const env = freshAgentEnv(prefix);
  const managerThreads = new ManagerThreadService({ agentStore: env.agentStore });
  const features = new FeaturesStore(env.store.db);
  const app = buildAgentsTestApp({
    agentStore: env.agentStore,
    wakeScheduler: NOOP_WAKE,
    scopes: buildTestScopes(features),
    managerThreads,
    threadArchive: new ThreadArchive({
      agentStore: env.agentStore,
      features,
      workers: archive.workers ?? { archiveCheck: () => null, archive: async () => ({ ok: false, error: "no worker here" }) },
      wakes: { getRunningWakeForThread: () => null, cancelWake: () => {} },
      releaseThreadResources: archive.releaseThreadResources ?? (() => {}),
      beforeThreadArchive: archive.beforeThreadArchive ?? (() => {}),
      broadcast: () => {},
      publishThread: (threadId) => managerThreads.publish(threadId)
    })
  });
  return { ...env, app, features };
}

test("POST /api/agents/manager/threads creates a thread and posts the first message into it", async () => {
  const env = setup("md-mt-api-create-");
  try {
    const r = await postJson(env.app, "/api/agents/manager/threads", { content: "Release project-1 3.21" });
    expect(r.status).toBe(201);
    expect(r.body.thread.title).toBe("Release project-1 3.21");
    const threadId = r.body.thread.id as string;
    expect(r.body.message.threadId).toBe(threadId);
    const page = await getJson(env.app, `/api/agents/threads/${threadId}`);
    expect(page.body.thread.id).toBe(threadId);
    expect(page.body.messages.map((m: { content: { text: string } }) => m.content.text)).toEqual(["Release project-1 3.21"]);
  } finally { env.cleanup(); }
});

test("POST /api/agents/manager/threads without content creates an empty thread", async () => {
  const env = setup("md-mt-api-empty-");
  try {
    // A client that serialises its empty composer sends these too.
    for (const body of [{}, { content: "", attachments: [] }, { content: "  " }]) {
      const r = await postJson(env.app, "/api/agents/manager/threads", body);
      expect({ body, status: r.status, message: r.body.message, title: r.body.thread?.title })
        .toEqual({ body, status: 201, message: null, title: "New thread" });
    }
  } finally { env.cleanup(); }
});

test("GET lists open threads; PATCH renames; PATCH archive removes it from the list", async () => {
  const released: string[] = [];
  const memory: string[] = [];
  const env = setup("md-mt-api-list-", {
    releaseThreadResources: (id) => { released.push(id); },
    beforeThreadArchive: (id) => { memory.push(id); }
  });
  try {
    const a = env.agentStore.createManagerThread("A");
    const b = env.agentStore.createManagerThread("B");
    expect((await getJson(env.app, "/api/agents/manager/threads")).body.threads.map((t: { id: string }) => t.id).sort()).toEqual([a.id, b.id].sort());
    const renamed = await patchJson(env.app, `/api/agents/manager/threads/${a.id}`, { title: "Renamed" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.thread.title).toBe("Renamed");
    expect((await patchJson(env.app, `/api/agents/manager/threads/${a.id}`, { title: "  " })).status).toBe(400);
    const archived = await patchJson(env.app, `/api/agents/manager/threads/${a.id}`, { archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.thread.archivedAt).toBeTruthy();
    expect(released).toStrictEqual([a.id]);
    expect(memory).toStrictEqual([a.id]);
    expect((await getJson(env.app, "/api/agents/manager/threads")).body.threads.map((t: { id: string }) => t.id)).toEqual([b.id]);
    expect((await patchJson(env.app, `/api/agents/manager/threads/${a.id}`, { title: "again" })).status).toBe(404);
  } finally { env.cleanup(); }
});

test("POST seen moves forward only; unknown thread is 404", async () => {
  const env = setup("md-mt-api-seen-");
  try {
    const t = env.agentStore.createManagerThread("T");
    expect((await postJson(env.app, `/api/agents/manager/threads/${t.id}/seen`, { seq: 9 })).body.thread.seenSeq).toBe(9);
    expect((await postJson(env.app, `/api/agents/manager/threads/${t.id}/seen`, { seq: 2 })).body.thread.seenSeq).toBe(9);
    expect((await postJson(env.app, `/api/agents/manager/threads/${t.id}/seen`, { seq: "x" })).status).toBe(400);
    expect((await postJson(env.app, "/api/agents/manager/threads/thr_nope/seen", { seq: 1 })).status).toBe(404);
  } finally { env.cleanup(); }
});

test("the old /api/agents/manager routes are gone, and open no thread", async () => {
  const env = setup("md-mt-api-alias-");
  try {
    for (const [method, path] of [
      ["GET", "/api/agents/manager/thread"],
      ["POST", "/api/agents/manager/messages"],
      ["POST", "/api/agents/manager/new-chat"],
      ["DELETE", "/api/agents/manager/queued-messages/req-1"]
    ] as const) {
      const res = await env.app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ content: "via alias" }) } : {})
      });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    expect(env.agentStore.listOpenManagerThreads()).toEqual([]);
  } finally { env.cleanup(); }
});

test("a thread's workers: active by default, archived ones with ?archived=1, each with its conversation", async () => {
  const env = freshAgentEnv("md-mt-api-workers-");
  const projects = new ProjectsStore(env.store.db);
  const features = new FeaturesStore(env.store.db);
  const t = env.agentStore.createManagerThread("Release");
  const other = env.agentStore.createManagerThread("Other");
  const projectId = seedProject(projects, { name: "project-1", tmuxSessionName: "project-1" });
  const active = seedFeature(features, projectId, { name: "parser", tmuxWindowName: "parser" });
  const done = seedFeature(features, projectId, { name: "docs", tmuxWindowName: "docs" });
  const elsewhere = seedFeature(features, projectId, { name: "typos", tmuxWindowName: "typos" });
  features.setOwner(active, t.id);
  features.setOwner(done, t.id);
  features.setOwner(elsewhere, other.id);
  // The archived worker's conversation outlives it (a worker's New chat,
  // now removed, archived threads too), so the newest one is found
  // whatever its archive state.
  const doneThread = env.agentStore.getOrCreateThread("worker", done);
  env.agentStore.archiveThread(doneThread.id);
  features.archive(done);
  features.archive(elsewhere);
  const app = buildAgentsTestApp({
    agentStore: env.agentStore,
    wakeScheduler: NOOP_WAKE,
    scopes: buildTestScopes(features),
    managerThreads: new ManagerThreadService({ agentStore: env.agentStore }),
    listThreadWorkers: (threadId, archived) => threadWorkerRefs({ features, projects, agentStore: env.agentStore }, threadId, archived)
  });
  const archived = await getJson(app, `/api/agents/manager/threads/${t.id}/workers?archived=1`);
  expect(archived.status).toBe(200);
  expect(archived.body.workers.map((w: { name: string; projectName: string; workerThreadId: string | null; archivedAt: string | null }) =>
    [w.name, w.projectName, w.workerThreadId, Boolean(w.archivedAt)])).toEqual([["docs", "project-1", doneThread.id, true]]);
  const current = await getJson(app, `/api/agents/manager/threads/${t.id}/workers`);
  expect(current.body.workers.map((w: { name: string }) => w.name)).toEqual(["parser"]);
  expect((await getJson(app, "/api/agents/manager/threads/thr_nope/workers")).status).toBe(404);
});

test("PATCH archive takes the thread's workers with it; while one would lose work it is refused with what was found, until confirmed", async () => {
  const findings: Record<string, string[]> = {};
  const archivedWith: Array<Record<string, unknown>> = [];
  let features!: FeaturesStore;
  const env = setup("md-mt-api-workers-", {
    workers: {
      archiveCheck: (id) => ({ findings: findings[id] ?? [] }),
      archive: async (input) => {
        archivedWith.push({ ...input });
        features.archive(input.id);
        return { ok: true, feature: { projectId: "proj_1" }, cleanupFailures: [{ kind: "branch", branch: "pr-33", error: "not fully merged" }] };
      }
    }
  });
  features = env.features;
  try {
    const t = env.agentStore.createManagerThread("T");
    const projectId = seedProject(new ProjectsStore(env.store.db));
    const worker = seedFeature(features, projectId, { name: "pr-33", tmuxWindowName: "pr-33" });
    features.setOwner(worker, t.id);
    findings[worker] = ["3 uncommitted files in the worktree."];

    const refused = await patchJson(env.app, `/api/agents/manager/threads/${t.id}`, { archived: true });
    expect(refused).toEqual({ status: 409, body: {
      error: "Archiving would lose work in: pr-33.",
      workers: [{ id: worker, name: "pr-33", findings: ["3 uncommitted files in the worktree."] }],
      archived: [],
      cleanupFailures: []
    } });
    expect(env.agentStore.getThreadById(t.id)?.archivedAt).toBe(null);
    expect(features.getById(worker)?.archivedAt).toBe(null);
    // The user's word is the list of workers they were shown: anything else,
    // and a list that leaves this worker out, asks again.
    for (const confirmed of [true, "yes", worker, ["feat_other"], [{ id: worker }]]) {
      expect([confirmed, (await patchJson(env.app, `/api/agents/manager/threads/${t.id}`, { archived: true, confirmed })).status]).toEqual([confirmed, 409]);
    }

    // Confirmed, with the worktrees kept. Only an unticked box, `false`, holds
    // a cleanup back: anything else leaves the worker to its own.
    const archived = await patchJson(env.app, `/api/agents/manager/threads/${t.id}`, { archived: true, confirmed: [worker], removeWorktrees: false, deleteBranches: 0 });
    expect(archived.status).toBe(200);
    expect(archived.body.thread.archivedAt).toBeTruthy();
    expect(archived.body.workers).toEqual([{ id: worker, name: "pr-33" }]);
    expect(archived.body.cleanupFailures).toEqual([{ kind: "branch", branch: "pr-33", error: "not fully merged" }]);
    expect(archivedWith).toStrictEqual([{ id: worker, confirmed: true, cleanup: { removeWorktree: false, deleteBranch: undefined } }]);
    expect(features.getById(worker)?.archivedAt === null).toBe(false);

    // The branches kept, of another thread with a clean worker: nothing to confirm.
    const u = env.agentStore.createManagerThread("U");
    const second = seedFeature(features, projectId, { name: "pr-37", tmuxWindowName: "pr-37" });
    features.setOwner(second, u.id);
    expect((await patchJson(env.app, `/api/agents/manager/threads/${u.id}`, { archived: true, deleteBranches: false })).status).toBe(200);
    expect(archivedWith[1]).toEqual({ id: second, confirmed: false, cleanup: { removeWorktree: undefined, deleteBranch: false } });
  } finally { env.cleanup(); }
});

test("POST /api/agents/manager/threads refuses content or attachments of the wrong type instead of dropping them", async () => {
  const env = setup("md-mt-api-badtype-");
  try {
    for (const body of [{ content: 42 }, { content: ["hi"] }, { attachments: "img" }, { content: "", attachments: {} }]) {
      const r = await postJson(env.app, "/api/agents/manager/threads", body);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
    }
    expect(env.agentStore.listOpenManagerThreads()).toEqual([]);
  } finally { env.cleanup(); }
});
