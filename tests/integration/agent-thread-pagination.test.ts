import { expect, test } from "bun:test";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import type { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import type { MandateStore } from "../../src/server/app/store.js";
import { buildAgentsTestApp, buildTestScopes, getJson, postJson } from "../helpers/test-app.js";
import { freshAgentEnv, NOOP_WAKE, seedFeature, seedProject } from "../helpers/fixtures.js";

function appWith(deps: {
  agentStore: AgentStore;
  projects: ProjectsStore;
  features: FeaturesStore;
  wake?: (tid: string, reason: string, mid: string | null) => string | null;
  modelSupportsImage?: boolean;
  contextBudgetTokens?: number;
}) {
  return buildAgentsTestApp({
    agentStore: deps.agentStore,
    wakeScheduler: deps.wake ? { wake: deps.wake } : NOOP_WAKE,
    scopes: buildTestScopes(deps.features),
    contextBudgetTokens: deps.contextBudgetTokens,
    modelSupportsInput: (_scope, input) => input === "image" ? deps.modelSupportsImage ?? true : true
  });
}

function buildScene(store: MandateStore) {
  const projects = new ProjectsStore(store.db);
  const features = new FeaturesStore(store.db);
  const fid = seedFeature(features, seedProject(projects));
  return { projects, features, fid };
}

test("GET /thread on missing thread → empty payload (no 404)", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-api-");
  try {
    const { projects, features, fid } = buildScene(store);
    const app = appWith({ agentStore, projects, features });
    const r = await getJson(app, `/api/agents/workers/${fid}/thread`);
    expect(r.status).toBe(200);
    expect(r.body.thread).toBe(null);
    expect(r.body.messages).toEqual([]);
  } finally { cleanup(); }
});

test("GET /thread paginates: since=N returns full UI timeline messages with seq > N", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-api-");
  try {
    const { projects, features, fid } = buildScene(store);
    const thread = agentStore.getOrCreateThread("worker", fid);
    for (let i = 0; i < 5; i++) {
      agentStore.appendMessage({
        threadId: thread.id, role: "user", source: "user",
        content: { type: "text", text: `m${i}` }
      });
    }
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "compression",
      content: {
        type: "summary", summary: "summarized",
        replacedRange: [1, 2], replacedCount: 2
      }
    });
    const app = appWith({ agentStore, projects, features });
    const r = await getJson(app, `/api/agents/workers/${fid}/thread?since=0`);
    expect(r.status).toBe(200);
    expect(r.body.messages.length).toBe(6);
    expect(r.body.messages.map((m: any) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  } finally { cleanup(); }
});

test("GET /thread paginates older UI history with before cursor", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-api-");
  try {
    const { projects, features, fid } = buildScene(store);
    const thread = agentStore.getOrCreateThread("worker", fid);
    for (let i = 0; i < 5; i++) {
      agentStore.appendMessage({
        threadId: thread.id, role: "user", source: "user",
        content: { type: "text", text: `m${i + 1}` }
      });
    }
    const app = appWith({ agentStore, projects, features });

    const first = await getJson(app, `/api/agents/workers/${fid}/thread?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.messages.map((m: any) => m.seq)).toEqual([4, 5]);
    expect(first.body.hasMore).toBe(true);

    const second = await getJson(app, `/api/agents/workers/${fid}/thread?limit=2&before=4`);
    expect(second.body.messages.map((m: any) => m.seq)).toEqual([2, 3]);
    expect(second.body.hasMore).toBe(true);

    const third = await getJson(app, `/api/agents/workers/${fid}/thread?limit=2&before=2`);
    expect(third.body.messages.map((m: any) => m.seq)).toEqual([1]);
    expect(third.body.hasMore).toBe(false);
  } finally { cleanup(); }
});

test("GET /thread includes latest context budget usage when configured", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-api-");
  try {
    const { projects, features, fid } = buildScene(store);
    const thread = agentStore.getOrCreateThread("worker", fid);
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const wake = agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: null
    });
    agentStore.updateWakeTokenUsage(wake.id, 85_000, 85_000);
    agentStore.finishWake(wake.id, "finished");

    const app = appWith({ agentStore, projects, features, contextBudgetTokens: 170_000 });
    const r = await getJson(app, `/api/agents/workers/${fid}/thread`);
    expect(r.status).toBe(200);
    expect(r.body.contextUsage).toMatchObject({
      inputTokens: 85_000,
      budgetTokens: 170_000,
      source: "compression_budget"
    });
  } finally { cleanup(); }
});

test("POST /messages: returns messageId + wakeId, triggers wake", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-api-");
  try {
    const { projects, features, fid } = buildScene(store);
    let wokenWith: { tid: string; reason: string; mid: string | null } | null = null;
    const app = appWith({
      agentStore, projects, features,
      wake: (tid, reason, mid) => {
        wokenWith = { tid, reason, mid };
        return "wake-test";
      }
    });
    const r = await postJson(app, `/api/agents/workers/${fid}/messages`, { content: "hi" });
    expect(r.status).toBe(202);
    expect(r.body.messageId).toBeTruthy();
    expect(r.body.wakeId).toBeTruthy();
    expect(r.body.threadId).toBeTruthy();
    expect(wokenWith).toBeTruthy();
    expect(wokenWith!.reason).toBe("user");
  } finally { cleanup(); }
});

test("POST /messages: image attachment is persisted when model supports image input", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-api-");
  try {
    const { projects, features, fid } = buildScene(store);
    const app = appWith({ agentStore, projects, features, modelSupportsImage: true });
    const attachment = {
      type: "image" as const,
      id: "img-test",
      name: "shot.png",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
      sizeBytes: 8
    };
    const r = await postJson(app, `/api/agents/workers/${fid}/messages`, {
      content: "look at this",
      attachments: [attachment]
    });
    expect(r.status).toBe(202);
    const thread = agentStore.getThreadByScope("worker", fid)!;
    const [message] = agentStore.getActiveMessages(thread.id);
    expect(message!.content).toEqual({
      type: "text",
      text: "look at this",
      attachments: [attachment]
    });
  } finally { cleanup(); }
});

test("POST /messages: image attachment is rejected when model lacks image input", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-api-");
  try {
    const { projects, features, fid } = buildScene(store);
    const app = appWith({ agentStore, projects, features, modelSupportsImage: false });
    const r = await postJson(app, `/api/agents/workers/${fid}/messages`, {
      content: "look",
      attachments: [{
        type: "image",
        id: "img-test",
        mediaType: "image/png",
        data: "iVBORw0KGgo=",
        sizeBytes: 8
      }]
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not support image/i);
  } finally { cleanup(); }
});

test("POST /messages: 404 on archived feature", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-api-");
  try {
    const { projects, features, fid } = buildScene(store);
    features.archive(fid);
    const app = appWith({ agentStore, projects, features });
    const r = await postJson(app, `/api/agents/workers/${fid}/messages`, { content: "hi" });
    expect(r.status).toBe(404);
  } finally { cleanup(); }
});

test("GET /wakes/:id: returns wake row with messageIds", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-api-");
  try {
    const { projects, features, fid } = buildScene(store);
    const thread = agentStore.getOrCreateThread("worker", fid);
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "go" }
    });
    const wake = agentStore.createWake({
      threadId: thread.id, reason: "user", triggerMessageId: trigger.id
    });
    const app = appWith({ agentStore, projects, features });
    const r = await getJson(app, `/api/agents/wakes/${wake.id}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(wake.id);
    expect(r.body.messageIds).toEqual([trigger.id]);
  } finally { cleanup(); }
});

test("GET /active-wakes: lists running wakes with scope info and excludes finished ones", async () => {
  const { store, agentStore, cleanup } = freshAgentEnv("md-api-");
  try {
    const { projects, features, fid } = buildScene(store);
    const featureThread = agentStore.getOrCreateThread("worker", fid);
    const overviewThread = agentStore.getOrCreateThread("manager", null);
    const done = agentStore.createWake({
      threadId: featureThread.id, reason: "user", triggerMessageId: null
    });
    agentStore.finishWake(done.id, "finished");
    const runningFeature = agentStore.createWake({
      threadId: featureThread.id, reason: "user", triggerMessageId: null
    });
    const runningOverview = agentStore.createWake({
      threadId: overviewThread.id, reason: "feature-event", triggerMessageId: null
    });

    const app = appWith({ agentStore, projects, features });
    const r = await getJson(app, "/api/agents/active-wakes");
    expect(r.status).toBe(200);
    const wakes = r.body.wakes as Array<{
      threadId: string; wakeId: string; scope: string; scopeId: string | null;
    }>;
    expect(wakes.map((w) => w.wakeId).sort()).toEqual(
      [runningFeature.id, runningOverview.id].sort()
    );
    expect(wakes.find((w) => w.wakeId === runningFeature.id)).toMatchObject({
      threadId: featureThread.id, scope: "worker", scopeId: fid
    });
    expect(wakes.find((w) => w.wakeId === runningOverview.id)).toMatchObject({
      threadId: overviewThread.id, scope: "manager", scopeId: null
    });
  } finally { cleanup(); }
});
