import { expect, test } from "bun:test";
import { freshAgentEnv } from "../helpers/fixtures.js";
import { AsyncManagerDispatcher } from "../../src/server/modules/voice/voice-async-dispatch.js";
import type { WakeFinishedEvent } from "../../src/server/modules/agent/wake-loop.js";

test("AsyncManagerDispatcher: invokes onResult with assistant text after wake finishes", async () => {
  const env = freshAgentEnv();
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    // Boxed so TS sees the write from inside the wakeManager callback.
    const scheduled: { wake: { threadId: string; reason: string } | null } = { wake: null };
    const results: { callId: string; result: string }[] = [];

    const d = new AsyncManagerDispatcher({
      agentStore: env.agentStore,
      wakeManager: (threadId, reason, _triggerMsgId) => {
        scheduled.wake = { threadId, reason };
        return "wake-1";
      },
      sendToolResult: (callId, payload) => {
        results.push({ callId, result: payload.result as string });
      }
    });

    d.start({ callId: "call_1", query: "what's running?" });
    expect(scheduled.wake?.threadId).toBe(thread.id);
    expect(scheduled.wake?.reason).toBe("user");

    const messages = env.agentStore.getActiveMessages(thread.id);
    expect(messages.length).toBe(1);
    expect(messages[0].source).toBe("user");
    expect((messages[0].content as any).text).toBe("what's running?");

    env.agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "self",
      wakeId: "wake-1",
      content: { type: "assistant", text: "Two features running." }
    });

    const event: WakeFinishedEvent = {
      threadId: thread.id, wakeId: "wake-1",
      reason: "user", status: "finished", triggerMessageId: messages[0].id
    };
    await d.onWakeFinished(event);

    expect(results.length).toBe(1);
    expect(results[0].callId).toBe("call_1");
    expect(results[0].result).toContain("Two features running.");
  } finally { env.cleanup(); }
});

test("AsyncManagerDispatcher: surfaces error result when wake fails", async () => {
  const env = freshAgentEnv();
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const results: { callId: string; errorMessage?: string; result?: unknown }[] = [];

    const d = new AsyncManagerDispatcher({
      agentStore: env.agentStore,
      wakeManager: () => "wake-1",
      sendToolResult: (callId, p) => results.push({ callId, ...p })
    });
    d.start({ callId: "call_2", query: "explain stuff" });

    await d.onWakeFinished({
      threadId: thread.id, wakeId: "wake-1", reason: "user",
      status: "error", triggerMessageId: null
    });

    expect(results[0].callId).toBe("call_2");
    expect(results[0].errorMessage).toContain("error");
  } finally { env.cleanup(); }
});

test("AsyncManagerDispatcher: ignores wake events for unknown call ids", async () => {
  const env = freshAgentEnv();
  try {
    const results: any[] = [];
    const d = new AsyncManagerDispatcher({
      agentStore: env.agentStore,
      wakeManager: () => "wake-1",
      sendToolResult: (cid, p) => results.push({ cid, ...p })
    });

    await d.onWakeFinished({
      threadId: "tid", wakeId: "wake-1", reason: "user",
      status: "finished", triggerMessageId: null
    });
    expect(results).toEqual([]);
  } finally { env.cleanup(); }
});
