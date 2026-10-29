import { expect, test } from "bun:test";
import * as os from "node:os";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { CacheSealer } from "../src/server/modules/agent/cache-seal/cache-sealer.js";
import { CacheSealLedger } from "../src/server/modules/agent/cache-seal/seal-ledger.js";
import { createSealSender } from "../src/server/modules/agent/cache-seal/send-seal.js";
import { IdleCompactor } from "../src/server/modules/agent/idle-compaction/idle-compactor.js";
import type { IdleCompactOptions } from "../src/server/modules/agent/idle-compaction/types.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";
import { tool } from "ai";
import { z } from "zod";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";

// Wake steps and the cache seal together: a Claude step writes its messages
// for five minutes and its quiet thread is sealed once, as a call of its own;
// switched off, paused, a fallback or a subagent, the marks are an hour as
// before and nothing is sealed.

const HOUR = { type: "ephemeral", ttl: "1h" };
const FIVE = { type: "ephemeral", ttl: "5m" };
const SCOPE = (_t: string): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] });
const NO_TOOLS: ToolDispatcher = { registry: { tools: {} }, dispatch: async () => ({ result: "ok" }) };
const CLAUDE_META = { provider: "anthropic", providerType: "openai-compatible", providerName: "provider-1", model: "anthropic/claude-sonnet-5-5", reasoningEffort: "high" as const };
const GPT_META = { provider: "openai-compatible", providerType: "openai-compatible", providerName: "provider-1", model: "openai/gpt-6.1-sol" };

type Prompt = Array<{ role: string; content: unknown; providerOptions?: { anthropic?: { cacheControl?: unknown } } }>;
const marksOf = (prompt: Prompt) => prompt.map((m) => m.providerOptions?.anthropic?.cacheControl ?? null);

function setup(opts: {
  claudeScript?: Parameters<typeof createMockLLM>[0];
  withGpt?: boolean;
  /** A second Claude, on another connection, as the fallback. */
  withClaudeFallback?: boolean;
  /** The same Claude on the same connection at another effort, as the fallback. */
  withSameModelFallback?: boolean;
  /** The primary takes no images (the fallback after it does). */
  primaryTakesNoImages?: boolean;
  /** The Claude fallback's model id (one with a fixed thinking budget takes no part). */
  fallbackModel?: string;
  dispatcher?: ToolDispatcher;
  subagent?: boolean;
  enabled?: () => boolean;
  /** The step's work before its call (the compaction gate's hook). */
  beforeModelCall?: () => void | Promise<void>;
  /** An idle clock fed by the sealer, its compaction a spy. */
  withIdle?: boolean;
} = {}) {
  const store = new MandateStore(tempDir("md-cache-seal-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("project-1 3.22 release");
  agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Looked at the changelog." } });
  const claude = createMockLLM(opts.claudeScript ?? [{ text: "Here is the draft.", finishReason: "stop" }, { text: ".", finishReason: "length" }], { provider: "anthropic.messages", modelId: CLAUDE_META.model });
  const gpt = createMockLLM([{ text: "Here is the draft.", finishReason: "stop" }], { provider: "openai.responses", modelId: GPT_META.model });
  const claude2 = createMockLLM([{ text: "Here is the draft.", finishReason: "stop" }, { text: ".", finishReason: "length" }], { provider: "anthropic.messages", modelId: "anthropic/claude-sonnet-5.5" });
  const claudeLow = createMockLLM([{ text: "Here is the draft.", finishReason: "stop" }], { provider: "anthropic.messages", modelId: CLAUDE_META.model });
  // Each candidate's own recorder, as the model router gives them: a row names its model.
  const recorderFor = (provider: string, model: string) => new AgentLlmCallRecorder({ store, logRequests: "metadata", provider, model, baseURL: "", apiMode: "streamText" });
  const recorder = recorderFor("anthropic", CLAUDE_META.model);
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const ledger = new CacheSealLedger(() => Date.now());
  const box: { stepPromptFor?: (threadId: string) => Promise<import("../src/server/modules/agent/wake-loop.js").StepPrompt> } = {};
  const idleTimers: Array<{ ms: number; fn: () => void }> = [];
  const compacted: Array<{ threadId: string; opts: IdleCompactOptions }> = [];
  const idle = opts.withIdle ? new IdleCompactor({
    settings: () => ({ enabled: true, leadMinutes: 5, minTokens: 200_000 }),
    now: () => Date.now(),
    setTimer: (fn, ms) => { const timer = { ms, fn }; idleTimers.push(timer); return { cancel: () => { idleTimers.splice(idleTimers.indexOf(timer), 1); } }; },
    typedLifetime: () => undefined,
    stepPromptFor: (threadId) => box.stepPromptFor!(threadId),
    threadCompactable: (threadId) => agentStore.getThreadById(threadId) !== null,
    alarmDueBy: () => false,
    compact: (threadId, o) => { compacted.push({ threadId, opts: o }); return "started"; }
  }) : null;
  const sealer = new CacheSealer({
    enabled: opts.enabled ?? (() => true),
    now: () => Date.now(),
    setTimer: (fn, ms) => { const timer = { ms, fn }; timers.push(timer); return { cancel: () => { timers.splice(timers.indexOf(timer), 1); } }; },
    stepPromptFor: (threadId) => box.stepPromptFor!(threadId),
    threadSealable: (threadId) => agentStore.getThreadById(threadId) !== null,
    sendSeal: createSealSender({ recorderFor: (c) => c.llmCallRecorder ?? null, threadScope: (threadId) => agentStore.getThreadById(threadId)?.scope ?? null, now: () => Date.now() }),
    ledger,
    ...(idle ? { idle } : {})
  });
  const { scheduler, wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => opts.dispatcher ?? NO_TOOLS,
    llmModel: claude,
    llmCallRecorder: recorder,
    llmForThread: () => ({
      model: claude,
      // Each candidate records its own calls, as the model router gives them.
      candidates: [
        { model: claude, meta: CLAUDE_META, llmCallRecorder: recorder, ...(opts.primaryTakesNoImages ? { supportsImageInput: false } : {}) },
        ...(opts.withGpt ? [{ model: gpt, meta: GPT_META, llmCallRecorder: recorderFor("openai-compatible", GPT_META.model) }] : []),
        ...(opts.withClaudeFallback ? [{ model: claude2, meta: { ...CLAUDE_META, providerName: "kilo", model: opts.fallbackModel ?? "anthropic/claude-sonnet-5.5" }, llmCallRecorder: recorderFor("anthropic", opts.fallbackModel ?? "anthropic/claude-sonnet-5.5") }] : []),
        ...(opts.withSameModelFallback ? [{ model: claudeLow, meta: { ...CLAUDE_META, reasoningEffort: "low" as const }, llmCallRecorder: recorderFor("anthropic", CLAUDE_META.model) }] : [])
      ]
    }),
    sse: { emit: () => {} },
    buildToolScope: SCOPE,
    cacheSeal: sealer,
    ...(opts.beforeModelCall ? { beforeModelCallHook: async () => { await opts.beforeModelCall!(); } } : {}),
    ...(opts.subagent ? { stepRecordingForThread: () => ({ purpose: "subagent_step", metadata: {} }) } : {})
  });
  // As the runtime asks for it: a reply whose tools still run is kept whole.
  box.stepPromptFor = (threadId) => scheduler.stepPromptFor(threadId, { pendingResults: true });
  const ask = (text: string) => agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text } });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const fireTimers = async () => { for (const timer of timers.splice(0)) timer.fn(); await settle(); };
  const purposes = () => (store.db.prepare("select purpose, model, metadata_json from llm_calls order by created_at, id").all() as Array<{ purpose: string; model: string; metadata_json: string | null }>);
  const askWithImage = (text: string) => agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text, attachments: [{ type: "image", id: "img-notes", name: "notes.png", mediaType: "image/png", data: "iVBORw0KGgo=", sizeBytes: 8 }] }
  });
  const fireIdle = async () => { for (const timer of idleTimers.splice(0)) timer.fn(); await settle(); };
  return { idleTimers, compacted, fireIdle, store, agentStore, thread, claude, gpt, claude2, claudeLow, askWithImage, ledger, sealer, timers, wakeAndWait, ask, settle, fireTimers, purposes };
}

test("a participating first candidate's step marks its messages for five minutes; the system stays an hour", async () => {
  const s = setup();
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  const prompt = s.claude.calls[0]!.options.prompt as Prompt;
  expect(prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  expect(marksOf(prompt)).toEqual([HOUR, FIVE, null, FIVE]);
  const step = s.purposes().find((r) => r.purpose === "agent_wake_step")!;
  expect(JSON.parse(step.metadata_json!).cacheTtl).toBe("5m");
});

test("switched off, paused, or a fallback: hour-long marks as today", async () => {
  for (const variant of ["off", "paused"] as const) {
    const s = setup({ enabled: () => variant !== "off" });
    if (variant === "paused") s.ledger.layer1(s.ledger.startSeal("provider-1", CLAUDE_META.model)!, "short_write");
    await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
    expect(marksOf(s.claude.calls[0]!.options.prompt as Prompt)).toEqual([HOUR, HOUR, null, HOUR]);
    expect(JSON.parse(s.purposes().find((r) => r.purpose === "agent_wake_step")!.metadata_json!).cacheTtl).toBe("1h");
  }
});

// A fallback answers only when the leader fails, rarely twice in a row; an
// hour-long write there is paid for and never read.
test("a Claude fallback writes its messages for five minutes and is never sealed", async () => {
  const s = setup({ withClaudeFallback: true, claudeScript: [{ error: "The operation timed out." }] });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(marksOf(s.claude2.calls[0]!.options.prompt as Prompt)).toEqual([HOUR, FIVE, null, FIVE]);
  expect(s.timers).toHaveLength(0);
  // Each attempt's row says what its own marks asked for.
  const ttlOf = (model: string) => JSON.parse(s.purposes().find((r) => r.model === model)!.metadata_json!).cacheTtl;
  expect([ttlOf(CLAUDE_META.model), ttlOf("anthropic/claude-sonnet-5.5")]).toEqual(["5m", "5m"]);
});

test("switched off, a Claude fallback writes for an hour as before sealing", async () => {
  const s = setup({ enabled: () => false, withClaudeFallback: true, claudeScript: [{ error: "The operation timed out." }] });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  expect(marksOf(s.claude2.calls[0]!.options.prompt as Prompt)).toEqual([HOUR, HOUR, null, HOUR]);
});

// The call says which candidate answered: a fallback of the same model on the
// same connection at another effort is not taken for the leader.
test("a fallback of the same model at another effort that answers is not sealed for the leader", async () => {
  const s = setup({ withSameModelFallback: true, claudeScript: [{ error: "The operation timed out." }] });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(s.claudeLow.calls).toHaveLength(1);
  expect(s.timers).toHaveLength(0);
});

// The primary takes no images: the Claude after it leads every step of the
// thread, not now and then, so it is sealed as the leader.
test("a Claude model that leads because the primary takes no images is sealed", async () => {
  const s = setup({ withClaudeFallback: true, primaryTakesNoImages: true });
  await s.wakeAndWait(s.thread.id, "user", s.askWithImage("What do these notes say?").id);
  await s.settle();
  expect(s.claude.calls).toHaveLength(0);
  expect(marksOf(s.claude2.calls[0]!.options.prompt as Prompt)).toEqual([HOUR, FIVE, null, FIVE]);
  expect(s.timers).toHaveLength(1);
  await s.fireTimers();
  expect(s.claude2.calls).toHaveLength(2);
  expect(s.claude2.calls[1]!.options.maxOutputTokens).toBe(1);
});

test("a fallback of another family records no cache lifetime", async () => {
  const s = setup({ withGpt: true, claudeScript: [{ error: "The operation timed out." }] });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  const gptRow = s.purposes().find((r) => r.model === GPT_META.model)!;
  expect("cacheTtl" in JSON.parse(gptRow.metadata_json!)).toBe(false);
});

test("the fallback served the step: no seal is sent", async () => {
  const s = setup({ withGpt: true, claudeScript: [{ error: "The operation timed out." }] });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  await s.fireTimers();
  expect(s.claude.calls).toHaveLength(1);
  expect(s.timers).toHaveLength(0);
});

test("a quiet thread gets one seal: the step's prompt and reply, an hour-long mark, one output token, recorded as agent_cache_seal", async () => {
  const s = setup();
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(s.timers).toHaveLength(1);
  expect(s.timers[0]!.ms).toBeGreaterThan(260_000);
  expect(s.timers[0]!.ms).toBeLessThanOrEqual(270_000);
  const messagesBefore = s.agentStore.getMessages(s.thread.id).length;
  await s.fireTimers();
  expect(s.claude.calls).toHaveLength(2);
  const seal = s.claude.calls[1]!.options;
  expect(seal.maxOutputTokens).toBe(1);
  const prompt = seal.prompt as Prompt;
  expect(prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
  expect(marksOf(prompt)).toEqual([HOUR, null, null, null, HOUR, null]);
  expect(prompt.at(-1)!.content).toEqual([{ type: "text", text: "." }]);
  expect(s.purposes().map((r) => r.purpose)).toEqual(["agent_wake_step", "agent_cache_seal"]);
  expect(JSON.parse(s.purposes()[1]!.metadata_json!)).toMatchObject({ cacheTtl: "1h", threadScope: "manager" });
  expect(s.agentStore.getMessages(s.thread.id)).toHaveLength(messagesBefore);
});

test("a new message before the seal is due starts the next step and no seal is sent", async () => {
  const s = setup({ claudeScript: [{ text: "Here is the draft.", finishReason: "stop" }, { text: "Added the date.", finishReason: "stop" }] });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(s.timers).toHaveLength(1);
  await s.wakeAndWait(s.thread.id, "user", s.ask("Also add the date").id);
  await s.settle();
  expect(s.claude.calls.map((c) => c.options.maxOutputTokens ?? null)).not.toContain(1);
  expect(s.timers).toHaveLength(1);
});

// A pause while a tool still runs: the reply is sealed whole, its call
// answered by a placeholder, so the next step (with the real result) reads it.
test("a seal while the step's tool still runs keeps the reply whole, and the next step reads it", async () => {
  let release!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; });
  const dispatcher: ToolDispatcher = {
    registry: { tools: { read: tool({ description: "Reads a file.", inputSchema: z.object({ path: z.string() }) }) } },
    dispatch: async () => { await running; return { result: "the notes" }; }
  };
  const s = setup({
    dispatcher,
    claudeScript: [
      { text: "Reading the notes.", toolCalls: [{ toolCallId: "c1", toolName: "read", args: { path: "notes.md" } }], finishReason: "tool-calls" },
      // The seal: one output token, as the provider answers it.
      { text: ".", finishReason: "length", usage: { promptTokens: 200, completionTokens: 1 } },
      { text: "Done.", finishReason: "stop" }
    ]
  });
  const wake = s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  for (let i = 0; i < 50 && s.timers.length === 0; i++) await s.settle();
  await s.fireTimers();
  const seal = s.claude.calls[1]!.options.prompt as Prompt;
  const reply = seal.at(-2)!;
  expect(reply.role).toBe("assistant");
  expect((reply.content as Array<{ type: string }>).map((p) => p.type)).toContain("tool-call");
  expect(marksOf(seal).at(-2)).toEqual(HOUR);
  expect(seal.at(-1)!.role).toBe("tool");
  release();
  await wake;
  await s.settle();
  expect(s.claude.calls).toHaveLength(3);
  expect(s.ledger.pauses()).toEqual([]);
});

test("a subagent's steps keep hour-long marks and are never sealed", async () => {
  const s = setup({ subagent: true });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(marksOf(s.claude.calls[0]!.options.prompt as Prompt)).toEqual([HOUR, HOUR, null, HOUR]);
  expect(s.timers).toHaveLength(0);
});

// A turn that ends without an answer — the step failed, or the model was cut
// off at the output limit for the last time — sent its prompt with
// five-minute marks; the quiet thread is sealed.
test("a step that failed still seals its quiet thread", async () => {
  const s = setup({ claudeScript: [{ error: new Error("Bad request: the request was refused") }, { text: ".", finishReason: "length" }] });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(s.timers).toHaveLength(1);
  await s.fireTimers();
  expect(s.claude.calls).toHaveLength(2);
  expect(s.claude.calls[1]!.options.maxOutputTokens).toBe(1);
  expect(s.purposes().map((r) => r.purpose)).toEqual(["agent_wake_step", "agent_cache_seal"]);
});

test("a turn ended by a reply cut off at the output limit is sealed", async () => {
  const cut = { text: "The notes so far", finishReason: "length" as const };
  const s = setup({ claudeScript: [cut, cut, cut, { text: ".", finishReason: "length" }] });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(s.claude.calls).toHaveLength(3);
  expect(s.timers).toHaveLength(1);
  await s.fireTimers();
  expect(s.claude.calls).toHaveLength(4);
  expect(s.claude.calls[3]!.options.maxOutputTokens).toBe(1);
});

// What a step's marks asked for is fixed when its messages are built:
// switched on while its request was out, a failed step that sent hour-long
// marks is not sealed.
test("a failed step is judged by the marks it sent, not the switch as it is after", async () => {
  const box = { on: false };
  const s = setup({ enabled: () => box.on, claudeScript: [{ error: new Error("Bad request: the request was refused") }] });
  const doStream = s.claude.doStream.bind(s.claude);
  s.claude.doStream = async (options) => { box.on = true; return doStream(options); };
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(marksOf(s.claude.calls[0]!.options.prompt as Prompt)).toEqual([HOUR, HOUR, null, HOUR]);
  expect(JSON.parse(s.purposes()[0]!.metadata_json!).cacheTtl).toBe("1h");
  expect(s.timers).toHaveLength(0);
});

// The step drops a waiting seal before its work before the call (context,
// hooks, images), not just before the call: one due in that work never goes
// out beside the call.
test("a seal due during the work before a step's call is not sent beside it", async () => {
  const box: { during?: () => Promise<void> } = {};
  const s = setup({
    claudeScript: [{ text: "Here is the draft.", finishReason: "stop" }, { text: "Added the date.", finishReason: "stop" }, { text: ".", finishReason: "length" }],
    beforeModelCall: () => box.during?.()
  });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(s.timers).toHaveLength(1);
  box.during = () => s.fireTimers();
  await s.wakeAndWait(s.thread.id, "user", s.ask("Also add the date").id);
  await s.settle();
  expect(s.claude.calls.map((c) => c.options.maxOutputTokens ?? null)).not.toContain(1);
});

// Dropped at the step's start, a waiting seal goes back when the work before
// the call fails: no call followed, so nothing else keeps the cache.
test("a step whose work before its call fails puts the waiting seal back", async () => {
  const box = { fail: false };
  const s = setup({ beforeModelCall: () => { if (box.fail) throw new Error("the runtime context could not be built"); } });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(s.timers).toHaveLength(1);
  box.fail = true;
  await s.wakeAndWait(s.thread.id, "user", s.ask("Also add the date").id);
  await s.settle();
  expect(s.claude.calls).toHaveLength(1);
  expect(s.timers).toHaveLength(1);
  await s.fireTimers();
  expect(s.claude.calls).toHaveLength(2);
  expect(s.claude.calls[1]!.options.maxOutputTokens).toBe(1);
});

// Leading, a Claude that takes no part in sealing (a fixed thinking budget)
// answers every step: it keeps hour-long marks, as before sealing.
test("a Claude model that leads but cannot be sealed keeps hour-long marks", async () => {
  const s = setup({ withClaudeFallback: true, primaryTakesNoImages: true, fallbackModel: "anthropic/claude-sonnet-4-5" });
  await s.wakeAndWait(s.thread.id, "user", s.askWithImage("What do these notes say?").id);
  await s.settle();
  expect(marksOf(s.claude2.calls[0]!.options.prompt as Prompt)).toEqual([HOUR, HOUR, null, HOUR]);
  expect(s.timers).toHaveLength(0);
});

// Idle compaction, end to end: the seal wrote for an hour, so the idle clock
// asks for a compaction 55 minutes after the seal started, on the warm model.
test("a quiet Claude thread is compacted 55 minutes after its seal", async () => {
  const s = setup({
    withIdle: true,
    claudeScript: [
      { text: "Here is the draft.", finishReason: "stop" },
      {
        text: ".", finishReason: "length", usage: { promptTokens: 240, completionTokens: 1, cacheReadTokens: 180, cacheWriteTokens: 53 },
        providerMetadata: { anthropic: { usage: { cache_creation: { ephemeral_1h_input_tokens: 53, ephemeral_5m_input_tokens: 0 } } } }
      }
    ]
  });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  await s.fireTimers();
  expect(s.claude.calls).toHaveLength(2);
  expect(s.idleTimers.map((t) => Math.round(t.ms / 60_000))).toEqual([55]);
  await s.fireIdle();
  expect(s.compacted).toHaveLength(1);
  expect(s.compacted[0]!.opts.idleMinutes).toBe(55);
  expect(s.compacted[0]!.opts.only({ model: s.claude, meta: CLAUDE_META })).toBe(true);
  expect(s.compacted[0]!.opts.only({ model: s.claude, meta: { ...CLAUDE_META, reasoningEffort: "low" } })).toBe(false);
});

// Sealing off, a Claude step writes for an hour itself: its own hour-long
// write arms the idle clock, 55 minutes after the step's call started.
test("with sealing off, a Claude step that wrote for an hour arms the idle clock", async () => {
  const s = setup({
    withIdle: true,
    enabled: () => false,
    claudeScript: [{
      text: "Here is the draft.", finishReason: "stop", usage: { promptTokens: 240, completionTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 240 },
      providerMetadata: { anthropic: { usage: { cache_creation: { ephemeral_1h_input_tokens: 240, ephemeral_5m_input_tokens: 0 } } } }
    }]
  });
  await s.wakeAndWait(s.thread.id, "user", s.ask("Go on").id);
  await s.settle();
  expect(s.timers).toHaveLength(0);
  expect(s.idleTimers.map((t) => Math.round(t.ms / 60_000))).toEqual([55]);
});
