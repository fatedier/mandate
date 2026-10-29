import { expect, test } from "bun:test";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import type { AgentWakeMetadata, AgentWakeReason } from "../../src/shared/api-contracts.js";
import { buildAgentsTestApp, buildTestScopes, postJson } from "../helpers/test-app.js";
import { freshAgentEnv, NOOP_WAKE, seedFeature, seedProject } from "../helpers/fixtures.js";

// A failed turn whose line is still the thread's last message can be run again
// as it was first run — the rule the page draws its Retry by.

type WakeCall = [string, AgentWakeReason, string | null, AgentWakeMetadata | null | undefined];

function scene(prefix: string, wake: (...args: WakeCall) => string | null = NOOP_WAKE.wake) {
  const env = freshAgentEnv(prefix);
  const features = new FeaturesStore(env.store.db);
  const featureId = seedFeature(features, seedProject(new ProjectsStore(env.store.db)));
  const app = buildAgentsTestApp({ agentStore: env.agentStore, wakeScheduler: { wake }, scopes: buildTestScopes(features) });
  return { ...env, featureId, app };
}

function failedTurn(agent: ReturnType<typeof freshAgentEnv>["agentStore"], threadId: string, reason: AgentWakeReason = "user", metadata: AgentWakeMetadata | null = null) {
  const ask = agent.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: "Draft the release notes" } });
  const wake = agent.createWake({ threadId, reason, triggerMessageId: ask.id, metadata });
  agent.finishWake(wake.id, "error", "Model request timed out. Please retry.");
  // As the wake loop leaves it: the failure's row, after everything else.
  agent.appendMessage({
    threadId, role: "system", source: "wake-failure", wakeId: wake.id,
    content: { type: "wake_failure", status: "error", message: "Model request timed out. Please retry.", stepCount: 0 }
  });
  return { ask, wake };
}

test("retrying the newest failed wake runs it again as it was first run, continuing it", async () => {
  const calls: WakeCall[] = [];
  const s = scene("md-failed-api-", (...args) => { calls.push(args); return "wake_retry"; });
  try {
    const thread = s.agentStore.createManagerThread("t");
    const metadata: AgentWakeMetadata = { recovery: { wakeIds: ["wake_before"], originalReason: "work-item-heartbeat", originalTriggerMessageId: null } };
    const { ask, wake } = failedTurn(s.agentStore, thread.id, "work-item-heartbeat", metadata);
    const r = await postJson(s.app, `/api/agents/wakes/${wake.id}/retry`, {});
    expect(r).toEqual({ status: 200, body: { ok: true, wakeId: "wake_retry" } });
    // It continues the failed wake as a restart's recovery does: what was
    // delivered to the failed wake (a manager's request a reply is owed to)
    // is found through it, and the original reason still holds.
    expect(calls).toStrictEqual([[thread.id, "work-item-heartbeat", ask.id, {
      recovery: { wakeIds: ["wake_before", wake.id], originalReason: "work-item-heartbeat", originalTriggerMessageId: null }
    }]]);
  } finally { s.cleanup(); }
});

test("only a failure still last in its thread, and only an error, can be retried", async () => {
  const calls: WakeCall[] = [];
  const s = scene("md-failed-api-", (...args) => { calls.push(args); return "wake_retry"; });
  try {
    const thread = s.agentStore.createManagerThread("t");
    const { ask, wake: older } = failedTurn(s.agentStore, thread.id);
    // A later turn that said something, if only an empty reply.
    const later = s.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: ask.id });
    s.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: later.id, content: { type: "assistant", text: "" } });
    s.agentStore.finishWake(later.id, "finished");
    expect((await postJson(s.app, `/api/agents/wakes/${older.id}/retry`, {})).status).toBe(409);
    const limited = s.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: ask.id });
    s.agentStore.finishWake(limited.id, "stuck");
    expect((await postJson(s.app, `/api/agents/wakes/${limited.id}/retry`, {})).status).toBe(409);
    // Another failure since: its line is last, not the older one's.
    failedTurn(s.agentStore, thread.id);
    expect((await postJson(s.app, `/api/agents/wakes/${older.id}/retry`, {})).status).toBe(409);
    expect((await postJson(s.app, "/api/agents/wakes/wake_missing/retry", {})).status).toBe(404);
    expect(calls).toStrictEqual([]);
  } finally { s.cleanup(); }
});

test("a retry stopped before it wrote anything leaves the failure it retried retryable", async () => {
  const calls: WakeCall[] = [];
  const s = scene("md-failed-api-", (...args) => { calls.push(args); return "wake_retry"; });
  try {
    const thread = s.agentStore.createManagerThread("t");
    const { ask, wake } = failedTurn(s.agentStore, thread.id);
    // The retry ran and was stopped at once: a newer wake, and no row.
    const stopped = s.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: ask.id });
    s.agentStore.finishWake(stopped.id, "canceled", "Stopped by user.");
    expect((await postJson(s.app, `/api/agents/wakes/${wake.id}/retry`, {})).status).toBe(200);
    expect(calls).toHaveLength(1);
  } finally { s.cleanup(); }
});

test("a retry the scheduler refuses (a turn already running, a closed thread) says so", async () => {
  const s = scene("md-failed-api-", () => null);
  try {
    const thread = s.agentStore.createManagerThread("t");
    const { wake } = failedTurn(s.agentStore, thread.id);
    const r = await postJson(s.app, `/api/agents/wakes/${wake.id}/retry`, {});
    expect(r.status).toBe(409);
    expect(typeof r.body.error).toBe("string");
  } finally { s.cleanup(); }
});

test("a failed wake with no recovery behind it starts the chain", async () => {
  const calls: WakeCall[] = [];
  const s = scene("md-failed-api-", (...args) => { calls.push(args); return "wake_retry"; });
  try {
    const thread = s.agentStore.getOrCreateThread("worker", s.featureId);
    const { ask, wake } = failedTurn(s.agentStore, thread.id);
    expect((await postJson(s.app, `/api/agents/wakes/${wake.id}/retry`, {})).status).toBe(200);
    expect(calls).toStrictEqual([[thread.id, "user", ask.id, {
      recovery: { wakeIds: [wake.id], originalReason: "user", originalTriggerMessageId: ask.id }
    }]]);
  } finally { s.cleanup(); }
});
