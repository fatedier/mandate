import { expect, test } from "bun:test";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import type { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import type { MandateStore } from "../../src/server/app/store.js";
import { buildAgentsTestApp, buildTestScopes, getJson, postJson } from "../helpers/test-app.js";
import { freshAgentEnv } from "../helpers/fixtures.js";

function buildAppWithRecorder(agentStore: AgentStore, store: MandateStore) {
  const wakes: Array<{ threadId: string; reason: string; msgId: string | null }> = [];
  const app = buildAgentsTestApp({
    agentStore,
    wakeScheduler: { wake: (threadId, reason, msgId) => {
      wakes.push({ threadId, reason, msgId });
      return `wake-${wakes.length}`;
    } },
    scopes: buildTestScopes(new FeaturesStore(store.db))
  });
  return { app, wakes };
}

test("POST /api/agents/manager/messages — creates singleton overview thread + appends user msg + schedules wake", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-ov-mflow-");
  try {
    const { app, wakes } = buildAppWithRecorder(agentStore, store);
    const r = await postJson(app, "/api/agents/manager/messages", { content: "hello overview" });
    expect(r.status).toBe(202);
    expect(r.body.messageId).toBeTruthy();
    expect(r.body.wakeId).toBeTruthy();
    expect(r.body.threadId).toBeTruthy();
    // Thread now exists
    const thread = agentStore.getThreadByScope("manager", null);
    expect(thread).toBeTruthy();
    expect(thread!.scope).toBe("manager");
    expect(thread!.scopeId).toBe(null);
    // Message appended
    const msgs = agentStore.getActiveMessages(thread!.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.source).toBe("user");
    expect((msgs[0]!.content as any).text).toBe("hello overview");
    // Wake fired
    expect(wakes.length).toBe(1);
    expect(wakes[0]!.reason).toBe("user");
  } finally { cleanup(); }
});

test("POST /api/agents/manager/messages — second message reuses singleton thread", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-ov-mflow-");
  try {
    const { app } = buildAppWithRecorder(agentStore, store);
    await postJson(app, "/api/agents/manager/messages", { content: "first" });
    const t1 = agentStore.getThreadByScope("manager", null)!;
    await postJson(app, "/api/agents/manager/messages", { content: "second" });
    const t2 = agentStore.getThreadByScope("manager", null)!;
    expect(t1.id).toBe(t2.id);
    const msgs = agentStore.getActiveMessages(t1.id);
    expect(msgs.length).toBe(2);
    expect((msgs[0]!.content as any).text).toBe("first");
    expect((msgs[1]!.content as any).text).toBe("second");
  } finally { cleanup(); }
});

test("POST /api/agents/manager/messages — empty content → 400", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-ov-mflow-");
  try {
    const { app } = buildAppWithRecorder(agentStore, store);
    const r = await postJson(app, "/api/agents/manager/messages", { content: "   " });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/content or image attachment is required/i);
  } finally { cleanup(); }
});

test("GET /api/agents/manager/thread — auto-creates singleton + returns empty messages on first call", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-ov-mflow-");
  try {
    const { app } = buildAppWithRecorder(agentStore, store);
    const r = await getJson(app, "/api/agents/manager/thread");
    expect(r.status).toBe(200);
    expect(r.body.thread).toBeTruthy();
    expect(r.body.thread.scope).toBe("manager");
    expect(r.body.thread.scopeId).toBe(null);
    expect(r.body.messages).toEqual([]);
  } finally { cleanup(); }
});

test("GET /api/agents/manager/thread — returns messages after they're added", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-ov-mflow-");
  try {
    const { app } = buildAppWithRecorder(agentStore, store);
    await postJson(app, "/api/agents/manager/messages", { content: "hi" });
    const r = await getJson(app, "/api/agents/manager/thread");
    expect(r.status).toBe(200);
    expect(r.body.messages.length).toBe(1);
    expect((r.body.messages[0].content as any).text).toBe("hi");
  } finally { cleanup(); }
});
