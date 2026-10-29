import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";
import {
  estimateMessagesTokens,
  getCompressionGateDecision,
  hasSomethingToCompact,
  runCompression
} from "../src/server/modules/agent/compression.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import type { StepPrompt, WakeLlmCandidate, WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { ToolDispatcher, ToolRegistry } from "../src/server/modules/agent/tool-registry.js";
import { ANTHROPIC_CACHE_CONTROL } from "../src/server/modules/llm/anthropic-cache.js";
import {
  buildLocalCompressionMessages,
  createAgentCompressionController
} from "../src/server/runtime/agent-compression-controller.js";
import { runAgentCompressionLlm } from "../src/server/runtime/agent-compression-llm.js";
import { OUTPUT_LIMIT_FAILURE } from "../src/server/modules/llm/output-limit-failure.js";
import { prepareAiSdkMessages } from "../src/server/modules/agent/wake-message-adapter.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import { freshAgentEnv, freshStoresEnv } from "./helpers/fixtures.js";
import { contentOf, stub } from "./helpers/typed.js";
import type { LanguageModelV3, SharedV3ProviderOptions } from "@ai-sdk/provider";
import { z } from "zod";
import type { Config } from "../src/server/config.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { AgentMessageDto } from "../src/shared/api/agents.js";

const cfg = { thresholdTokens: 100 };
const fresh = () => freshAgentEnv("md-cmp-");
/** The controller reads only the compression threshold from its config. */
const configWithThreshold = (compressionThresholdTokens: number) =>
  stub<Config>({ agent: stub<Config["agent"]>({ compressionThresholdTokens }) });

function msg(overrides: Partial<AgentMessageDto> & Pick<AgentMessageDto, "content">): AgentMessageDto {
  return {
    id: overrides.id ?? "m1",
    threadId: overrides.threadId ?? "t1",
    seq: overrides.seq ?? 1,
    role: overrides.role ?? "user",
    source: overrides.source ?? "user",
    sourceThreadId: overrides.sourceThreadId ?? null,
    wakeId: overrides.wakeId ?? null,
    content: overrides.content,
    createdAt: overrides.createdAt ?? "2026-05-15T00:00:00.000Z"
  };
}

test("with no observed prompt the gate estimates: below the threshold it waits, above it compresses", () => {
  const below = [msg({ content: { type: "text", text: "x".repeat(50) } })];
  const above = [msg({ content: { type: "text", text: "x".repeat(800) } })];
  expect(getCompressionGateDecision(below, cfg).shouldCompress).toBe(false);
  expect(getCompressionGateDecision(above, cfg).shouldCompress).toBe(true);
});

test("the gate's estimate weighs CJK text, not its raw character count", () => {
  const below = [msg({ content: { type: "text", text: "你".repeat(70) } })];
  const above = [msg({ content: { type: "text", text: "你".repeat(100) } })];
  expect(getCompressionGateDecision(below, cfg).shouldCompress).toBe(false);
  expect(getCompressionGateDecision(above, cfg).shouldCompress).toBe(true);
});

test("the compression gate: uses previous real input tokens plus new message estimate", () => {
  const msgs = [
    msg({ seq: 1, content: { type: "text", text: "old" } }),
    msg({ seq: 2, content: { type: "text", text: "new ".repeat(80) } })
  ];
  expect(getCompressionGateDecision(msgs, cfg, {
    previousInputTokens: 90,
    previousPromptMaxSeq: 1
  }).shouldCompress).toBe(true);
});

test("the compression gate: observed previous prompt wins over active estimate", () => {
  const msgs = [
    msg({ seq: 1, content: { type: "text", text: "old ".repeat(300) } }),
    msg({ seq: 2, content: { type: "text", text: "new" } })
  ];
  const decision = getCompressionGateDecision(msgs, cfg, {
    previousInputTokens: 50,
    previousPromptMaxSeq: 1
  });
  expect(decision.strategy).toBe("previous_input_plus_new_messages");
  expect(decision.estimatedActiveTokens).toBeGreaterThan(100);
  expect(decision.projectedTokens).toBeLessThan(100);
  expect(decision.shouldCompress).toBe(false);
});

test("the compression gate: an observed prompt at the threshold compresses though the estimate is tiny", () => {
  const msgs = [msg({ seq: 1, content: { type: "text", text: "x" } })];
  const decision = getCompressionGateDecision(msgs, cfg, {
    previousInputTokens: 100,
    previousPromptMaxSeq: 1
  });
  expect(decision.estimatedActiveTokens).toBeLessThan(100);
  expect(decision.shouldCompress).toBe(true);
});

test("the compression gate: fallback estimate includes append-only runtime context", () => {
  const msgs = [
    msg({
      seq: 1,
      source: "runtime-context",
      content: { type: "text", text: `[runtime_context]\n${"stale ".repeat(500)}` }
    }),
    msg({
      seq: 2,
      source: "runtime-context",
      content: { type: "text", text: "[runtime_context]\ncurrent" }
    })
  ];
  expect(getCompressionGateDecision(msgs, cfg).shouldCompress).toBe(true);
});

test("the compression gate: ignores previous token signal after compression rewrites history", () => {
  const msgs = [
    msg({
      seq: 3,
      source: "compression",
      content: { type: "summary", summary: "short", replacedRange: [1, 2], replacedCount: 2, retained: [] }
    }),
    msg({ seq: 4, source: "user", content: { type: "text", text: "next" } })
  ];
  expect(getCompressionGateDecision(msgs, cfg, {
    previousInputTokens: 99,
    previousPromptMaxSeq: 2
  }).shouldCompress).toBe(false);
});

// Idle compaction: the summary says it ran on idle, and how many minutes it
// waited; any other compaction's says nothing of it.
test("runCompression: a summary carries its idle tag", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const run = async (summaryTag?: { trigger: "idle"; idleMinutes: number }) => {
      const thread = agentStore.createManagerThread("project-1 3.22 release");
      agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } });
      agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "text", text: "assistant detail" } });
      agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest user intent" } });
      const result = await runCompression({ agentStore, summarizer: async () => ({ summaryText: "summary" }), ...(summaryTag ? { summaryTag } : {}) }, thread.id);
      return contentOf(result!.summaryMessage, "summary");
    };
    expect(await run({ trigger: "idle", idleMinutes: 55 })).toMatchObject({ trigger: "idle", idleMinutes: 55 });
    const plain = await run();
    expect(["trigger" in plain, "idleMinutes" in plain]).toEqual([false, false]);
  } finally { cleanup(); }
});

test("runCompression: a reply after the kept user turn is replaced, not kept", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-after-intent");
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } });
    agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "text", text: "assistant detail" } });
    const latest = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest user intent" } });
    agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "text", text: "post intent detail" } });
    const result = await runCompression({ agentStore, summarizer: async () => ({ summaryText: "summary" }) }, thread.id);
    expect(agentStore.getActiveMessages(thread.id).map((m) => m.id)).toEqual([latest.id, result!.summaryMessage.id]);
    expect(contentOf(result!.summaryMessage, "summary").replacedCount).toBe(3);
  } finally { cleanup(); }
});

// A voice transcript can be written to the global thread while its summariser
// runs; it lands behind the summary, out of the window, and leaves with the
// hidden messages so extraction still reads every message once.
test("runCompression: a row written while the summariser runs leaves with the hidden ones", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-late");
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } });
    agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "text", text: "assistant detail" } });
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest user intent" } });
    let late: { id: string } | null = null;
    const result = await runCompression({ agentStore, summarizer: async () => {
      late = agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "voice", content: { type: "text", text: "spoken meanwhile" } });
      return { summaryText: "summary" };
    } }, thread.id);
    const hidden = result!.hiddenMessages.map((m) => m.id);
    expect(hidden).toContain(late!.id);
    // The boundary counts every row this compaction hid, the late one too.
    expect(contentOf(result!.summaryMessage, "summary").compactedCount).toBe(hidden.length);
    const active = agentStore.getActiveMessages(thread.id).map((m) => m.id);
    const every = agentStore.getMessages(thread.id).filter((m) => m.id !== result!.summaryMessage.id).map((m) => m.id);
    expect([...hidden, ...active.filter((id) => id !== result!.summaryMessage.id)].sort()).toEqual(every.sort());
  } finally { cleanup(); }
});

test("runCompression: appends summary message without mutating old messages", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "old ".repeat(90_000) }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "assistant detail" }
    });
    const latest = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "latest user intent" }
    });
    const calls: any[] = [];
    const summarizer = async (toSummarize: any[]) => {
      calls.push(toSummarize);
      return { summaryText: "summarized" };
    };
    const before = agentStore.getMessages(thread.id);
    const result = await runCompression({ agentStore, summarizer }, thread.id);
    expect(calls.length).toBe(1);
    expect(calls[0].map((m: any) => m.seq)).toEqual([1, 2, 3]);
    expect(result?.summaryMessage.seq).toBe(4);
    const active = agentStore.getActiveMessages(thread.id);
    // The latest user turn survives verbatim alongside the summary; a summary
    // paraphrases, and user instructions must not be paraphrased.
    expect(active.length).toBe(2);
    expect(active.map((m) => m.source)).toEqual(["user", "compression"]);
    expect(contentOf(active[0], "text").text).toBe("latest user intent");
    expect(active[1].role).toBe("user");
    expect(active[1].content.type).toBe("summary");
    // Two, not three: the summariser read all three messages, but the latest
    // user turn is retained, so only two are actually replaced.
    expect(contentOf(active[1], "summary").replacedCount).toBe(2);
    expect(contentOf(active[1], "summary").replacedRange).toEqual([1, 3]);
    expect(contentOf(active[1], "summary").summary).toBe("summarized");
    // Within budget, so it is referenced by id alone with no truncated copy.
    expect(contentOf(active[1], "summary").retained).toEqual([{ id: latest.id }]);
    const all = agentStore.getMessages(thread.id);
    expect(all).toHaveLength(4);
    expect(all.slice(0, before.length)).toEqual(before);
    expect(all[3]!.id).toBe(result!.summaryMessage.id);
  } finally { cleanup(); }
});

test("runCompression: a plan reminder is neither kept in the active prompt nor summarised", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-plan-reminder");
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } });
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "plan-reminder", content: { type: "text", text: "<plan-reminder>\nNo plan yet.\n</plan-reminder>" } });
    const latest = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest user intent" } });
    const read: string[] = [];
    const result = await runCompression({ agentStore, summarizer: async (messages: any[]) => {
      read.push(...messages.map((m) => m.source));
      return { summaryText: "summary" };
    } }, thread.id);
    const active = agentStore.getActiveMessages(thread.id);
    expect(active.map((m) => m.id)).toEqual([latest.id, result!.summaryMessage.id]);
    // Nor does the summariser read it: its stale plan must not be paraphrased
    // into the summary that the fresh plan follows.
    expect(read).toStrictEqual(["user", "user"]);
  } finally { cleanup(); }
});

test("runCompression: the note after a cut-off reply is neither kept nor summarised", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-output-limit");
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } });
    agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "The plan has three par" } });
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "output-limit", content: { type: "text", text: "Your last reply was cut off at the output token limit." } });
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest user intent" } });
    const read: string[] = [];
    await runCompression({ agentStore, summarizer: async (messages: any[]) => {
      read.push(...messages.map((m) => m.source));
      return { summaryText: "summary" };
    } }, thread.id);
    expect(read).toStrictEqual(["user", "self", "user"]);
    expect(agentStore.getActiveMessages(thread.id).some((m) => m.source === "output-limit")).toBe(false);
  } finally { cleanup(); }
});

test("runCompression: summarises runtime context but keeps it out of the active prompt", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-context-compress");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "old ".repeat(90_000) }
    });
    const context = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "runtime-context",
      content: { type: "text", text: "[runtime_context]\nstale state" }
    });
    const latest = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "latest user intent" }
    });

    const calls: any[] = [];
    const result = await runCompression({
      agentStore,
      summarizer: async (toSummarize: any[]) => {
        calls.push(toSummarize);
        return { summaryText: "summarized without context" };
      }
    }, thread.id);

    // The summariser now sees the whole active window, runtime context included:
    // it needs to know what was on screen when the agent said what it said.
    expect(calls[0].map((m: any) => m.seq)).toEqual([1, 2, 3]);
    expect(calls[0].map((m: any) => m.source)).toEqual(["user", "runtime-context", "user"]);
    const active = agentStore.getActiveMessages(thread.id);
    // The runtime-context message is NOT retained — only real user turns are —
    // so it stays out of the active prompt exactly as before.
    expect(active.map((m) => m.id)).toEqual([latest.id, result!.summaryMessage.id]);
    expect(active.some((m) => m.source === "runtime-context")).toBe(false);
    expect(agentStore.getMessageById(context.id)).toEqual(context);
  } finally { cleanup(); }
});

test("runCompression: skips context-only rewrites when no real history would be summarized", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-context-only");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "runtime-context",
      content: { type: "text", text: "[runtime_context]\nstate ".repeat(10_000) }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "latest user intent" }
    });

    const reset: string[] = [];
    const result = await runCompression({
      agentStore,
      summarizer: async () => {
        throw new Error("summarizer should not run");
      },
      cursors: { resetThread: (threadId: string) => { reset.push(threadId); } }
    }, thread.id);

    expect(result).toBe(null);
    expect(agentStore.getActiveMessages(thread.id).map((m) => m.source)).toEqual([
      "runtime-context",
      "user"
    ]);
    // Nothing compressed, so the pane read cursors stay where they are.
    expect(reset).toStrictEqual([]);
  } finally { cleanup(); }
});

test("runCompression: rejects empty summaries without superseding history", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-empty-summary");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "old ".repeat(90_000) }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "latest user intent" }
    });

    const before = agentStore.getActiveMessages(thread.id);
    await expect(runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: " \n\t " })
    }, thread.id)).rejects.toThrow("compression produced empty summary");

    const active = agentStore.getActiveMessages(thread.id);
    expect(active.length).toBe(2);
    expect(active).toEqual(before);
    expect(active.some((message) => message.source === "compression")).toBe(false);
  } finally { cleanup(); }
});

test("runCompression: later compression expands prior summary range/count but keeps prompt order", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "old ".repeat(90_000) }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "first latest" }
    });
    const first = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "first" })
    }, thread.id);
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "assistant detail after first compression" }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "second latest" }
    });

    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "second" })
    }, thread.id);

    expect(result?.replacedRange).toEqual([1, 5]);
    // Two messages have actually vanished from the window by now: seq 1 (which
    // the first summary already stood for, and whose weight this summary
    // inherits) and seq 4. Seqs 2 and 5 are retained and still live, so they are
    // not counted — a retained turn is not a replaced one.
    expect(result?.replacedCount).toBe(2);
    // What each compaction compacted itself, as its boundary says: the first
    // hid seq 1; the second hid seq 4 and folded in the first summary, whose
    // seq 1 it does not count again.
    expect(contentOf(first!.summaryMessage, "summary").compactedCount).toBe(1);
    expect(contentOf(result!.summaryMessage, "summary").compactedCount).toBe(1);
    expect(result?.summaryMessage.seq).toBe(6);
    const active = agentStore.getActiveMessages(thread.id);
    // Both retained user turns survive: seq 2 is still inside the recent-user
    // budget and seq 5 is the newest. The summary still comes last.
    expect(active.map((m) => m.seq)).toEqual([2, 5, 6]);
    expect(active[2]!.id).toBe(result!.summaryMessage.id);
    expect(contentOf(active[2]!, "summary").summary).toBe("second");
  } finally { cleanup(); }
});

test("compression controller publishes finish before memory extraction, and resets pane read cursors", async () => {
  const { store, agentStore } = freshStoresEnv("md-cmp-controller-");
  const thread = agentStore.getOrCreateThread("manager", null);
  const old = agentStore.appendMessage({
    threadId: thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "old ".repeat(90_000) }
  });
  const latest = agentStore.appendMessage({
    threadId: thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "latest request" }
  });

  const events: string[] = [];
  let finishedUsage: unknown = "unset";
  const compressionModel = createMockLLM([
    { text: "compressed summary", finishReason: "stop", usage: { promptTokens: 25, completionTokens: 5 } }
  ], { mode: "stream" });
  const extracted: Array<{ threadId: string; trigger: string; ids: string[] }> = [];
  const recorder = new AgentLlmCallRecorder({
    store: null,
    logRequests: "off",
    provider: "mock",
    model: "mock",
    baseURL: "",
    apiMode: ""
  });
  const resetCursorThreads: string[] = [];
  const controller = createAgentCompressionController({
    config: configWithThreshold(10),
    store,
    // What leaves the context is what extraction reads: the hidden messages,
    // never the retained latest user turn, so each message is read once.
    extractWindow: (threadId, trigger, messages) => {
      events.push("memory-extraction-started");
      extracted.push({ threadId, trigger, ids: messages.map((m) => m.id) });
    },
    agentStore,
    cursors: { resetThread: (threadId: string) => resetCursorThreads.push(threadId) },
    sse: stub<AgentSseEmitter>({
      emit: (name: string, data: unknown) => {
        if (
          name === "agentMessageAppended"
          || name === "agentCompressionFinished"
          || name === "agentCompressionStarted"
        ) {
          events.push(name);
        }
        if (name === "agentCompressionFinished") finishedUsage = (data as { contextUsage?: unknown }).contextUsage;
      }
    }),
    compressionForThread: () => ({
      supportsReasoning: undefined,
      model: compressionModel,
      provider: "mock",
      recorder
    }),
    buildSystemPrompt: () => "system",
  });

  const result = await controller.beforeModelCallHook(thread.id, {
    wakeId: "wake-test",
    reason: "user",
    triggerMessageId: null
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(result.historyChanged).toBe(true);
  // A real compression must forget what read_pane already showed this thread:
  // the messages holding those pane lines may have been summarized away.
  expect(resetCursorThreads).toStrictEqual([thread.id]);
  expect(events.slice(0, 4)).toStrictEqual([
    "agentCompressionStarted",
    "agentMessageAppended",
    "agentCompressionFinished",
    "memory-extraction-started"
  ]);
  // The window has not been measured since: the page's meter gets no figure.
  expect(finishedUsage).toMatchObject({ inputTokens: null, budgetTokens: 10 });
  expect(extracted).toStrictEqual([{ threadId: thread.id, trigger: "compression", ids: [old.id] }]);
  expect(extracted[0]!.ids).not.toContain(latest.id);
});

test("compression controller serializes overlapping compression for one thread", async () => {
  const { store, agentStore } = freshStoresEnv("md-cmp-controller-lock-");
  const thread = agentStore.getOrCreateThread("manager", null);
  agentStore.appendMessage({
    threadId: thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "old ".repeat(90_000) }
  });
  agentStore.appendMessage({
    threadId: thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "latest request" }
  });

  let releaseCompression!: () => void;
  const compressionReleased = new Promise<void>((resolve) => {
    releaseCompression = resolve;
  });
  let compressionStarted!: () => void;
  const compressionStartedPromise = new Promise<void>((resolve) => {
    compressionStarted = resolve;
  });
  let compressionCalls = 0;
  const blockingCompressionModel: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "mock-compression",
    modelId: "mock-compression",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("compression test should use streamText");
    },
    async doStream() {
      compressionCalls++;
      compressionStarted();
      await compressionReleased;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text-0" });
            controller.enqueue({ type: "text-delta", id: "text-0", delta: "compressed summary" });
            controller.enqueue({ type: "text-end", id: "text-0" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 25, noCache: 25, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: 5, reasoning: undefined }
              }
            });
            controller.close();
          }
        })
      };
    }
  };
  const recorder = new AgentLlmCallRecorder({
    store: null,
    logRequests: "off",
    provider: "mock",
    model: "mock",
    baseURL: "",
    apiMode: ""
  });
  const controller = createAgentCompressionController({
    config: configWithThreshold(10),
    store,
    extractWindow: () => {},
    agentStore,
    cursors: { resetThread: () => {} },
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    compressionForThread: () => ({
      supportsReasoning: undefined,
      model: blockingCompressionModel,
      provider: "mock",
      recorder
    }),
    buildSystemPrompt: () => "system"
  });

  const firstCompression = controller.beforeModelCallHook(thread.id, {
    wakeId: "wake-first",
    reason: "user",
    triggerMessageId: null
  });
  await compressionStartedPromise;

  const overlappingCompression = controller.beforeModelCallHook(thread.id, {
    wakeId: "wake-overlap",
    reason: "user",
    triggerMessageId: null
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(compressionCalls).toBe(1);

  releaseCompression();
  const results = await Promise.all([firstCompression, overlappingCompression]);

  const compressionMessages = agentStore.getMessages(thread.id).filter((message) =>
    message.source === "compression"
  );
  expect(compressionMessages).toHaveLength(1);
  expect(compressionCalls).toBe(1);
  expect(results.map((result) => result.historyChanged)).toEqual([true, false]);
});

// A compaction sends the images a step would: one made small enough for a
// model goes in place of the stored one.
test("buildLocalCompressionMessages: an image fitted for the model is sent in its place", () => {
  const messages = [msg({ id: "user-1", role: "user", content: { type: "text", text: "look", attachments: [{ type: "image", id: "att-1", name: "page.png", mediaType: "image/png", data: "T1JJR0lOQUw=", sizeBytes: 8 }] } })];
  const built = buildLocalCompressionMessages(messages, {
    compactPrompt: "compact now",
    includeImages: true,
    imageForModel: (image) => (image.id === "att-1" ? { data: "RklUVEVE", mediaType: "image/jpeg" } : null)
  });
  expect((built[0]!.content as Array<{ type: string }>).find((part) => part.type === "file")).toMatchObject({ data: { type: "data", data: "RklUVEVE" }, mediaType: "image/jpeg" });
});

test("buildLocalCompressionMessages: uses normal history then appends compact prompt", () => {
  const messages = [
    msg({
      id: "user-1",
      role: "user",
      content: { type: "text", text: "please inspect" }
    }),
    msg({
      id: "assistant-1",
      seq: 2,
      role: "assistant",
      source: "self",
      content: {
        type: "assistant",
        toolCalls: [{ toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } }]
      }
    }),
    msg({
      id: "tool-1",
      seq: 3,
      role: "tool",
      source: "self",
      content: {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "bash",
        result: "/path/to/project"
      }
    })
  ];

  expect(buildLocalCompressionMessages(messages, {
    compactPrompt: "compact now",
    includeImages: true
  })).toEqual([
    { role: "user", content: "please inspect" },
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "bash",
        input: { command: "pwd" }
      }]
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "bash",
        output: { type: "text", value: "/path/to/project" }
      }]
    },
    { role: "user", content: "compact now" }
  ]);
});

test("buildLocalCompressionMessages: ignores SDK provider state", () => {
  const messages = [
    msg({
      id: "assistant-1",
      role: "assistant",
      source: "self",
      content: {
        type: "assistant",
        sdkAssistantMessages: [{
          role: "assistant",
          content: [{
            type: "reasoning",
            text: "",
            providerOptions: {
              openai: {
                itemId: "rs_1",
                reasoningEncryptedContent: "encrypted-reasoning"
              }
            }
          }]
        }],
        text: "Visible answer"
      }
    })
  ];

  const compressed = buildLocalCompressionMessages(messages, {
    compactPrompt: "compact now",
    includeImages: true
  });
  const serialized = JSON.stringify(compressed);
  expect(serialized).toContain("Visible answer");
  expect(serialized).not.toContain("encrypted-reasoning");
  expect(serialized).not.toContain("reasoningEncryptedContent");
});

test("buildLocalCompressionMessages: omits historical view_image bytes", () => {
  const imageBase64 = Buffer.from("png-bytes").toString("base64");
  const messages = [
    msg({
      id: "assistant-1",
      role: "assistant",
      source: "self",
      content: {
        type: "assistant",
        toolCalls: [{ toolCallId: "call-1", toolName: "view_image", args: { path: "screenshot.png" } }]
      }
    }),
    msg({
      id: "tool-1",
      seq: 2,
      role: "tool",
      source: "self",
      content: {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "view_image",
        result: {
          type: "view_image_result",
          message: "Viewed image: screenshot.png",
          image: {
            type: "image",
            id: "img-1",
            name: "screenshot.png",
            displayPath: "screenshot.png",
            mediaType: "image/png",
            data: imageBase64,
            sizeBytes: 9
          }
        }
      }
    })
  ];

  const compressed = buildLocalCompressionMessages(messages, {
    compactPrompt: "compact now",
    includeImages: true
  });
  const serialized = JSON.stringify(compressed);
  expect(serialized).not.toContain(imageBase64);
  expect(serialized).not.toContain("image-data");
  expect(serialized).toContain("does not support image tool-result input");
  expect(serialized).toContain("screenshot.png");
});

// On Codex the summary is streamed (doGenerate throws), and reasoning is asked
// for only when the model supports it.
const codexReasoning: {
  name: string;
  supportsReasoning: boolean;
  reasoning: string | undefined;
  forceReasoning: true | undefined;
}[] = [
  {
    name: "runAgentCompressionLlm uses streaming for OpenAI Codex",
    supportsReasoning: true,
    reasoning: "high",
    forceReasoning: true
  },
  {
    name: "runAgentCompressionLlm omits reasoning when model disables reasoning support",
    supportsReasoning: false,
    reasoning: undefined,
    forceReasoning: undefined
  }
];

test.each(codexReasoning)("$name", async ({ supportsReasoning, reasoning, forceReasoning }) => {
  const streamCalls: any[] = [];
  const model = {
    specificationVersion: "v3" as const,
    provider: "mock-codex",
    modelId: "mock-codex",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Codex compression must not use doGenerate");
    },
    async doStream(options: any) {
      streamCalls.push(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text-0" });
            controller.enqueue({ type: "text-delta", id: "text-0", delta: "compressed summary" });
            controller.enqueue({ type: "text-end", id: "text-0" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 3, text: 3, reasoning: undefined }
              }
            });
            controller.close();
          }
        })
      };
    }
  };

  const result = await runAgentCompressionLlm({
    model,
    provider: "codex",
    reasoningEffort: "high",
    supportsReasoning,
    system: "summarize",
    messages: [{ role: "user", content: "text" }]
  });

  expect(result.text).toBe("compressed summary");
  expect(streamCalls.length).toBe(1);
  expect(streamCalls[0].reasoning).toBe(reasoning);
  expect(streamCalls[0].providerOptions?.openai?.forceReasoning).toBe(forceReasoning);
});

test("runAgentCompressionLlm rejects provider error finishes", async () => {
  const model = {
    specificationVersion: "v3" as const,
    provider: "mock-codex",
    modelId: "mock-codex",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Codex compression must not use doGenerate");
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "error", raw: "error" },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 0, text: 0, reasoning: undefined }
              }
            });
            controller.close();
          }
        })
      };
    }
  };

  await expect(runAgentCompressionLlm({
    model,
    provider: "codex",
    system: "summarize",
    messages: [{ role: "user", content: "text" }]
  })).rejects.toThrow("compression LLM finished with error");
});

test("runAgentCompressionLlm rejects a summary cut off at the output token limit", async () => {
  await expect(runAgentCompressionLlm({
    model: createMockLLM([{ text: "## Summary\nThe user asked for", finishReason: "length" }]),
    provider: "openai",
    system: "summarize",
    messages: [{ role: "user", content: "text" }]
  })).rejects.toThrow(OUTPUT_LIMIT_FAILURE);
});

test("runAgentCompressionLlm surfaces the provider's own error, not the SDK's generic no-output error", async () => {
  // streamText hands a stream error only to onError; its result promises reject
  // with "No output generated", which has no status — so the retry policy could
  // not tell an overload from a bad request, and llm_calls recorded nothing useful.
  const overloaded = Object.assign(new Error("Overloaded"), { status: 529 });
  const model = createMockLLM([{ error: overloaded }], { mode: "stream" });
  let caught: unknown;
  try {
    await runAgentCompressionLlm({
      model: model,
      provider: "codex",
      system: "summarize",
      messages: [{ role: "user", content: "text" }]
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(overloaded);
});

// The newest retainable turn is kept regardless of its size, so a turn that
// alone blows the retained budget is kept as a truncated copy. Each row pins the
// copy's length on BOTH sides. An upper bound alone would still pass if the
// budget regressed to 20_000 chars; the lower bound is what catches that.
const truncations: { name: string; text: string; thresholdTokens?: number; min: number; max: number }[] = [
  {
    // Far over the 20k-token budget: without truncation the whole paste would
    // survive and compression would reclaim almost nothing.
    // Latin text: 20_000 tokens * 4 chars / 1.15 margin ≈ 69_565 chars.
    name: "runCompression: truncates a retained user message that alone blows the budget",
    text: "paste ".repeat(90_000),
    min: 65_000,
    max: 70_000
  },
  {
    // estimateStringChars weighs one CJK character as 4, so the same token
    // budget buys ~4x fewer of them. Cutting by raw length would leave this at
    // roughly 4.6x the budget it is supposed to enforce.
    // CJK: 69_565 effective chars / 4 per char ≈ 17_391 real characters.
    name: "runCompression: the truncation budget counts CJK weight, not raw characters",
    text: "压缩保真度测试用例".repeat(20_000),
    min: 15_000,
    max: 18_000
  },
  {
    // The truncation budget is the only thing standing between a small
    // threshold and a post-compression window that is still over it.
    // 1_000 tokens * 4 chars / 1.15 margin ≈ 3_478 chars, not 69_565.
    name: "runCompression: a clamped budget also bounds the truncated copy",
    text: "paste ".repeat(90_000),
    thresholdTokens: 4_000,
    min: 3_000,
    max: 4_000
  }
];

test.each(truncations)("$name", async ({ text, thresholdTokens, min, max }) => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-retain-truncate");
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "assistant detail" }
    });
    const huge = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text }
    });

    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" }),
      thresholdTokens
    }, thread.id);

    const content = contentOf(result!.summaryMessage, "summary");
    expect(content.retained).toHaveLength(1);
    expect(content.retained![0].id).toBe(huge.id);
    const truncated = content.retained![0].truncatedText;
    expect(typeof truncated).toBe("string");
    expect(truncated!.length).toBeLessThan(text.length);
    expect(truncated!.length).toBeGreaterThan(min);
    expect(truncated!.length).toBeLessThan(max);
  } finally { cleanup(); }
});

test("runCompression: records an empty retained list when nothing is retainable", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-retain-empty");
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "detail ".repeat(90_000) }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "runtime-context",
      content: { type: "text", text: "[runtime_context]\nstate" }
    });

    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" })
    }, thread.id);

    const content = contentOf(result!.summaryMessage, "summary");
    // No retainable user turn at all. The field must still be present and
    // empty rather than undefined, so the derivation never sees a half state.
    expect(content.retained).toEqual([]);
  } finally { cleanup(); }
});

test("runCompression: never stores a truncated copy identical to the message it references", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-retain-deadband");
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "assistant detail" }
    });
    // 75_000 Latin chars sits in the band where deciding "too large" in tokens
    // but cutting at a raw-character bound disagreed: over the budget, yet under
    // any 20_000 * 4 char bound, so the "truncated" copy came back byte-identical
    // to the row it references. One decision from limitToolText's own flag is
    // what keeps that impossible.
    const message = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "x".repeat(75_000) }
    });

    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" })
    }, thread.id);

    const content = contentOf(result!.summaryMessage, "summary");
    expect(content.retained).toHaveLength(1);
    const original = contentOf(message, "text").text;
    expect(content.retained![0].truncatedText).not.toBe(original);
    expect(content.retained![0].truncatedText!.length).toBeLessThan(70_000);
  } finally { cleanup(); }
});

test("runCompression: a retained copy is never stored when truncation would not shrink it", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-retain-longer");
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "assistant detail" }
    });
    // A ~22-character band above the char budget (69_565 for Latin text) where
    // the "... [truncated N chars]" notice costs more than the cut saves, so the
    // truncated copy comes out LONGER than the row it replaces.
    const message = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "y".repeat(69_570) }
    });

    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" })
    }, thread.id);

    const content = contentOf(result!.summaryMessage, "summary");
    // Storing a longer copy buys nothing and costs budget: reference the row.
    expect(content.retained).toEqual([{ id: message.id }]);
  } finally { cleanup(); }
});

test("runCompression: a small threshold clamps the retained budget", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-retain-clamp");
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "detail ".repeat(90_000) }
    });
    const turns = ["one", "two", "three", "four"].map((label) =>
      agentStore.appendMessage({
        threadId: thread.id, role: "user", source: "user",
        content: { type: "text", text: `${label} ${"u".repeat(2_000)}` }
      })
    );

    // 32k-context local model territory. Retaining the flat 20_000 tokens here
    // would put more user text back than the whole threshold allows, so the
    // window stays over threshold and every wake step compresses again.
    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" }),
      thresholdTokens: 4_000
    }, thread.id);

    const content = contentOf(result!.summaryMessage, "summary");
    expect(content.retained!.map((entry) => entry.id)).toEqual([turns[3]!.id]);
    // 4_000 / 4 = 1_000 tokens of budget, and one 2k-char turn is ~575.
    expect(estimateMessagesTokens(
      agentStore.getActiveMessages(thread.id).filter((m) => m.source === "user")
    )).toBeLessThan(1_000);
  } finally { cleanup(); }
});

test("runCompression: the default threshold leaves the retained budget at 20k tokens", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-retain-default-budget");
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "detail ".repeat(90_000) }
    });
    const turns = ["one", "two", "three", "four"].map((label) =>
      agentStore.appendMessage({
        threadId: thread.id, role: "user", source: "user",
        content: { type: "text", text: `${label} ${"u".repeat(2_000)}` }
      })
    );

    // The shipped default. min(20_000, 200_000/4) is still 20_000, so a normal
    // context window keeps the full retention budget.
    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" }),
      thresholdTokens: 200_000
    }, thread.id);

    const content = contentOf(result!.summaryMessage, "summary");
    expect(content.retained!.map((entry) => entry.id)).toEqual(turns.map((t) => t.id));
  } finally { cleanup(); }
});

test("compression controller passes the configured threshold into the retained budget", async () => {
  const { store, agentStore } = freshStoresEnv("md-cmp-threshold-");
  const thread = agentStore.getOrCreateThread("manager", null);
  // Big enough that the gate fires at a 4_000-token threshold, and far too
  // big to be retained under any budget.
  agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "old ".repeat(90_000) }
  });
  for (const label of ["one", "two", "three", "four"]) {
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: `${label} ${"u".repeat(2_000)}` }
    });
  }

  const recorder = new AgentLlmCallRecorder({
    store: null, logRequests: "off", provider: "mock", model: "mock", baseURL: "", apiMode: ""
  });
  const controller = createAgentCompressionController({
    // A 32k-context local model. The threshold has to reach the retention
    // budget, or compression hands back more user text than it allows and the
    // next wake step compresses all over again.
    config: configWithThreshold(4_000),
    store,
    extractWindow: () => {},
    agentStore,
    cursors: { resetThread: () => {} },
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    compressionForThread: () => ({
      supportsReasoning: undefined,
      model: createMockLLM([
        { text: "compressed summary", finishReason: "stop", usage: { promptTokens: 25, completionTokens: 5 } }
      ], { mode: "stream" }),
      provider: "mock",
      recorder
    }),
    buildSystemPrompt: () => "system",
  });

  const result = await controller.beforeModelCallHook(thread.id, {
    wakeId: "wake-threshold", reason: "user", triggerMessageId: null
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(result.historyChanged).toBe(true);
  const summary = agentStore.getMessages(thread.id)
    .filter((m) => m.content.type === "summary")
    .at(-1)!;
  // 4_000 / 4 = 1_000 tokens, so only the newest ~575-token turn fits. With
  // the flat 20_000 all four would come back.
  expect(contentOf(summary, "summary").retained).toHaveLength(1);
});

test("getActiveMessages: retained ids that no longer resolve are skipped", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-missing-id");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "first" }
    });
    const summary = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "compression",
      content: {
        type: "summary", summary: "s", replacedRange: [1, 1], replacedCount: 1,
        retained: [{ id: "msg_does_not_exist" }, { id: "msg_gone", truncatedText: "x" }]
      }
    });

    const active = agentStore.getActiveMessages(thread.id);
    // Neither entry resolves; a truncatedText must not conjure a message that
    // has no row behind it.
    expect(active.map((m) => m.id)).toEqual([summary.id]);
  } finally { cleanup(); }
});

test("getActiveMessages: a retained entry with truncatedText derives the shortened text", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-truncated-derive");
    const huge = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "paste ".repeat(50_000) }
    });
    const summary = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "compression",
      content: {
        type: "summary", summary: "s", replacedRange: [1, 1], replacedCount: 1,
        retained: [{ id: huge.id, truncatedText: "paste paste … [truncated]" }]
      }
    });

    const active = agentStore.getActiveMessages(thread.id);
    expect(active.map((m) => m.id)).toEqual([huge.id, summary.id]);
    // Identity comes from the real row; only the content is swapped.
    expect(active[0]!.seq).toBe(huge.seq);
    expect(active[0]!.role).toBe("user");
    expect(active[0]!.source).toBe("user");
    expect(contentOf(active[0]!, "text").text).toBe("paste paste … [truncated]");
    // The stored row itself is untouched — the log stays honest.
    expect(contentOf(agentStore.getMessageById(huge.id)!, "text").text)
      .toBe("paste ".repeat(50_000));
  } finally { cleanup(); }
});

test("getActiveMessages: a second compression keeps only the newer retained set", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-second-compress");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "old ".repeat(90_000) }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "detail" }
    });
    const firstIntent = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "first intent" }
    });
    await runCompression({
      agentStore, summarizer: async () => ({ summaryText: "s1" })
    }, thread.id);

    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "more ".repeat(90_000) }
    });
    const secondIntent = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "second intent" }
    });
    const second = await runCompression({
      agentStore, summarizer: async () => ({ summaryText: "s2" })
    }, thread.id);

    const ids = agentStore.getActiveMessages(thread.id).map((m) => m.id);
    expect(ids).toContain(secondIntent.id);
    expect(ids).toContain(second!.summaryMessage.id);
    // The first round's retained turn is older than the newer summary and is
    // not in its retained set, so it drops out.
    expect(ids).not.toContain(firstIntent.id);
  } finally { cleanup(); }
});

describe("compression controller — model candidates", () => {
  // The candidate loop is the shared one (modules/llm/run-candidates.ts); these
  // pin that compression is wired to it rather than to a policy of its own.
  const overloaded = () => Object.assign(new Error("Overloaded"), { status: 529 });

  async function compressWith(
    primaryScript: Parameters<typeof createMockLLM>[0],
    fallbackScript: Parameters<typeof createMockLLM>[0]
  ) {
    const env = freshStoresEnv("md-cmp-candidates-");
    const { store, agentStore } = env;
    const thread = agentStore.getOrCreateThread("manager", null);
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "old ".repeat(90_000) }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "latest request" }
    });
    const primary = createMockLLM(primaryScript, { mode: "stream", provider: "codex", modelId: "gpt-5.5" });
    const fallback = createMockLLM(fallbackScript, { mode: "stream", provider: "kilo", modelId: "gpt-5.5" });
    const recorderFor = (provider: string) => new AgentLlmCallRecorder({
      store, logRequests: "metadata", provider, model: "gpt-5.5", baseURL: "", apiMode: "streamText"
    });
    const primaryRecorder = recorderFor("codex");
    const fallbackRecorder = recorderFor("kilo");
    const controller = createAgentCompressionController({
      config: configWithThreshold(10),
      store,
      extractWindow: () => {},
      agentStore,
      cursors: { resetThread: () => {} },
      sse: stub<AgentSseEmitter>({ emit: () => {} }),
      compressionForThread: () => ({
        supportsReasoning: undefined,
        model: primary,
        provider: "codex",
        recorder: primaryRecorder,
        candidates: [
          { model: primary, provider: "codex", supportsReasoning: undefined, recorder: primaryRecorder },
          { model: fallback, provider: "kilo", supportsReasoning: undefined, recorder: fallbackRecorder }
        ]
      }),
      buildSystemPrompt: () => "system",
    });
    let error: unknown = null;
    try {
      await controller.beforeModelCallHook(thread.id, {
        wakeId: "wake-candidates", reason: "user", triggerMessageId: null
      });
    } catch (err) {
      error = err;
    }
    // Ordered by the attempt, not by listLlmCalls: a fallback starts in the same
    // millisecond its predecessor failed, and the list breaks created_at ties
    // on a random id.
    const position = (m: any) => (m?.candidateIndex ?? 0) * 10 + (m?.attempt ?? 1);
    const calls = store.listLlmCalls(50)
      .filter((call) => call.purpose === "agent_compression")
      .map((call) => ({ provider: call.provider, status: call.status, metadata: call.metadata }))
      .sort((a, b) => position(a.metadata) - position(b.metadata));
    const summary = agentStore.getMessages(thread.id).find((m) => m.source === "compression");
    return { env, error, calls, primary, fallback, summary };
  }

  test("a retryable failure is retried once on the primary model, and the retry is not a fallback", async () => {
    const r = await compressWith(
      [{ error: overloaded() }, { text: "primary summary", finishReason: "stop" }],
      [{ text: "fallback summary", finishReason: "stop" }]
    );
    try {
      expect(r.error).toBe(null);
      expect([r.primary.callsMade, r.fallback.callsMade]).toEqual([2, 0]);
      expect(r.calls.map((c) => [c.provider, c.status])).toEqual([["codex", "failed"], ["codex", "succeeded"]]);
      expect(r.calls[1]!.metadata).toMatchObject({ fallbackAttempt: false, candidateIndex: 0, attempt: 2 });
    } finally { r.env.cleanup(); }
  });

  test("a model that finishes with an error goes straight to the fallback", async () => {
    // Compression used to retry this three times on the same model; the
    // retries did not rescue it.
    const r = await compressWith(
      [{ text: "", finishReason: "error" }, { text: "must not be reached", finishReason: "stop" }],
      [{ text: "fallback summary", finishReason: "stop" }]
    );
    try {
      expect(r.error).toBe(null);
      expect([r.primary.callsMade, r.fallback.callsMade]).toEqual([1, 1]);
      expect(r.calls.map((c) => [c.provider, c.status])).toEqual([["codex", "failed"], ["kilo", "succeeded"]]);
      expect(r.calls[1]!.metadata).toMatchObject({ fallbackAttempt: true, candidateIndex: 1, attempt: 1 });
      expect(r.summary?.content.type === "summary" ? r.summary.content.summary : "").toContain("fallback summary");
    } finally { r.env.cleanup(); }
  });

  test("an empty summary gets one more try on the same model", async () => {
    // A model that finishes normally with no text is a glitch of that call, not
    // of the request. Without this, a setup with no fallback fails the wake.
    const r = await compressWith(
      [{ text: "", finishReason: "stop" }, { text: "primary summary", finishReason: "stop" }],
      [{ text: "fallback summary", finishReason: "stop" }]
    );
    try {
      expect(r.error).toBe(null);
      expect([r.primary.callsMade, r.fallback.callsMade]).toEqual([2, 0]);
      expect(r.summary?.content.type === "summary" ? r.summary.content.summary : "").toContain("primary summary");
    } finally { r.env.cleanup(); }
  });

  test("a second empty summary moves on to the fallback", async () => {
    const r = await compressWith(
      [{ text: "", finishReason: "stop" }, { text: " ", finishReason: "stop" }, { text: "never", finishReason: "stop" }],
      [{ text: "fallback summary", finishReason: "stop" }]
    );
    try {
      expect(r.error).toBe(null);
      expect([r.primary.callsMade, r.fallback.callsMade]).toEqual([2, 1]);
    } finally { r.env.cleanup(); }
  });

  test("a content refusal is not retried on the same model", async () => {
    const refusal = Object.assign(
      new Error("This content was flagged for possible cybersecurity risk."),
      { status: 500 }
    );
    const r = await compressWith(
      [{ error: refusal }, { text: "must not be reached", finishReason: "stop" }],
      [{ text: "fallback summary", finishReason: "stop" }]
    );
    try {
      expect(r.error).toBe(null);
      expect([r.primary.callsMade, r.fallback.callsMade]).toEqual([1, 1]);
    } finally { r.env.cleanup(); }
  });
});

// The summary row records the window's size as the gate measured it, for
// the transcript's boundary to say ("… at 250.4k tokens"). Measured means the
// provider's own count of the last prompt plus an estimate of what was added
// since; the plain estimate runs well above that count and is never
// recorded in its place.
test("runCompression: the summary row records the size the gate measured, and none when it measured nothing", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const compact = async (featureId: string, measuredTokens?: number) => {
      const thread = agentStore.getOrCreateThread("worker", featureId);
      for (let i = 0; i < 6; i += 1) {
        agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: `question ${i} ${"q".repeat(400)}` } });
        agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: `answer ${i} ${"a".repeat(4000)}`, toolCalls: [] } });
      }
      const result = await runCompression({ agentStore, summarizer: async () => ({ summaryText: "the gist" }), measuredTokens }, thread.id);
      return contentOf(result!.summaryMessage, "summary");
    };
    const measured = await compact("feat-size-measured", 5_555);
    expect(measured.tokensBefore).toBe(5_555);
    expect(Object.keys(measured).sort()).toEqual(["compactedCount", "replacedCount", "replacedRange", "retained", "summary", "tokensBefore", "type"]);
    expect(Object.keys(await compact("feat-size-unmeasured")).sort()).toEqual(["compactedCount", "replacedCount", "replacedRange", "retained", "summary", "type"]);
  } finally { cleanup(); }
});

test("compression controller records the size its gate measured from the provider's count, and none from an estimate alone", async () => {
  const { store, agentStore } = freshStoresEnv("md-cmp-size-measured-");
  const recorder = new AgentLlmCallRecorder({
    store: null, logRequests: "off", provider: "mock", model: "mock", baseURL: "", apiMode: ""
  });
  const controller = createAgentCompressionController({
    config: configWithThreshold(50_000),
    store,
    extractWindow: () => {},
    agentStore,
    cursors: { resetThread: () => {} },
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    compressionForThread: () => ({
      supportsReasoning: undefined,
      model: createMockLLM([
        { text: "compressed summary", finishReason: "stop", usage: { promptTokens: 25, completionTokens: 5 } }
      ], { mode: "stream" }),
      provider: "mock",
      recorder
    }),
    buildSystemPrompt: () => "system",
  });
  /** A thread with one large old message and a new one, compacted through the hook. */
  const compact = async (measure: boolean) => {
    const thread = agentStore.createManagerThread(measure ? "measured" : "estimated");
    const old = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } });
    const latest = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest request" } });
    if (measure) {
      // The last wake step: its prompt ended at the old message, and the
      // provider counted 60,000 tokens for it (the estimate of that window
      // is some 100,000).
      const at = new Date().toISOString();
      store.db.prepare(`
          insert into llm_calls (id, purpose, scope_type, scope_id, status, input_tokens, metadata_json, started_at, finished_at, created_at, updated_at)
          values (?, 'agent_wake_step', 'agent_thread', ?, 'succeeded', 60000, ?, ?, ?, ?, ?)
        `).run(`call_${thread.id}`, thread.id, JSON.stringify({ promptMaxSeq: old.seq }), at, at, at, at);
    }
    expect(estimateMessagesTokens(agentStore.getActiveMessages(thread.id))).toBeGreaterThan(90_000);
    const result = await controller.beforeModelCallHook(thread.id, { wakeId: `wake-${thread.id}`, reason: "user", triggerMessageId: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.historyChanged).toBe(true);
    const summary = agentStore.getMessages(thread.id).filter((m) => m.content.type === "summary").at(-1)!;
    return { size: contentOf(summary, "summary").tokensBefore, latest };
  };
  // The provider's count of the last prompt plus the estimate of the one
  // message added since: the figure the gate compared with the threshold.
  const measured = await compact(true);
  expect(measured.size).toBe(60_000 + estimateMessagesTokens([measured.latest]));
  // No call to go by: the gate fired on its estimate, which is not recorded.
  expect((await compact(false)).size).toBe(undefined);
});

test("the size a summary row records is never shown to the model", () => {
  const summary = msg({
    source: "compression",
    content: { type: "summary", summary: "the gist", replacedRange: [1, 4], replacedCount: 4, tokensBefore: 9000, retained: [] }
  });
  const prompt = JSON.stringify(prepareAiSdkMessages([summary], { includeImages: false }));
  expect(prompt).toContain("the gist");
  expect(prompt).not.toContain("9000");
  expect(prompt).not.toContain("tokensBefore");
});

// ── a compaction started by hand (the /compact command) ──────────────────

/** A controller wired as the runtime wires it: a real wake lock behind holdThread. */
function manualController(
  env: ReturnType<typeof freshStoresEnv>,
  model: ReturnType<typeof createMockLLM>,
  systemPrompt = "system",
  stepPromptForThread?: (threadId: string) => StepPrompt | Promise<StepPrompt>
) {
  const lock = new WakeLock();
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const released: string[] = [];
  const extracted: string[][] = [];
  const recorder = new AgentLlmCallRecorder({
    store: null, logRequests: "off", provider: "mock", model: "mock", baseURL: "", apiMode: ""
  });
  const controller = createAgentCompressionController({
    config: configWithThreshold(50_000),
    store: env.store,
    agentStore: env.agentStore,
    extractWindow: (_threadId, _trigger, messages) => { extracted.push(messages.map((m) => m.id)); },
    cursors: { resetThread: () => {} },
    sse: stub<AgentSseEmitter>({
      emit: (name: string, data: unknown) => { events.push({ name, data: data as Record<string, unknown> }); }
    }),
    compressionForThread: () => ({ supportsReasoning: undefined, model, provider: "mock", recorder }),
    buildSystemPrompt: () => systemPrompt,
    holdThread: (threadId) => {
      const release = lock.tryAcquire(threadId);
      return release ? () => { release(); released.push(threadId); } : null;
    },
    ...(stepPromptForThread ? { stepPromptForThread } : {})
  });
  return { controller, lock, events, released, extracted };
}
/** Until the compaction lets the thread go. */
async function letGo(lock: WakeLock, threadId: string): Promise<void> {
  for (let i = 0; i < 400 && lock.isHeld(threadId); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}
const oneSummary = () => createMockLLM([
  { text: "the gist", finishReason: "stop", usage: { promptTokens: 25, completionTokens: 5 } }
], { mode: "stream" });
/** A thread worth compacting: an old question, its answer, and a new request. */
function seedCompactable(agentStore: ReturnType<typeof freshStoresEnv>["agentStore"], title: string) {
  const thread = agentStore.createManagerThread(title);
  const old = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(2_000) } });
  const reply = agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "answer", toolCalls: [] } });
  const latest = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest request" } });
  return { thread, old, reply, latest };
}

test("hasSomethingToCompact: only a window that would lose something to a summary", () => {
  const user = (id: string, seq: number) => msg({ id, seq, role: "user", source: "user", content: { type: "text", text: `question ${id}` } });
  const reply = msg({ id: "a1", seq: 2, role: "assistant", source: "self", content: { type: "assistant", text: "answer", toolCalls: [] } });
  expect(hasSomethingToCompact([])).toBe(false);
  // Recent user turns are kept verbatim: alone, there is nothing to fold.
  expect(hasSomethingToCompact([user("u1", 1)])).toBe(false);
  expect(hasSomethingToCompact([user("u1", 1), reply, user("u2", 3)])).toBe(true);
});

test("compactNow: a compaction by hand holds the thread, leaves the summary an automatic one leaves, and refreshes the stored prompt", async () => {
  const env = freshStoresEnv("md-cmp-manual-");
  const { thread, old, reply, latest } = seedCompactable(env.agentStore, "manual");
  env.agentStore.ensureSystemMessage(thread.id, "the prompt it was born with");
  const m = manualController(env, oneSummary(), "today's prompt");

  expect(m.controller.compactNow(thread.id)).toBe("started");
  // Held from the moment it starts: a turn, a message and a second compaction all find the thread busy.
  expect(m.lock.isHeld(thread.id)).toBe(true);
  expect(m.controller.isCompacting(thread.id)).toBe(true);
  expect(m.controller.compactNow(thread.id)).toBe("compacting");
  await letGo(m.lock, thread.id);

  expect(m.released).toStrictEqual([thread.id]);
  expect(m.controller.isCompacting(thread.id)).toBe(false);
  const summary = contentOf(env.agentStore.getMessages(thread.id).filter((x) => x.content.type === "summary").at(-1)!, "summary");
  expect(summary.summary).toBe("the gist");
  // The same selection as at the gate: recent user turns kept, the rest folded and handed to extraction once.
  expect(summary.retained?.map((r) => r.id)).toEqual([old.id, latest.id]);
  expect(m.extracted).toStrictEqual([[reply.id]]);
  expect(m.events.map((e) => e.name)).toStrictEqual(["agentCompressionStarted", "agentMessageAppended", "agentCompressionFinished"]);
  expect(m.events[0]!.data.reason).toBe("manual");
  // What compacting a thread far below the threshold is for: the stored prompt is today's.
  const stored = env.agentStore.getSystemMessage(thread.id)!;
  expect(stored.content.type === "text" ? stored.content.text : null).toBe("today's prompt");
  // No provider count to go by, so the boundary states no size.
  expect("tokensBefore" in summary).toBe(false);
});

// The provider's count of the last step is what the boundary's size starts
// from, whichever kind of step it was: a wake's, a subagent's or a page
// subagent's. What was added since is estimated on top, as at the gate.
const lastSteps: { name: string; purpose: string; inputTokens: number }[] = [
  {
    name: "compactNow: the boundary's size is the provider's count plus what was added since, as at the gate",
    purpose: "agent_wake_step",
    inputTokens: 8473
  },
  {
    name: "compactNow: a subagent's last step is the provider's count to go by, as any wake step's",
    purpose: "subagent_step",
    inputTokens: 8473
  },
  {
    name: "compactNow: a page subagent's last step is the provider's count to go by too",
    purpose: "page_subagent_step",
    inputTokens: 9120
  }
];

test.each(lastSteps)("$name", async ({ purpose, inputTokens }) => {
  const env = freshStoresEnv(`md-cmp-manual-${purpose}-`);
  const { thread, reply, latest } = seedCompactable(env.agentStore, purpose);
  const at = new Date().toISOString();
  env.store.db.prepare(`
      insert into llm_calls (id, purpose, scope_type, scope_id, status, input_tokens, metadata_json, started_at, finished_at, created_at, updated_at)
      values (?, ?, 'agent_thread', ?, 'succeeded', ?, ?, ?, ?, ?, ?)
    `).run(`call_${purpose}`, purpose, thread.id, inputTokens, JSON.stringify({ promptMaxSeq: reply.seq }), at, at, at, at);
  const m = manualController(env, oneSummary());

  expect(m.controller.compactNow(thread.id)).toBe("started");
  await letGo(m.lock, thread.id);

  const summary = contentOf(env.agentStore.getMessages(thread.id).filter((x) => x.content.type === "summary").at(-1)!, "summary");
  expect(summary.tokensBefore).toBe(inputTokens + estimateMessagesTokens([latest]));
});

test("compactNow: a busy thread answers running, a window with nothing to fold answers nothing, and neither starts anything", () => {
  const env = freshStoresEnv("md-cmp-manual-refused-");
  const model = oneSummary();
  const m = manualController(env, model);
  const { thread } = seedCompactable(env.agentStore, "busy");
  const turn = m.lock.tryAcquire(thread.id)!;
  expect(m.controller.compactNow(thread.id)).toBe("running");
  turn();

  const small = env.agentStore.createManagerThread("small");
  env.agentStore.appendMessage({ threadId: small.id, role: "user", source: "user", content: { type: "text", text: "hello" } });
  expect(m.controller.compactNow(small.id)).toBe("nothing");
  // Let go at once: "nothing" must not leave the thread busy.
  expect(m.lock.isHeld(small.id)).toBe(false);
  expect(m.released).toStrictEqual([small.id]);

  expect(m.events).toStrictEqual([]);
  expect(model.callsMade).toBe(0);
  expect([m.controller.isCompacting(thread.id), m.controller.isCompacting(small.id)]).toEqual([false, false]);
});

test("compactNow: a failing summariser says so with the run's reason and lets the thread go", async () => {
  const env = freshStoresEnv("md-cmp-manual-failed-");
  const { thread } = seedCompactable(env.agentStore, "failing");
  // No answer queued: the model throws on its first call, and on the retry.
  const m = manualController(env, createMockLLM([], { mode: "stream" }));

  expect(m.controller.compactNow(thread.id)).toBe("started");
  await letGo(m.lock, thread.id);

  expect(m.events.map((e) => e.name)).toStrictEqual(["agentCompressionStarted", "agentCompressionFailed"]);
  expect(m.events[1]!.data).toMatchObject({ threadId: thread.id, status: "error", reason: "manual" });
  expect(String(m.events[1]!.data.errorMessage)).toContain("mock LLM exhausted");
  expect(env.agentStore.getMessages(thread.id).some((x) => x.content.type === "summary")).toBe(false);
  // Nothing was reset, so the thread keeps the prompt its steps were sent with.
  expect(env.agentStore.getSystemMessage(thread.id)).toBeNull();
  // Not stuck: the thread is free and may be compacted again.
  expect([m.lock.isHeld(thread.id), m.controller.isCompacting(thread.id), m.released]).toEqual([false, false, [thread.id]]);
});

test("compactNow: a read that fails once the thread is taken gives the thread back", async () => {
  const env = freshStoresEnv("md-cmp-manual-read-fails-");
  const { thread } = seedCompactable(env.agentStore, "unreadable");
  const m = manualController(env, oneSummary());
  const read = env.agentStore.getActiveMessages.bind(env.agentStore);
  let failing = true;
  env.agentStore.getActiveMessages = (threadId) => {
    if (failing) { failing = false; throw new Error("database is locked"); }
    return read(threadId);
  };

  expect(() => m.controller.compactNow(thread.id)).toThrow("database is locked");
  // Not stuck busy with nothing to stop: the lock is back, and the next try starts.
  expect([m.lock.isHeld(thread.id), m.controller.isCompacting(thread.id), m.released]).toEqual([false, false, [thread.id]]);
  expect(m.controller.compactNow(thread.id)).toBe("started");
  await letGo(m.lock, thread.id);
});

test("compactNow: a controller given no way to hold a thread finds every thread busy", () => {
  const env = freshStoresEnv("md-cmp-manual-unwired-");
  const { thread } = seedCompactable(env.agentStore, "unwired");
  const controller = createAgentCompressionController({
    config: configWithThreshold(50_000), store: env.store, agentStore: env.agentStore,
    extractWindow: () => {}, cursors: { resetThread: () => {} }, sse: stub<AgentSseEmitter>({ emit: () => {} }),
    compressionForThread: () => { throw new Error("must not be asked for a model"); },
    buildSystemPrompt: () => "system"
  });
  expect(controller.compactNow(thread.id)).toBe("running");
});

describe("compression on the prompt of the thread's next step", () => {
  /** A thread one step in, then a second wake whose gate compacts first: the
   *  model's calls are the first step, the compaction, and the step after. */
  async function compactBeforeSecondStep(
    meta: NonNullable<WakeLlmCandidate["meta"]>,
    script: Parameters<typeof createMockLLM>[0],
    opts: { stepPromptFails?: boolean; cacheSeal?: { shortMarksFor(c: WakeLlmCandidate): boolean; fallbackMarksShort(): boolean; noteCallStarted(t: string): void; noteStepSucceeded(): void; noteStepFailed(): void; noteStepNotCalled(): void; noteCompacted(t: string): void } } = {}
  ) {
    const env = freshStoresEnv("md-cmp-step-");
    const { store, agentStore } = env;
    const ran: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "echo", description: "Echo",
      parameters: z.object({ text: z.string() }),
      handler: async ({ text }) => { ran.push(text); return { echoed: text }; }
    });
    const dispatcher = new ToolDispatcher(registry);
    const model = createMockLLM(script, { mode: "stream" });
    let threshold = 1_000_000;
    let systemPrompt = "the prompt it was born with";
    const recorder = new AgentLlmCallRecorder({
      store: null, logRequests: "off", provider: "mock", model: "mock", baseURL: "", apiMode: ""
    });
    let scheduler: WakeScheduler | null = null;
    const controller = createAgentCompressionController({
      config: configWithThreshold(threshold),
      getConfig: () => configWithThreshold(threshold),
      store, agentStore,
      extractWindow: () => {},
      cursors: { resetThread: () => {} },
      sse: stub<AgentSseEmitter>({ emit: () => {} }),
      compressionForThread: () => ({ supportsReasoning: undefined, model, provider: meta.provider ?? "mock", recorder }),
      buildSystemPrompt: () => systemPrompt,
      stepPromptForThread: opts.stepPromptFails
        ? () => { throw new Error("current agent model candidates do not support image input"); }
        : (threadId) => scheduler!.stepPromptFor(threadId),
      ...(opts.cacheSeal ? { cacheSeal: opts.cacheSeal } : {})
    });
    const wakes = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      buildSystemPrompt: () => systemPrompt,
      toolDispatcherForThread: () => dispatcher,
      llmModel: model,
      llmForThread: () => ({ model, candidates: [{ model, meta }] }),
      sse: { emit: () => {} },
      buildToolScope: () => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } }),
      beforeModelCallHook: (threadId, info) => controller.beforeModelCallHook(threadId, info),
      ...(opts.cacheSeal ? { cacheSeal: opts.cacheSeal } : {})
    });
    scheduler = wakes.scheduler;
    const thread = agentStore.createManagerThread("step prompt");
    const first = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(2_000) }
    });
    await wakes.wakeAndWait(thread.id, "user", first.id);
    // The template has changed since, and the second wake's gate compacts.
    systemPrompt = "today's prompt";
    threshold = 10;
    const second = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest request" }
    });
    await wakes.wakeAndWait(thread.id, "user", second.id);
    const summary = agentStore.getMessages(thread.id).filter((m) => m.content.type === "summary").at(-1);
    return {
      thread, model, ran,
      messages: agentStore.getMessages(thread.id),
      summary: summary ? contentOf(summary, "summary").summary : null
    };
  }

  const answers = [
    { text: "first answer", finishReason: "stop" as const },
    { text: "the gist", finishReason: "stop" as const },
    { text: "second answer", finishReason: "stop" as const }
  ];
  /** The provider options with the reasoning summary request left out. */
  const withoutSummaryRequest = (options: SharedV3ProviderOptions | undefined) =>
    options?.openai ? { ...options, openai: { ...options.openai, reasoningSummary: undefined } } : options;

  const models: { name: string; meta: NonNullable<WakeLlmCandidate["meta"]>; marked: boolean }[] = [
    {
      name: "an Anthropic model: the compaction's prompt starts with the step before's, cache marks and all",
      meta: { provider: "anthropic", model: "claude-opus-5-5" },
      marked: true
    },
    {
      name: "a custom provider's model: the compaction keeps the steps' prompt, cache key and session headers",
      meta: { provider: "openai-compatible", providerType: "openai-compatible", model: "gpt-6.1-sol" },
      marked: false
    }
  ];
  // A compaction reads the step's cache as it stands and is not sealed: its
  // marks stay an hour while the steps write theirs for five minutes, and it
  // tells the sealer it called, then that it rewrote the thread.
  test("compaction keeps hour-long marks and tells the sealer", async () => {
    const events: string[] = [];
    const cacheSeal = {
      shortMarksFor: () => true,
      fallbackMarksShort: () => true,
      noteCallStarted: () => { events.push("call"); },
      noteStepSucceeded: () => { events.push("step"); },
      noteStepFailed: () => { events.push("failed"); },
      noteStepNotCalled: () => { events.push("not called"); },
      noteCompacted: () => { events.push("compacted"); }
    };
    const r = await compactBeforeSecondStep({ provider: "anthropic", model: "claude-sonnet-5-5" }, answers, { cacheSeal });
    expect(r.summary).toBe("the gist");
    const [step, compaction, after] = r.model.streamCalls as Array<{ prompt: Array<{ providerOptions?: { anthropic?: { cacheControl?: { ttl?: string } } } }> }>;
    const ttls = (call: typeof step) => call!.prompt.slice(1).map((m) => m.providerOptions?.anthropic?.cacheControl?.ttl ?? null).filter(Boolean);
    expect(ttls(step)).toEqual(["5m"]);
    expect(new Set(ttls(compaction))).toEqual(new Set(["1h"]));
    // After the summary there is no reply yet: only the last message is marked.
    expect(ttls(after)).toEqual(["5m"]);
    // The second step drops a waiting seal at its start, before its compaction.
    expect(events).toEqual(["call", "step", "call", "call", "compacted", "step"]);
  });

  test.each(models)("$name", async ({ meta, marked }) => {
    const r = await compactBeforeSecondStep(meta, answers);
    expect(r.summary).toBe("the gist");
    expect(r.model.streamCalls).toHaveLength(3);
    const [step, compaction, after] = r.model.streamCalls as [typeof r.model.streamCalls[0], typeof r.model.streamCalls[0], typeof r.model.streamCalls[0]];

    // What the step before sent is where the compaction's prompt starts: the
    // system prompt the steps were sent with first, the history after it.
    expect(compaction.prompt.slice(0, step.prompt.length)).toEqual(step.prompt);
    expect(compaction.prompt[0]).toMatchObject({ role: "system", content: "the prompt it was born with" });
    if (marked) {
      expect(step.prompt[0]!.providerOptions).toEqual({ anthropic: { cacheControl: ANTHROPIC_CACHE_CONTROL } });
      expect(step.prompt.at(-1)!.providerOptions).toEqual({ anthropic: { cacheControl: ANTHROPIC_CACHE_CONTROL } });
    }
    // Then what came since (the reply, the new request), and the compaction prompt last.
    expect(compaction.prompt.length).toBeGreaterThan(step.prompt.length + 2);
    const ask = compaction.prompt.at(-1)!;
    expect(ask.role).toBe("user");
    expect(JSON.stringify(ask.content)).toContain("Answer with the summary itself, as text; do not call any tools.");

    // Sent as a step is: the same tools, tool choice, provider options,
    // headers and reasoning; only the reasoning summary is not asked for.
    expect(compaction.tools?.map((tool) => tool.name)).toEqual(["echo"]);
    expect(compaction.tools).toEqual(step.tools);
    expect(compaction.toolChoice).toEqual(step.toolChoice);
    expect(compaction.headers).toEqual(step.headers);
    expect(compaction.reasoning).toEqual(step.reasoning);
    expect(withoutSummaryRequest(compaction.providerOptions)).toEqual(withoutSummaryRequest(step.providerOptions));
    if (meta.providerType === "openai-compatible") {
      expect(compaction.providerOptions?.openai).toMatchObject({ promptCacheKey: r.thread.id, reasoningSummary: null });
      expect(compaction.headers).toMatchObject({ "x-session-id": r.thread.id });
    }

    // The step after goes on with today's prompt.
    expect(after.prompt[0]).toMatchObject({ role: "system", content: "today's prompt" });
  });

  test("a tool call in the compaction's reply is never run: its text is the summary, and a call alone gets one more try", async () => {
    const r = await compactBeforeSecondStep({ provider: "anthropic", model: "claude-opus-5-5" }, [
      { text: "first answer", finishReason: "stop" },
      { toolCalls: [{ toolCallId: "c1", toolName: "echo", args: { text: "not run" } }] },
      { text: "the gist", toolCalls: [{ toolCallId: "c2", toolName: "echo", args: { text: "not run either" } }] },
      { text: "second answer", finishReason: "stop" }
    ]);
    expect(r.summary).toBe("the gist");
    expect(r.model.streamCalls).toHaveLength(4);
    expect(r.ran).toStrictEqual([]);
    expect(JSON.stringify(r.messages)).not.toContain("not run");
  });

  test("a step prompt that cannot be built: the compaction goes on its own, with no tools, and the prompt is still refreshed after", async () => {
    const r = await compactBeforeSecondStep({ provider: "anthropic", model: "claude-opus-5-5" }, answers, { stepPromptFails: true });
    expect(r.summary).toBe("the gist");
    const compaction = r.model.streamCalls[1]!;
    expect(compaction.tools ?? []).toEqual([]);
    expect(compaction.prompt[0]).toMatchObject({ role: "system", content: "the prompt it was born with" });
    // The history reads the times the thread's steps read.
    const firstUser = compaction.prompt.find((m) => m.role === "user");
    const firstText = Array.isArray(firstUser?.content) ? (firstUser.content as Array<{ type: string; text?: string }>).find((p) => p.type === "text")?.text : undefined;
    expect(firstText).toMatch(/^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}\]\nold /);
    expect(r.model.streamCalls[2]!.prompt[0]).toMatchObject({ role: "system", content: "today's prompt" });
  });
});

// A compaction model that needs its reasoning back (DeepSeek on the Open
// Responses package) gets the placeholder on a step another model wrote;
// a GPT candidate of the same compaction does not.
test("each candidate gets its own placeholder rule", async () => {
  const env = freshStoresEnv("md-cmp-placeholder-");
  try {
    const { store, agentStore } = env;
    const thread = agentStore.getOrCreateThread("manager", null);
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } });
    agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "call-other", toolName: "bash", args: { command: "pwd" } }], writtenBy: { provider: "kilo", model: "vendor/other" } } as never });
    agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "tool", content: { type: "tool_result", toolCallId: "call-other", toolName: "bash", result: "/p" } } as never);
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest request" } });
    const gpt = createMockLLM([{ text: "", finishReason: "error" }], { mode: "stream", provider: "openai.responses", modelId: "openai/gpt-6.1-sol" });
    const deepseek = createMockLLM([{ text: "summary", finishReason: "stop" }], { mode: "stream", provider: "openResponses.responses", modelId: "deepseek/deepseek-flash" });
    const recorder = new AgentLlmCallRecorder({ store, logRequests: "full", provider: "openai-compatible", model: "m", baseURL: "", apiMode: "streamText" });
    const controller = createAgentCompressionController({
      config: configWithThreshold(10), store, extractWindow: () => {}, agentStore, cursors: { resetThread: () => {} },
      sse: stub<AgentSseEmitter>({ emit: () => {} }),
      compressionForThread: () => ({
        supportsReasoning: undefined, model: gpt, provider: "openai-compatible", recorder,
        candidates: [
          { model: gpt, provider: "openai-compatible", reasoningEffort: "medium", supportsReasoning: undefined, recorder },
          { model: deepseek, provider: "openai-compatible", reasoningEffort: "medium", supportsReasoning: undefined, recorder }
        ]
      }),
      buildSystemPrompt: () => "system"
    });
    await controller.beforeModelCallHook(thread.id, { wakeId: "wake-ph", reason: "user", triggerMessageId: null });
    const placeholders = (model: { calls: Array<{ options: { prompt: Array<{ role: string; content: unknown }> } }> }) =>
      model.calls[0]!.options.prompt.filter((m) => m.role === "assistant" && Array.isArray(m.content) && JSON.stringify((m.content as unknown[])[0]) === JSON.stringify({ type: "reasoning", text: " " })).length;
    expect([gpt.callsMade, deepseek.callsMade]).toEqual([1, 1]);
    expect([placeholders(gpt as never), placeholders(deepseek as never)]).toEqual([0, 1]);
    // Each attempt's record is the history that attempt sent.
    const recorded = (store.db.prepare("select request_json from llm_calls where purpose = 'agent_compression' order by rowid").all() as Array<{ request_json: string }>)
      .map((row) => row.request_json.includes('"text":" "'));
    expect(recorded).toEqual([false, true]);
  } finally { env.cleanup(); }
});

// A continued Google reply bills the sum of its requests' prompts; the gate
// reads the context the model read, kept beside it on the call.
test("the gate reads a continued call's context, not its billed sum", async () => {
  const { store, agentStore } = freshStoresEnv("md-cmp-size-context-");
  const recorder = new AgentLlmCallRecorder({ store: null, logRequests: "off", provider: "mock", model: "mock", baseURL: "", apiMode: "" });
  const controller = createAgentCompressionController({
    config: configWithThreshold(50_000), store, extractWindow: () => {}, agentStore, cursors: { resetThread: () => {} },
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    compressionForThread: () => ({
      supportsReasoning: undefined,
      model: createMockLLM([{ text: "compressed summary", finishReason: "stop", usage: { promptTokens: 25, completionTokens: 5 } }], { mode: "stream" }),
      provider: "mock", recorder
    }),
    buildSystemPrompt: () => "system"
  });
  try {
    const thread = agentStore.createManagerThread("continued");
    const old = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } });
    const latest = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest request" } });
    const at = new Date().toISOString();
    store.db.prepare(`
        insert into llm_calls (id, purpose, scope_type, scope_id, status, input_tokens, metadata_json, started_at, finished_at, created_at, updated_at)
        values (?, 'agent_wake_step', 'agent_thread', ?, 'succeeded', 272768, ?, ?, ?, ?, ?)
      `).run(`call_${thread.id}`, thread.id, JSON.stringify({ promptMaxSeq: old.seq, contextInputTokens: 60_000 }), at, at, at, at);
    const result = await controller.beforeModelCallHook(thread.id, { wakeId: `wake-${thread.id}`, reason: "user", triggerMessageId: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.historyChanged).toBe(true);
    const summary = agentStore.getMessages(thread.id).filter((m) => m.content.type === "summary").at(-1)!;
    expect(contentOf(summary, "summary").tokensBefore).toBe(60_000 + estimateMessagesTokens([latest]));
  } finally { store.db.close(); }
});

// Compaction on the step's prompt sends each candidate its own history
// (messagesFor); each attempt's record is that history, not the first's.
test("compaction on the step prompt records the history each attempt sent", async () => {
  const { store, agentStore } = freshStoresEnv("md-cmp-step-record-");
  try {
    const thread = agentStore.createManagerThread("step record");
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } });
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "latest request" } });
    const recorder = new AgentLlmCallRecorder({ store, logRequests: "full", provider: "openai-compatible", model: "m", baseURL: "", apiMode: "streamText" });
    const first = createMockLLM([{ text: "", finishReason: "error" }], { mode: "stream", provider: "openai.responses", modelId: "openai/gpt-6.1-sol" });
    const second = createMockLLM([{ text: "the gist", finishReason: "stop" }], { mode: "stream", provider: "openResponses.responses", modelId: "deepseek/deepseek-flash" });
    const candidates = [
      { model: first, llmCallRecorder: recorder, meta: { provider: "openai-compatible", model: "openai/gpt-6.1-sol" } },
      { model: second, llmCallRecorder: recorder, meta: { provider: "openai-compatible", model: "deepseek/deepseek-flash" } }
    ];
    const historyOf = (name: string): ModelMessage[] => [{ role: "user", content: `history for ${name}` }];
    const controller = createAgentCompressionController({
      config: configWithThreshold(10), store, extractWindow: () => {}, agentStore, cursors: { resetThread: () => {} },
      sse: stub<AgentSseEmitter>({ emit: () => {} }),
      compressionForThread: () => ({ supportsReasoning: undefined, model: first, provider: "openai-compatible", recorder }),
      buildSystemPrompt: () => "system",
      stepPromptForThread: () => ({
        tools: {}, systemContent: "system", system: "system", candidates: candidates as never, promptMaxSeq: 1,
        messagesFor: (candidate: { meta?: { model?: string } }) => historyOf(candidate.meta?.model ?? ""),
        messages: historyOf("openai/gpt-6.1-sol")
      })
    });
    await controller.beforeModelCallHook(thread.id, { wakeId: "wake-step-record", reason: "user", triggerMessageId: null });
    const recorded = (store.db.prepare("select request_json from llm_calls where purpose = 'agent_compression' order by rowid").all() as Array<{ request_json: string }>)
      .map((row) => (row.request_json.match(/history for ([\w/.-]+)/) ?? [])[1]);
    expect(recorded).toEqual(["openai/gpt-6.1-sol", "deepseek/deepseek-flash"]);
  } finally { store.db.close(); }
});

// ── an idle compaction ───────────────────────────────────────────────────

/** Two candidates on the thread's step prompt: the cache is warm on the second. */
function idleSetup(opts: { warmScript?: Parameters<typeof createMockLLM>[0]; noPrompt?: boolean } = {}) {
  const env = freshStoresEnv("md-cmp-idle-");
  const seeded = seedCompactable(env.agentStore, "project-1 3.22 release");
  const cold = createMockLLM([{ text: "the gist", finishReason: "stop" }], { mode: "stream" });
  const warm = createMockLLM(opts.warmScript ?? [{ text: "the gist", finishReason: "stop", usage: { promptTokens: 25, completionTokens: 5 } }], { mode: "stream" });
  const route = createMockLLM([{ text: "the gist", finishReason: "stop" }], { mode: "stream" });
  const warmRecorder = new AgentLlmCallRecorder({ store: env.store, logRequests: "metadata", provider: "anthropic", model: "anthropic/claude-sonnet-5-5", baseURL: "", apiMode: "streamText" });
  const a: WakeLlmCandidate = { model: cold, meta: { provider: "anthropic", providerName: "provider-1", model: "anthropic/claude-sonnet-5-5", reasoningEffort: "low" } };
  const b: WakeLlmCandidate = { model: warm, meta: { provider: "anthropic", providerName: "provider-1", model: "anthropic/claude-sonnet-5-5", reasoningEffort: "high" }, llmCallRecorder: warmRecorder };
  const history = [{ role: "user" as const, content: "Draft the notes" }];
  const prompt: StepPrompt = { tools: {}, systemContent: "system", system: "system", candidates: [a, b], messagesFor: () => history, messages: history, promptMaxSeq: 3 };
  const m = manualController(env, route, "system", () => {
    if (opts.noPrompt) throw new Error("no candidate takes the step's prompt");
    return prompt;
  });
  const only = (c: WakeLlmCandidate) => c === b;
  return { env, ...seeded, m, cold, warm, route, only };
}

test("compactIdle: under the minimum it does nothing and lets the thread go", () => {
  const t = idleSetup();
  expect(t.m.controller.compactIdle(t.thread.id, { only: t.only, minTokens: 10_000_000, idleMinutes: 55 })).toBe("small");
  expect([t.cold.calls.length, t.warm.calls.length, t.route.calls.length]).toEqual([0, 0, 0]);
  expect(t.m.lock.isHeld(t.thread.id)).toBe(false);
  t.env.cleanup();
});

test("compactIdle: a held thread is busy", () => {
  const t = idleSetup();
  const release = t.m.lock.tryAcquire(t.thread.id)!;
  expect(t.m.controller.compactIdle(t.thread.id, { only: t.only, minTokens: 100, idleMinutes: 55 })).toBe("busy");
  release();
  t.env.cleanup();
});

test("compactIdle: it runs on the warm cache's model only, tagged idle, and holds the thread meanwhile", async () => {
  const t = idleSetup();
  expect(t.m.controller.compactIdle(t.thread.id, { only: t.only, minTokens: 100, idleMinutes: 55 })).toBe("started");
  // A turn or a message that comes now waits behind it.
  expect(t.m.lock.tryAcquire(t.thread.id)).toBe(null);
  await letGo(t.m.lock, t.thread.id);
  expect([t.cold.calls.length, t.warm.calls.length, t.route.calls.length]).toEqual([0, 1, 0]);
  const started = t.m.events.find((e) => e.name === "agentCompressionStarted")!;
  expect(started.data.reason).toBe("idle");
  const summary = t.env.agentStore.getActiveMessages(t.thread.id).find((msg) => msg.content.type === "summary")!;
  expect(contentOf(summary, "summary")).toMatchObject({ trigger: "idle", idleMinutes: 55 });
  const row = t.env.store.db.prepare("select metadata_json from llm_calls where purpose = 'agent_compression'").get() as { metadata_json: string };
  expect(JSON.parse(row.metadata_json).reason).toBe("idle");
  // Free again once done.
  const release = t.m.lock.tryAcquire(t.thread.id);
  expect(release).not.toBe(null);
  release?.();
  t.env.cleanup();
});

test("compactIdle: when the warm model fails it gives up: no other model, no compaction route", async () => {
  const t = idleSetup({ warmScript: [{ error: new Error("Bad request: the request was refused") }] });
  const before = t.env.agentStore.getActiveMessages(t.thread.id).map((msg) => msg.id);
  expect(t.m.controller.compactIdle(t.thread.id, { only: t.only, minTokens: 100, idleMinutes: 55 })).toBe("started");
  await letGo(t.m.lock, t.thread.id);
  expect([t.cold.calls.length, t.route.calls.length]).toEqual([0, 0]);
  expect(t.m.events.find((e) => e.name === "agentCompressionFailed")?.data.reason).toBe("idle");
  expect(t.env.agentStore.getActiveMessages(t.thread.id).map((msg) => msg.id)).toEqual(before);
  t.env.cleanup();
});

// An idle run is a compaction like one by hand, for the page (its working
// state survives a reload) and for /compact and /stop.
test("compactIdle: while it runs the thread is compacting, and stops being when it ends", async () => {
  const t = idleSetup();
  expect(t.m.controller.compactIdle(t.thread.id, { only: t.only, minTokens: 100, idleMinutes: 55 })).toBe("started");
  expect([t.m.controller.isCompacting(t.thread.id), t.m.controller.compactNow(t.thread.id)]).toEqual([true, "compacting"]);
  await letGo(t.m.lock, t.thread.id);
  expect(t.m.controller.isCompacting(t.thread.id)).toBe(false);
  t.env.cleanup();
});

test("compactIdle: a failed run stops being a compaction too", async () => {
  const t = idleSetup({ warmScript: [{ error: new Error("Bad request: the request was refused") }] });
  expect(t.m.controller.compactIdle(t.thread.id, { only: t.only, minTokens: 100, idleMinutes: 55 })).toBe("started");
  await letGo(t.m.lock, t.thread.id);
  expect(t.m.controller.isCompacting(t.thread.id)).toBe(false);
  t.env.cleanup();
});

test("compactIdle: with no step prompt it gives up without calling any model", async () => {
  const t = idleSetup({ noPrompt: true });
  expect(t.m.controller.compactIdle(t.thread.id, { only: t.only, minTokens: 100, idleMinutes: 55 })).toBe("started");
  await letGo(t.m.lock, t.thread.id);
  expect([t.cold.calls.length, t.warm.calls.length, t.route.calls.length]).toEqual([0, 0, 0]);
  t.env.cleanup();
});

// End to end, not only at the lock: the wake scheduler's own hold and the
// message queue, as the runtime runs them: a message sent while an idle
// compaction holds the thread waits, then its turn starts on the compacted
// thread; nothing is lost and no second compaction runs.
test("compactIdle: a message sent meanwhile waits, then its turn reads the summary and the message", async () => {
  const env = freshStoresEnv("md-cmp-idle-queue-");
  const { thread } = seedCompactable(env.agentStore, "project-1 3.22 release");
  // Enough answers for a second compaction, so one would show rather than fail on an empty script.
  const warm = createMockLLM([0, 1].map(() => ({ text: "the gist", finishReason: "stop" as const, usage: { promptTokens: 25, completionTokens: 5 } })), { mode: "stream" });
  const route = createMockLLM([0, 1].map(() => ({ text: "the gist", finishReason: "stop" as const })), { mode: "stream" });
  const turn = createMockLLM([{ text: "Yes, the 3.22 notes are ready.", finishReason: "stop" }], { mode: "stream" });
  const kept: WakeLlmCandidate = { model: warm, meta: { provider: "anthropic", providerName: "provider-1", model: "anthropic/claude-sonnet-5-5", reasoningEffort: "high" } };
  const history = [{ role: "user" as const, content: "Draft the notes" }];
  const prompt: StepPrompt = { tools: {}, systemContent: "system", system: "system", candidates: [kept], messagesFor: () => history, messages: history, promptMaxSeq: 3 };
  const box: { queue?: AgentUserMessageQueue; controller?: ReturnType<typeof createAgentCompressionController> } = {};
  const started: unknown[] = [];
  const wakes = createTestWakeScheduler({
    agentStore: env.agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "system",
    toolDispatcherForThread: () => new ToolDispatcher(new ToolRegistry()),
    llmModel: turn,
    sse: { emit: () => {} },
    buildToolScope: () => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } }),
    // As the runtime wires them: the compaction gate before each call, and
    // what queued behind a thread starting when it is let go.
    beforeModelCallHook: (threadId, info) => box.controller!.beforeModelCallHook(threadId, info),
    afterWakeReleasedHook: (threadId) => { box.queue?.flushIfIdle(threadId); }
  });
  box.queue = new AgentUserMessageQueue({ agentStore: env.agentStore, sse: { emit() {} }, wakeScheduler: wakes.scheduler });
  const controller = box.controller = createAgentCompressionController({
    config: configWithThreshold(50_000),
    store: env.store,
    agentStore: env.agentStore,
    extractWindow: () => {},
    cursors: { resetThread: () => {} },
    sse: stub<AgentSseEmitter>({ emit: (name: string, data: unknown) => { if (name === "agentCompressionStarted") started.push(data); } }),
    compressionForThread: () => ({ supportsReasoning: undefined, model: route, provider: "mock", recorder: new AgentLlmCallRecorder({ store: null, logRequests: "off", provider: "mock", model: "mock", baseURL: "", apiMode: "" }) }),
    buildSystemPrompt: () => "system",
    holdThread: (threadId) => wakes.scheduler.holdThread(threadId),
    stepPromptForThread: () => prompt
  });

  expect(controller.compactIdle(thread.id, { only: (c) => c === kept, minTokens: 100, idleMinutes: 55 })).toBe("started");
  const sent = box.queue.submitThreadUserMessage({ threadId: thread.id, content: "Are the 3.22 notes ready?", source: "user" });
  expect([sent.queued, sent.messageId]).toEqual([true, null]);
  for (let i = 0; i < 400 && (turn.calls.length === 0 || wakes.scheduler.isThreadBusy(thread.id)); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));

  expect([started.length, warm.calls.length, route.calls.length, turn.calls.length]).toEqual([1, 1, 0, 1]);
  const active = env.agentStore.getActiveMessages(thread.id);
  const summaries = active.filter((msg) => msg.content.type === "summary");
  expect(summaries.map((msg) => contentOf(msg, "summary").trigger)).toEqual(["idle"]);
  const asked = active.find((msg) => msg.content.type === "text" && msg.content.text === "Are the 3.22 notes ready?")!;
  expect(asked.seq).toBeGreaterThan(summaries[0]!.seq);
  const read = JSON.stringify(turn.calls[0]!.options.prompt);
  // The summary, then the message that waited (a user's own turns are kept as they were).
  expect([read.indexOf("the gist") >= 0, read.indexOf("the gist") < read.indexOf("Are the 3.22 notes ready?")]).toEqual([true, true]);
  env.cleanup();
});
