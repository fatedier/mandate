import { expect, test } from "bun:test";
import {
  featureMessageMetadata,
  featureMessageRequestMetadata,
  type FeatureReplyOutcome
} from "../src/shared/feature-message.js";
import type { AgentWakeStatus } from "../src/shared/api/agents.js";
import { relayFeatureMessageReply } from "../src/server/runtime/feature-message-relay.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { recordingInbox } from "./helpers/upward-inbox.js";
import { parseCut } from "./helpers/cut-line.js";

test("feature conversation reply returns to the caller without a task id", () => {
  const env = freshStoresEnv("md-feature-message-relay-");
  const projectId = seedProject(env.projects, { name: "Project" });
  const featureId = seedFeature(env.features, projectId, { name: "Feature" });
  const callerThread = env.agentStore.getOrCreateThread("manager", null);
  const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
  const featureWake = env.agentStore.createWake({
    threadId: featureThread.id,
    reason: "user",
    triggerMessageId: null
  });
  const request = env.agentStore.enqueueMailboxMessage({
    threadId: featureThread.id,
    role: "user",
    source: "manager",
    sourceThreadId: callerThread.id,
    content: {
      type: "text",
      text: "What is the current approach?",
      metadata: featureMessageRequestMetadata()
    }
  });
  env.agentStore.drainMailboxToMessages(featureThread.id, featureWake.id);
  env.agentStore.appendMessage({
    threadId: featureThread.id,
    role: "assistant",
    source: "self",
    wakeId: featureWake.id,
    content: { type: "assistant", text: "We are keeping the parser incremental." }
  });
  env.agentStore.finishWake(featureWake.id, "finished");

  const { inbox, wakes } = recordingInbox(env.agentStore);
  const replies = relayFeatureMessageReply(
    {
      agentStore: env.agentStore,
      featuresStore: env.features,
      inbox
    },
    {
      threadId: featureThread.id,
      wakeId: featureWake.id,
      status: "finished"
    }
  );

  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({
    threadId: callerThread.id,
    source: "feature-message",
    sourceThreadId: featureThread.id,
    content: {
      type: "text",
      text: "We are keeping the parser incremental."
    }
  });
  expect(featureMessageMetadata(replies[0]!.content)).toEqual({
    direction: "reply",
    featureId,
    featureName: "Feature"
  });
  // A report on the message it answers.
  expect((replies[0]!.content as { metadata?: Record<string, unknown> }).metadata?.inbox).toStrictEqual({ kind: "report", key: `feature-message:${request.id}` });
  expect(wakes).toStrictEqual([{ threadId: callerThread.id, reason: "user" }]);
  expect(env.agentStore.queuedMailboxSources(callerThread.id)).toEqual(["feature-message"]);
  const callerWake = env.agentStore.createWake({
    threadId: callerThread.id,
    reason: "user",
    triggerMessageId: null
  });
  const delivered = env.agentStore.drainMailboxToMessages(callerThread.id, callerWake.id);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.source).toBe("feature-message");
});

test("a recovered Worker still replies to the caller of the interrupted wake", () => {
  const env = freshStoresEnv("md-feature-recovery-relay-");
  const projectId = seedProject(env.projects);
  const featureId = seedFeature(env.features, projectId);
  const caller = env.agentStore.getOrCreateThread("manager", null);
  const worker = env.agentStore.getOrCreateThread("worker", featureId);
  const original = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
  env.agentStore.enqueueMailboxMessage({ threadId: worker.id, role: "user", source: "manager",
    sourceThreadId: caller.id, content: { type: "text", text: "Check progress.", metadata: featureMessageRequestMetadata() } });
  env.agentStore.drainMailboxToMessages(worker.id, original.id);
  env.agentStore.recoverInterruptedWakes("restart");
  const recovered = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
  env.agentStore.drainMailboxToMessages(worker.id, recovered.id);
  env.agentStore.appendMessage({ threadId: worker.id, role: "assistant", source: "self", wakeId: recovered.id,
    content: { type: "assistant", text: "The build completed before the restart." } });
  env.agentStore.finishWake(recovered.id, "finished");
  const replies = relayFeatureMessageReply({ agentStore: env.agentStore, featuresStore: env.features,
    inbox: recordingInbox(env.agentStore).inbox }, { threadId: worker.id, wakeId: recovered.id, status: "finished" });
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ threadId: caller.id, content: { text: "The build completed before the restart." } });
});

test("ordinary feature wakes do not produce conversation replies", () => {
  const env = freshStoresEnv("md-feature-message-no-relay-");
  const projectId = seedProject(env.projects, { name: "Project" });
  const featureId = seedFeature(env.features, projectId, { name: "Feature" });
  const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
  const wake = env.agentStore.createWake({
    threadId: featureThread.id,
    reason: "user",
    triggerMessageId: null
  });
  env.agentStore.appendMessage({
    threadId: featureThread.id,
    role: "assistant",
    source: "self",
    wakeId: wake.id,
    content: { type: "assistant", text: "Normal feature response" }
  });

  const replies = relayFeatureMessageReply(
    {
      agentStore: env.agentStore,
      featuresStore: env.features,
      inbox: recordingInbox(env.agentStore).inbox
    },
    {
      threadId: featureThread.id,
      wakeId: wake.id,
      status: "finished"
    }
  );
  expect(replies).toEqual([]);
});

// A turn that ends with no words for its manager still answers it: a
// sentence the manager's model reads, and what happened stored beside it for
// the thread to draw ("Worker failed", not "Worker replied").
const ENDINGS: Array<{ status: Exclude<AgentWakeStatus, "running">; error: string | null; text: string; meta: { outcome: FeatureReplyOutcome; detail?: string } }> = [
  { status: "error", error: "Model provider authentication failed.", text: "The worker's turn failed: Model provider authentication failed.", meta: { outcome: "error", detail: "Model provider authentication failed." } },
  { status: "error", error: null, text: "The worker's turn failed: unknown error", meta: { outcome: "error" } },
  { status: "canceled", error: null, text: "The worker's turn was stopped before it replied.", meta: { outcome: "canceled" } },
  { status: "stuck", error: "read failed 5 times in a row: ENOENT", text: "The worker stopped: read failed 5 times in a row: ENOENT", meta: { outcome: "stuck", detail: "read failed 5 times in a row: ENOENT" } },
  { status: "stuck", error: null, text: "The worker stopped: the same call kept failing", meta: { outcome: "stuck" } },
  { status: "finished", error: null, text: "The worker finished its turn without a text reply.", meta: { outcome: "no_reply" } }
];
for (const stop of ENDINGS) {
  test(`a turn that ends ${stop.status}${stop.error ? "" : " (no message)"} with no text reply tells the caller what happened`, () => {
    const env = freshStoresEnv("md-feature-message-stop-");
    const projectId = seedProject(env.projects, { name: "Project" });
    const featureId = seedFeature(env.features, projectId, { name: "Feature" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const featureWake = env.agentStore.createWake({ threadId: featureThread.id, reason: "user", triggerMessageId: null });
    env.agentStore.enqueueMailboxMessage({
      threadId: featureThread.id, role: "user", source: "manager", sourceThreadId: callerThread.id,
      content: { type: "text", text: "Status?", metadata: featureMessageRequestMetadata() }
    });
    env.agentStore.drainMailboxToMessages(featureThread.id, featureWake.id);
    env.agentStore.finishWake(featureWake.id, stop.status, stop.error);
    const replies = relayFeatureMessageReply(
      { agentStore: env.agentStore, featuresStore: env.features, inbox: recordingInbox(env.agentStore).inbox },
      { threadId: featureThread.id, wakeId: featureWake.id, status: stop.status }
    );
    expect(replies.map((reply) => reply.content)).toMatchObject([{ type: "text", text: stop.text }]);
    expect(featureMessageMetadata(replies[0]!.content)).toEqual({ direction: "reply", featureId, featureName: "Feature", ...stop.meta });
  });
}

test("what a reply stores of its turn's ending is read back only when it is one of the endings", () => {
  const read = (featureMessage: Record<string, unknown>) => featureMessageMetadata({ type: "text", text: "x", metadata: { featureMessage } });
  expect(read({ direction: "reply", featureId: "f", outcome: "error", detail: "boom" })).toEqual({ direction: "reply", featureId: "f", outcome: "error", detail: "boom" });
  // Anything else is a reply with words, as every reply stored before was.
  expect(read({ direction: "reply", featureId: "f", outcome: "exploded", detail: "boom" })).toEqual({ direction: "reply", featureId: "f" });
  expect(read({ direction: "reply", featureId: "f", detail: "boom" })).toEqual({ direction: "reply", featureId: "f" });
  expect(read({ direction: "reply", featureId: "f", outcome: "stuck", detail: 7 })).toEqual({ direction: "reply", featureId: "f", outcome: "stuck" });
});

test("a reply to two callers is one write: the second refused, neither is sent, and the next try sends both once", () => {
  const env = freshStoresEnv("md-feature-message-relay-two-");
  const projectId = seedProject(env.projects, { name: "Project" });
  const featureId = seedFeature(env.features, projectId, { name: "Feature" });
  const manager = env.agentStore.getOrCreateThread("manager", null);
  const global = env.agentStore.getOrCreateGlobalThread();
  const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
  const wake = env.agentStore.createWake({ threadId: featureThread.id, reason: "user", triggerMessageId: null });
  for (const caller of [manager, global]) {
    env.agentStore.enqueueMailboxMessage({
      threadId: featureThread.id, role: "user", source: "manager", sourceThreadId: caller.id,
      content: { type: "text", text: "Where are we?", metadata: featureMessageRequestMetadata() }
    });
  }
  env.agentStore.drainMailboxToMessages(featureThread.id, wake.id);
  env.agentStore.appendMessage({ threadId: featureThread.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "Halfway." } });
  env.agentStore.finishWake(wake.id, "finished");
  const { inbox, wakes } = recordingInbox(env.agentStore);
  const deps = { agentStore: env.agentStore, featuresStore: env.features, inbox };
  const replies = () => (env.store.db.prepare("select thread_id from agent_mailbox where source = 'feature-message'").all() as Array<{ thread_id: string }>).map((r) => r.thread_id).sort();
  const real = env.agentStore.enqueueMailboxMessage.bind(env.agentStore);
  let calls = 0;
  env.agentStore.enqueueMailboxMessage = (input) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return real(input);
  };
  const input = { threadId: featureThread.id, wakeId: wake.id, status: "finished" as AgentWakeStatus };
  expect(() => relayFeatureMessageReply(deps, input)).toThrow("database is locked");
  expect(replies()).toEqual([]);
  // Nothing went in, so no one is woken for it.
  expect(wakes).toStrictEqual([]);
  expect(relayFeatureMessageReply(deps, input)).toHaveLength(2);
  expect(replies()).toEqual([manager.id, global.id].sort());
});

test("a caller who sent two messages to one turn gets one reply, keyed on the later message", () => {
  const env = freshStoresEnv("md-feature-message-relay-two-asks-");
  const projectId = seedProject(env.projects, { name: "Project" });
  const featureId = seedFeature(env.features, projectId, { name: "Feature" });
  const manager = env.agentStore.getOrCreateThread("manager", null);
  const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
  const wake = env.agentStore.createWake({ threadId: featureThread.id, reason: "user", triggerMessageId: null });
  const asks = ["Where are we?", "And the tests?"].map((text) => env.agentStore.enqueueMailboxMessage({
    threadId: featureThread.id, role: "user", source: "manager", sourceThreadId: manager.id,
    content: { type: "text", text, metadata: featureMessageRequestMetadata() }
  }));
  // Written a second apart: one millisecond apart would order by random ids.
  env.store.db.prepare("update agent_mailbox set created_at = ? where id = ?").run("2026-10-29T10:00:00.000Z", asks[0]!.id);
  env.store.db.prepare("update agent_mailbox set created_at = ? where id = ?").run("2026-10-29T10:00:01.000Z", asks[1]!.id);
  env.agentStore.drainMailboxToMessages(featureThread.id, wake.id);
  env.agentStore.appendMessage({ threadId: featureThread.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "Halfway; tests pass." } });
  env.agentStore.finishWake(wake.id, "finished");
  const replies = relayFeatureMessageReply(
    { agentStore: env.agentStore, featuresStore: env.features, inbox: recordingInbox(env.agentStore).inbox },
    { threadId: featureThread.id, wakeId: wake.id, status: "finished" }
  );
  expect(replies.map((reply) => (reply.content as { metadata?: Record<string, unknown> }).metadata?.inbox))
    .toStrictEqual([{ kind: "report", key: `feature-message:${asks[1]!.id}` }]);
});

test("a worker's reply over 20,000 characters goes up cut there, the whole saved for its caller", () => {
  const env = freshStoresEnv("md-feature-message-relay-long-");
  const projectId = seedProject(env.projects, { name: "Project" });
  const featureId = seedFeature(env.features, projectId, { name: "Feature" });
  const manager = env.agentStore.getOrCreateThread("manager", null);
  const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
  const wake = env.agentStore.createWake({ threadId: featureThread.id, reason: "user", triggerMessageId: null });
  env.agentStore.enqueueMailboxMessage({
    threadId: featureThread.id, role: "user", source: "manager", sourceThreadId: manager.id,
    content: { type: "text", text: "Paste the whole log.", metadata: featureMessageRequestMetadata() }
  });
  env.agentStore.drainMailboxToMessages(featureThread.id, wake.id);
  const log = `${"l".repeat(24_999)}#`;
  env.agentStore.appendMessage({ threadId: featureThread.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: log } });
  env.agentStore.finishWake(wake.id, "finished");
  const [reply] = relayFeatureMessageReply(
    { agentStore: env.agentStore, featuresStore: env.features, inbox: recordingInbox(env.agentStore).inbox },
    { threadId: featureThread.id, wakeId: wake.id, status: "finished" }
  );
  expect(parseCut((reply!.content as { text: string }).text)).toEqual({ kept: "l".repeat(20_000), first: 20_000, of: 25_000, whole: log });
});
