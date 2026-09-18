import { expect, test } from "bun:test";
import {
  estimateMessagesTokens,
  getCompressionGateDecision,
  shouldCompress,
  shouldCompressionGateCompress,
  selectMessagesToCompress,
  selectRecentUserMessagesForCompaction,
  runCompression
} from "../src/server/modules/agent/compression.js";
import {
  buildLocalCompressionMessages,
  createAgentCompressionController
} from "../src/server/runtime/agent-compression-controller.js";
import { runAgentCompressionLlm } from "../src/server/runtime/agent-compression-llm.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshAgentEnv, freshStoresEnv } from "./helpers/fixtures.js";

const cfg = { thresholdTokens: 100 };
const fresh = () => freshAgentEnv("md-cmp-");

function msg(overrides: any): any {
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

test("shouldCompress: false below threshold", () => {
  const msgs = [msg({ content: { type: "text", text: "x".repeat(50) } })];
  expect(shouldCompress(msgs, cfg)).toBe(false);
});

test("shouldCompress: true above token threshold", () => {
  const msgs = [msg({ content: { type: "text", text: "x".repeat(800) } })];
  expect(shouldCompress(msgs, cfg)).toBe(true);
});

test("shouldCompress: fallback estimate is CJK-aware with safety margin", () => {
  const below = [msg({ content: { type: "text", text: "你".repeat(70) } })];
  const above = [msg({ content: { type: "text", text: "你".repeat(100) } })];
  expect(shouldCompress(below, cfg)).toBe(false);
  expect(shouldCompress(above, cfg)).toBe(true);
});

test("shouldCompress: observed input tokens take precedence over estimates", () => {
  const hugeEstimate = [msg({ content: { type: "text", text: "x".repeat(800) } })];
  expect(shouldCompress(hugeEstimate, cfg, { lastInputTokens: 99 })).toBe(false);

  const smallEstimate = [msg({ content: { type: "text", text: "x" } })];
  expect(shouldCompress(smallEstimate, cfg, { lastInputTokens: 100 })).toBe(true);
});

test("shouldCompressionGateCompress: uses previous real input tokens plus new message estimate", () => {
  const msgs = [
    msg({ seq: 1, content: { type: "text", text: "old" } }),
    msg({ seq: 2, content: { type: "text", text: "new ".repeat(80) } })
  ];
  expect(shouldCompressionGateCompress(msgs, cfg, {
    previousInputTokens: 90,
    previousPromptMaxSeq: 1
  })).toBe(true);
});

test("shouldCompressionGateCompress: observed previous prompt wins over active estimate", () => {
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

test("shouldCompressionGateCompress: fallback estimate includes append-only runtime context", () => {
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
  expect(shouldCompressionGateCompress(msgs, cfg)).toBe(true);
});

test("shouldCompressionGateCompress: ignores previous token signal after compression rewrites history", () => {
  const msgs = [
    {
      seq: 3,
      source: "compression",
      content: { type: "summary", summary: "short", replacedRange: [1, 2], replacedCount: 2 }
    },
    { seq: 4, source: "user", content: { type: "text", text: "next" } }
  ] as any[];
  expect(shouldCompressionGateCompress(msgs, cfg, {
    previousInputTokens: 99,
    previousPromptMaxSeq: 2
  })).toBe(false);
});

test("selectMessagesToCompress: selects non-retained history while keeping recent user intent", () => {
  const msgs = [
    { id: "m1", seq: 1, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } },
    { id: "m2", seq: 2, role: "assistant", source: "self", content: { type: "text", text: "assistant detail" } },
    { id: "m3", seq: 3, role: "user", source: "user", content: { type: "text", text: "latest user intent" } },
    { id: "m4", seq: 4, role: "assistant", source: "self", content: { type: "text", text: "post intent detail" } }
  ] as any[];
  const sel = selectMessagesToCompress(msgs);
  expect(sel.map((m) => m.seq)).toEqual([1, 2, 4]);
});

test("selectRecentUserMessagesForCompaction: retains only recent user messages within the Codex budget", () => {
  const msgs = [
    { id: "m1", seq: 1, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } },
    { id: "m2", seq: 2, role: "assistant", source: "self", content: { type: "text", text: "assistant detail" } },
    { id: "m3", seq: 3, role: "user", source: "user", content: { type: "text", text: "latest user intent" } }
  ] as any[];
  expect(selectRecentUserMessagesForCompaction(msgs).map((m) => m.seq)).toEqual([3]);
});

test("selectRecentUserMessagesForCompaction: does not retain runtime context snapshots", () => {
  const msgs = [
    { id: "m1", seq: 1, role: "user", source: "user", content: { type: "text", text: "old ".repeat(90_000) } },
    { id: "m2", seq: 2, role: "user", source: "runtime-context", content: { type: "text", text: "[runtime_context]\nstate" } },
    { id: "m3", seq: 3, role: "user", source: "user", content: { type: "text", text: "latest user intent" } }
  ] as any[];
  expect(selectRecentUserMessagesForCompaction(msgs).map((m) => m.seq)).toEqual([3]);
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
    agentStore.appendMessage({
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
    expect((active[0].content as any).text).toBe("latest user intent");
    expect(active[1].role).toBe("user");
    expect((active[1].content as any).type).toBe("summary");
    // Two, not three: the summariser read all three messages, but the latest
    // user turn is retained, so only two are actually replaced.
    expect((active[1].content as any).replacedCount).toBe(2);
    expect((active[1].content as any).replacedRange).toEqual([1, 3]);
    expect((active[1].content as any).summary).toBe("summarized");
    const all = agentStore.getMessages(thread.id);
    expect(all).toHaveLength(4);
    expect(all.slice(0, before.length)).toEqual(before);
    expect(all[3]!.id).toBe(result!.summaryMessage.id);
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

    const result = await runCompression({
      agentStore,
      summarizer: async () => {
        throw new Error("summarizer should not run");
      }
    }, thread.id);

    expect(result).toBe(null);
    expect(agentStore.getActiveMessages(thread.id).map((m) => m.source)).toEqual([
      "runtime-context",
      "user"
    ]);
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
    await runCompression({
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
    expect(result?.summaryMessage.seq).toBe(6);
    const active = agentStore.getActiveMessages(thread.id);
    // Both retained user turns survive: seq 2 is still inside the recent-user
    // budget and seq 5 is the newest. The summary still comes last.
    expect(active.map((m) => m.seq)).toEqual([2, 5, 6]);
    expect(active[2]!.id).toBe(result!.summaryMessage.id);
    expect((active[2]!.content as any).summary).toBe("second");
  } finally { cleanup(); }
});

test("compression controller publishes finish before memory extraction, and resets pane read cursors", async () => {
  const { store, projects, features, agentStore, cleanup } = freshStoresEnv("md-cmp-controller-");
  try {
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

    const events: string[] = [];
    const compressionModel = createMockLLM([
      { text: "compressed summary", finishReason: "stop", usage: { promptTokens: 25, completionTokens: 5 } }
    ], { mode: "stream" });
    const hangingMemoryModel = {
      specificationVersion: "v3",
      provider: "mock-memory",
      modelId: "mock-memory",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("memory extraction must use streamText");
      },
      async doStream() {
        events.push("memory-model-called");
        return await new Promise(() => {});
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
    const resetCursorThreads: string[] = [];
    const controller = createAgentCompressionController({
      config: { agent: { compressionThresholdTokens: 10 } } as any,
      store,
      projectsStore: projects,
      featuresStore: features,
      agentStore,
      cursors: { resetThread: (threadId: string) => resetCursorThreads.push(threadId) },
      sse: {
        emit: (name: string) => {
          if (
            name === "agentMessageAppended"
            || name === "agentCompressionFinished"
            || name === "agentCompressionStarted"
          ) {
            events.push(name);
          }
        }
      } as any,
      compressionForThread: () => ({
        model: compressionModel as any,
        provider: "mock",
        recorder
      }),
      buildSystemPrompt: () => "system",
      memoryManager: {} as any,
      memoryExtractionForThread: () => {
        events.push("memory-extraction-started");
        return {
          model: hangingMemoryModel as any,
          provider: "mock",
          recorder
        };
      }
    });

    const result = await controller.beforeModelCallHook(thread.id, {
      wakeId: "wake-test",
      reason: "user",
      triggerMessageId: null,
      allowTools: true
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.historyChanged).toBe(true);
    // A real compression must forget what read_pane already showed this thread:
    // the messages holding those pane lines may have been summarized away.
    expect(resetCursorThreads).toEqual([thread.id]);
    expect(events.slice(0, 4)).toEqual([
      "agentCompressionStarted",
      "agentMessageAppended",
      "agentCompressionFinished",
      "memory-extraction-started"
    ]);
  } finally {
    cleanup();
  }
});

test("compression controller serializes overlapping compression for one thread", async () => {
  const { store, projects, features, agentStore, cleanup } = freshStoresEnv("md-cmp-controller-lock-");
  try {
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
    const blockingCompressionModel = {
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
    const memoryModel = createMockLLM([
      { text: "{\"memories\":[]}", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 1 } }
    ], { mode: "stream" });
    const recorder = new AgentLlmCallRecorder({
      store: null,
      logRequests: "off",
      provider: "mock",
      model: "mock",
      baseURL: "",
      apiMode: ""
    });
    const controller = createAgentCompressionController({
      config: { agent: { compressionThresholdTokens: 10 } } as any,
      store,
      projectsStore: projects,
      featuresStore: features,
      agentStore,
      cursors: { resetThread: () => {} },
      sse: { emit: () => {} } as any,
      compressionForThread: () => ({
        model: blockingCompressionModel as any,
        provider: "mock",
        recorder
      }),
      buildSystemPrompt: () => "system",
      memoryManager: {} as any,
      memoryExtractionForThread: () => ({
        model: memoryModel as any,
        provider: "mock",
        recorder
      })
    });

    const firstCompression = controller.beforeModelCallHook(thread.id, {
      wakeId: "wake-first",
      reason: "user",
      triggerMessageId: null,
      allowTools: true
    });
    await compressionStartedPromise;

    const overlappingCompression = controller.beforeModelCallHook(thread.id, {
      wakeId: "wake-overlap",
      reason: "user",
      triggerMessageId: null,
      allowTools: true
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
  } finally { cleanup(); }
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

test("runAgentCompressionLlm uses streaming for OpenAI Codex", async () => {
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
    supportsReasoning: true,
    system: "summarize",
    messages: [{ role: "user", content: "text" }]
  });

  expect(result.text).toBe("compressed summary");
  expect(streamCalls.length).toBe(1);
  expect(streamCalls[0].reasoning).toBe("high");
  expect(streamCalls[0].providerOptions?.openai?.forceReasoning).toBe(true);
});

test("runAgentCompressionLlm omits reasoning when model disables reasoning support", async () => {
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
    supportsReasoning: false,
    system: "summarize",
    messages: [{ role: "user", content: "text" }]
  });

  expect(result.text).toBe("compressed summary");
  expect(streamCalls.length).toBe(1);
  expect(streamCalls[0].reasoning).toBeUndefined();
  expect(streamCalls[0].providerOptions?.openai?.forceReasoning).toBeUndefined();
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

test("runAgentCompressionLlm uses streaming for OpenAI-compatible compression", async () => {
  const streamCalls: any[] = [];
  const model = {
    specificationVersion: "v3" as const,
    provider: "mock-openai",
    modelId: "mock-openai",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("OpenAI-compatible compression must not use doGenerate");
    },
    async doStream(options: any) {
      streamCalls.push(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text-0" });
            controller.enqueue({ type: "text-delta", id: "text-0", delta: "generated summary" });
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
    provider: "openai-compatible",
    reasoningEffort: "high",
    supportsReasoning: true,
    system: "summarize",
    messages: [{ role: "user", content: "text" }]
  });

  expect(result.text).toBe("generated summary");
  expect(streamCalls.length).toBe(1);
  expect(streamCalls[0].reasoning).toBe("high");
  expect(streamCalls[0].providerOptions?.openai?.forceReasoning).toBe(true);
});

test("runCompression: resets pane read cursors for the compressed thread", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-cursor-reset");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "old ".repeat(90_000) }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "assistant detail" }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "latest user intent" }
    });

    const reset: string[] = [];
    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" }),
      cursors: { resetThread: (threadId: string) => { reset.push(threadId); } }
    }, thread.id);

    expect(result).not.toBe(null);
    expect(reset).toEqual([thread.id]);
  } finally { cleanup(); }
});

test("runCompression: leaves pane read cursors alone when nothing is compressed", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-cursor-noop");
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
    expect(reset).toEqual([]);
  } finally { cleanup(); }
});

test("runCompression: records the retained user messages on the summary", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-retain-record");
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

    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" })
    }, thread.id);

    const content = result!.summaryMessage.content as any;
    expect(content.type).toBe("summary");
    // Within budget, so it is referenced by id alone with no truncated copy.
    expect(content.retained).toEqual([{ id: latest.id }]);
  } finally { cleanup(); }
});

test("runCompression: truncates a retained user message that alone blows the budget", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-retain-truncate");
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "assistant detail" }
    });
    // The newest retainable turn is itself far over the 20k-token budget. The
    // selection loop always keeps the newest one regardless of size, so without
    // truncation the whole paste would survive and compression would reclaim
    // almost nothing.
    const huge = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "paste ".repeat(90_000) }
    });

    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" })
    }, thread.id);

    const content = result!.summaryMessage.content as any;
    expect(content.retained).toHaveLength(1);
    expect(content.retained[0].id).toBe(huge.id);
    expect(typeof content.retained[0].truncatedText).toBe("string");
    expect(content.retained[0].truncatedText.length)
      .toBeLessThan((huge.content as any).text.length);
    // Pinned on BOTH sides. An upper bound alone would still pass if the budget
    // regressed to 20_000 chars; the lower bound is what catches that.
    // Latin text: 20_000 tokens * 4 chars / 1.15 margin ≈ 69_565 chars.
    expect(content.retained[0].truncatedText.length).toBeGreaterThan(65_000);
    expect(content.retained[0].truncatedText.length).toBeLessThan(70_000);
  } finally { cleanup(); }
});

test("runCompression: the truncation budget counts CJK weight, not raw characters", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-retain-cjk");
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "assistant detail" }
    });
    // estimateStringChars weighs one CJK character as 4, so the same token
    // budget buys ~4x fewer of them. Cutting by raw length would leave this at
    // roughly 4.6x the budget it is supposed to enforce.
    const huge = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "压缩保真度测试用例".repeat(20_000) }
    });

    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" })
    }, thread.id);

    const content = result!.summaryMessage.content as any;
    expect(content.retained).toHaveLength(1);
    expect(content.retained[0].id).toBe(huge.id);
    // CJK: 69_565 effective chars / 4 per char ≈ 17_391 real characters.
    expect(content.retained[0].truncatedText.length).toBeGreaterThan(15_000);
    expect(content.retained[0].truncatedText.length).toBeLessThan(18_000);
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

    const content = result!.summaryMessage.content as any;
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

    const content = result!.summaryMessage.content as any;
    expect(content.retained).toHaveLength(1);
    const original = (message.content as any).text as string;
    expect(content.retained[0].truncatedText).not.toBe(original);
    expect(content.retained[0].truncatedText.length).toBeLessThan(70_000);
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

    const content = result!.summaryMessage.content as any;
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

    const content = result!.summaryMessage.content as any;
    expect(content.retained.map((entry: any) => entry.id)).toEqual([turns[3]!.id]);
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

    const content = result!.summaryMessage.content as any;
    expect(content.retained.map((entry: any) => entry.id)).toEqual(turns.map((t) => t.id));
  } finally { cleanup(); }
});

test("runCompression: a clamped budget also bounds the truncated copy", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-retain-clamp-truncate");
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: { type: "text", text: "assistant detail" }
    });
    // The newest retainable turn is kept regardless of size, so the truncation
    // budget is the only thing standing between a small threshold and a
    // post-compression window that is still over it.
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "paste ".repeat(90_000) }
    });

    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" }),
      thresholdTokens: 4_000
    }, thread.id);

    const content = result!.summaryMessage.content as any;
    // 1_000 tokens * 4 chars / 1.15 margin ≈ 3_478 chars, not 69_565.
    expect(content.retained[0].truncatedText.length).toBeLessThan(4_000);
    expect(content.retained[0].truncatedText.length).toBeGreaterThan(3_000);
  } finally { cleanup(); }
});

test("compression controller passes the configured threshold into the retained budget", async () => {
  const { store, projects, features, agentStore, cleanup } = freshStoresEnv("md-cmp-threshold-");
  try {
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
      config: { agent: { compressionThresholdTokens: 4_000 } } as any,
      store,
      projectsStore: projects,
      featuresStore: features,
      agentStore,
      cursors: { resetThread: () => {} },
      sse: { emit: () => {} } as any,
      compressionForThread: () => ({
        model: createMockLLM([
          { text: "compressed summary", finishReason: "stop", usage: { promptTokens: 25, completionTokens: 5 } }
        ], { mode: "stream" }) as any,
        provider: "mock",
        recorder
      }),
      buildSystemPrompt: () => "system",
      memoryManager: {} as any,
      memoryExtractionForThread: () => ({
        model: {
          specificationVersion: "v3",
          provider: "mock-memory",
          modelId: "mock-memory",
          supportedUrls: {},
          async doGenerate() { throw new Error("unused"); },
          async doStream() { return await new Promise(() => {}); }
        } as any,
        provider: "mock",
        recorder
      })
    });

    const result = await controller.beforeModelCallHook(thread.id, {
      wakeId: "wake-threshold", reason: "user", triggerMessageId: null, allowTools: true
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.historyChanged).toBe(true);
    const summary = agentStore.getMessages(thread.id)
      .filter((m) => m.content.type === "summary")
      .at(-1)!;
    // 4_000 / 4 = 1_000 tokens, so only the newest ~575-token turn fits. With
    // the flat 20_000 all four would come back.
    expect((summary.content as any).retained).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("getActiveMessages: a summary without retained derives as before", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-legacy-summary");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "first" }
    });
    // A summary row shaped like the ones written before the field existed.
    const summary = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "compression",
      content: { type: "summary", summary: "legacy", replacedRange: [1, 1], replacedCount: 1 } as any
    });

    const active = agentStore.getActiveMessages(thread.id);
    expect(active.map((m) => m.id)).toEqual([summary.id]);
  } finally { cleanup(); }
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
      } as any
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
      } as any
    });

    const active = agentStore.getActiveMessages(thread.id);
    expect(active.map((m) => m.id)).toEqual([huge.id, summary.id]);
    // Identity comes from the real row; only the content is swapped.
    expect(active[0]!.seq).toBe(huge.seq);
    expect(active[0]!.role).toBe("user");
    expect(active[0]!.source).toBe("user");
    expect((active[0]!.content as any).text).toBe("paste paste … [truncated]");
    // The stored row itself is untouched — the log stays honest.
    expect((agentStore.getMessageById(huge.id)!.content as any).text)
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

test("compression refreshes a stale stored system prompt to the current template", async () => {
  const { store, projects, features, agentStore, cleanup } = freshStoresEnv("md-cmp-sysrefresh-");
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    // The thread was born under an old prompt template and froze it.
    const frozen = agentStore.ensureSystemMessage(thread.id, "old policy: send_keys first");
    expect(frozen?.content).toEqual({ type: "text", text: "old policy: send_keys first" });

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

    const compressionModel = createMockLLM([
      { text: "compressed summary", finishReason: "stop", usage: { promptTokens: 25, completionTokens: 5 } }
    ], { mode: "stream" });
    const recorder = new AgentLlmCallRecorder({
      store: null,
      logRequests: "off",
      provider: "mock",
      model: "mock",
      baseURL: "",
      apiMode: ""
    });
    const controller = createAgentCompressionController({
      config: { agent: { compressionThresholdTokens: 10 } } as any,
      store,
      projectsStore: projects,
      featuresStore: features,
      agentStore,
      cursors: { resetThread: () => {} },
      sse: { emit: () => {} } as any,
      compressionForThread: () => ({
        model: compressionModel as any,
        provider: "mock",
        recorder
      }),
      // The template shipped a policy upgrade since the thread was created.
      buildSystemPrompt: () => "new policy: bash by default",
      memoryManager: {} as any,
      memoryExtractionForThread: () => ({
        model: compressionModel as any,
        provider: "mock",
        recorder
      })
    });

    const result = await controller.beforeModelCallHook(thread.id, {
      wakeId: "wake-sysrefresh",
      reason: "user",
      triggerMessageId: null,
      allowTools: true
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.historyChanged).toBe(true);
    // Compression is a context-reset boundary: the stored system message now
    // carries the current template, not the one the thread was born with.
    expect(agentStore.getSystemMessage(thread.id)?.content).toEqual({
      type: "text",
      text: "new policy: bash by default"
    });
  } finally {
    cleanup();
  }
});
