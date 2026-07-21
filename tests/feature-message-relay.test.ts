import { expect, test } from "bun:test";
import {
  featureMessageMetadata,
  featureMessageRequestMetadata
} from "../src/shared/feature-message.js";
import { relayFeatureMessageReply } from "../src/server/runtime/feature-message-relay.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("feature conversation reply returns to the caller without a task id", () => {
  const env = freshStoresEnv("md-feature-message-relay-");
  try {
    const projectId = seedProject(env.projects, { name: "Project" });
    const featureId = seedFeature(env.features, projectId, { name: "Feature" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const featureWake = env.agentStore.createWake({
      threadId: featureThread.id,
      reason: "user",
      triggerMessageId: null
    });
    env.agentStore.enqueueMailboxMessage({
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

    const wakeCalls: any[] = [];
    const replies = relayFeatureMessageReply(
      {
        agentStore: env.agentStore,
        featuresStore: env.features,
        wakeScheduler: {
          wake: (...args) => {
            wakeCalls.push(args);
            return "overview-wake";
          }
        }
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
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]![0]).toBe(callerThread.id);
    expect(wakeCalls[0]![1]).toBe("user");
    expect(env.agentStore.listPendingFeatureEvents(callerThread.id)).toEqual([]);
    const callerWake = env.agentStore.createWake({
      threadId: callerThread.id,
      reason: "user",
      triggerMessageId: null
    });
    const delivered = env.agentStore.drainMailboxToMessages(callerThread.id, callerWake.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.source).toBe("feature-message");
  } finally {
    env.cleanup();
  }
});

test("a recovered Worker still replies to the caller of the interrupted wake", () => {
  const env = freshStoresEnv("md-feature-recovery-relay-");
  try {
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
      wakeScheduler: { wake: () => "reply-wake" } }, { threadId: worker.id, wakeId: recovered.id, status: "finished" });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ threadId: caller.id, content: { text: "The build completed before the restart." } });
  } finally { env.cleanup(); }
});

test("ordinary feature wakes do not produce conversation replies", () => {
  const env = freshStoresEnv("md-feature-message-no-relay-");
  try {
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
        wakeScheduler: { wake: () => "unexpected" }
      },
      {
        threadId: featureThread.id,
        wakeId: wake.id,
        status: "finished"
      }
    );
    expect(replies).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("feature conversation replies return to an open side conversation", () => {
  const env = freshStoresEnv("md-feature-message-side-");
  try {
    const projectId = seedProject(env.projects, { name: "Project" });
    const featureId = seedFeature(env.features, projectId, { name: "Feature" });
    const overviewThread = env.agentStore.getOrCreateThread("manager", null);
    env.agentStore.appendMessage({
      threadId: overviewThread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "Main context" }
    });
    const sideThread = env.agentStore.createSideThread(overviewThread.id);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const featureWake = env.agentStore.createWake({
      threadId: featureThread.id,
      reason: "user",
      triggerMessageId: null
    });
    env.agentStore.enqueueMailboxMessage({
      threadId: featureThread.id,
      role: "user",
      source: "manager",
      sourceThreadId: sideThread.id,
      content: {
        type: "text",
        text: "Explain the parser.",
        metadata: featureMessageRequestMetadata()
      }
    });
    env.agentStore.drainMailboxToMessages(featureThread.id, featureWake.id);
    env.agentStore.appendMessage({
      threadId: featureThread.id,
      role: "assistant",
      source: "self",
      wakeId: featureWake.id,
      content: { type: "assistant", text: "It parses incrementally." }
    });

    const replies = relayFeatureMessageReply(
      {
        agentStore: env.agentStore,
        featuresStore: env.features,
        wakeScheduler: { wake: () => "side-wake" }
      },
      {
        threadId: featureThread.id,
        wakeId: featureWake.id,
        status: "finished"
      }
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]!.threadId).toBe(sideThread.id);
    expect(replies[0]!.source).toBe("feature-message");
  } finally {
    env.cleanup();
  }
});
