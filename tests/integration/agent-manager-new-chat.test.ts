import { expect, test } from "bun:test";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import type { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import type { MandateStore } from "../../src/server/app/store.js";
import { buildAgentsTestApp, buildTestScopes, getJson, postJson } from "../helpers/test-app.js";
import { freshAgentEnv, NOOP_WAKE } from "../helpers/fixtures.js";

function buildApp(
  agentStore: AgentStore,
  store: MandateStore,
  beforeNewChatArchive?: (threadId: string) => void
) {
  return buildAgentsTestApp({
    agentStore,
    wakeScheduler: NOOP_WAKE,
    beforeNewChatArchive,
    scopes: buildTestScopes(new FeaturesStore(store.db))
  });
}

test("POST /api/agents/manager/new-chat — archives current, creates fresh", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-ov-new-chat-");
  try {
    const app = buildApp(agentStore, store);
    // Send a message to create the singleton.
    await postJson(app, "/api/agents/manager/messages", { content: "first" });
    const t1 = agentStore.getThreadByScope("manager", null)!;
    const id1 = t1.id;

    const r = await postJson(app, "/api/agents/manager/new-chat", {});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.oldThreadId).toBe(id1);
    expect(r.body.newThreadId).not.toBe(id1);

    // Active singleton is the new thread.
    const t2 = agentStore.getThreadByScope("manager", null)!;
    expect(t2.id).toBe(r.body.newThreadId);
    expect(t2.archivedAt).toBe(null);

    // Old thread is archived.
    const archived = agentStore.getThreadById(id1)!;
    expect(archived.archivedAt).toBeTruthy();

    // GET /thread now shows the new (empty) thread.
    const tr = await getJson(app, "/api/agents/manager/thread");
    expect(tr.body.thread.id).toBe(t2.id);
    expect(tr.body.messages).toEqual([]);
  } finally { cleanup(); }
});

test("POST /api/agents/manager/new-chat — works when no overview thread exists yet", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-ov-new-chat-");
  try {
    const app = buildApp(agentStore, store);
    const r = await postJson(app, "/api/agents/manager/new-chat", {});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.oldThreadId).toBe(null);
    expect(r.body.newThreadId).toBeTruthy();   // a fresh one was created
  } finally { cleanup(); }
});

test("POST /api/agents/manager/new-chat — gives archive hook the old thread before archiving", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-ov-new-chat-hook-");
  try {
    await postJson(buildApp(agentStore, store), "/api/agents/manager/messages", { content: "remember this" });
    const old = agentStore.getThreadByScope("manager", null)!;
    let hookThreadId: string | null = null;
    let archivedAtInsideHook: string | null | undefined;
    const app = buildApp(agentStore, store, async (threadId) => {
      hookThreadId = threadId;
      archivedAtInsideHook = agentStore.getThreadById(threadId)?.archivedAt;
    });

    const r = await postJson(app, "/api/agents/manager/new-chat", {});

    expect(r.status).toBe(200);
    expect(hookThreadId as string | null).toBe(old.id);
    expect(archivedAtInsideHook).toBe(null);
    expect(agentStore.getThreadById(old.id)?.archivedAt).toBeTruthy();
  } finally { cleanup(); }
});

test("POST /api/agents/manager/new-chat — does not wait for archive hook background work", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-ov-new-chat-async-hook-");
  try {
    await postJson(buildApp(agentStore, store), "/api/agents/manager/messages", { content: "remember later" });
    const old = agentStore.getThreadByScope("manager", null)!;
    let releaseHook!: () => void;
    let hookCompleted = false;
    const app = buildApp(agentStore, store, (threadId) => {
      expect(threadId).toBe(old.id);
      void new Promise<void>((resolve) => {
        releaseHook = resolve;
      }).then(() => {
        hookCompleted = true;
      });
    });

    const r = await postJson(app, "/api/agents/manager/new-chat", {});

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(hookCompleted).toBe(false);
    expect(agentStore.getThreadById(old.id)?.archivedAt).toBeTruthy();
    releaseHook();
    await Promise.resolve();
    expect(hookCompleted).toBe(true);
  } finally { cleanup(); }
});
