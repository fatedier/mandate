import { expect, jest, test } from "bun:test";
import { DEFAULT_TEXT_MODEL_LLM_TIMEOUT, LLM_STREAM_IDLE_TIMEOUT_MS } from "../src/server/modules/llm/timeouts.js";
import { runAgentCompressionLlm, runAgentCompressionOnStepPrompt } from "../src/server/runtime/agent-compression-llm.js";
import { callTextModelForProvider } from "../src/server/modules/llm/text-model.js";
import { extractFromWindow } from "../src/server/modules/memory/extraction.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import type { WakeLlmCandidate } from "../src/server/modules/agent/wake-llm-attempts.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { fakeClock, realClock } from "./helpers/fake-clock.js";
import { pacedModel } from "./helpers/paced-model.js";
import { onCleanup } from "./helpers/cleanup.js";
import { stub } from "./helpers/typed.js";

// Every model call gives up on a stream gone quiet for 2 minutes, one logic
// for all: memory extraction and a compaction's summary, which before had
// only their 8 minutes in all, as an agent's step and a dream step. Any part,
// or a provider delta the SDK holds back, starts the window over.

const history = [{ role: "user" as const, content: "Summarize the 3.22 release notes thread." }];
/** What is waiting on promises run (a call reaches its model's stream), then
 *  the fake clock moved on and what that let run, run. */
async function moveOn(ms: number) {
  for (let i = 0; i < 100; i++) await Promise.resolve();
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
const compaction = (model: unknown, streamIdleTimeoutMs?: number) =>
  runAgentCompressionLlm({ model: model as never, provider: "openai-compatible", system: "Summarize.", messages: history, ...(streamIdleTimeoutMs ? { streamIdleTimeoutMs } : {}) });

test("every model call's window is 2 minutes; the SDK's chunk timers match it", () => {
  expect(LLM_STREAM_IDLE_TIMEOUT_MS).toBe(120_000);
  expect(DEFAULT_TEXT_MODEL_LLM_TIMEOUT).toEqual({ totalMs: 8 * 60_000, chunkMs: LLM_STREAM_IDLE_TIMEOUT_MS });
});

test("a compaction summary whose stream goes quiet past the window is cut", async () => {
  await expect(compaction(pacedModel({ gaps: [400], text: "the gist" }), 100)).rejects.toThrow(/activity/);
});

test("a compaction summary whose parts keep coming outlives the window", async () => {
  const result = await compaction(pacedModel({ gaps: [40, 40, 40, 40, 40, 40], text: "the gist" }), 100);
  expect(result.text).toBe("the gist");
});

test("a compaction on the step's prompt, on the Open Responses package, lives on the provider's deltas the SDK holds back", async () => {
  const model = pacedModel({ gaps: Array.from({ length: 10 }, () => 30), text: "the gist", as: "raw", openResponses: true });
  const candidate: WakeLlmCandidate = { model: model as never, meta: { provider: "openai-compatible", providerName: "provider-1", model: "deepseek/deepseek-v4-flash" } };
  const result = await runAgentCompressionOnStepPrompt({ candidate, threadId: "thr_a", prompt: { tools: {}, system: "Summarize." }, messages: history, llmTimeout: { totalMs: 5_000, chunkMs: 50 }, streamIdleTimeoutMs: 200 });
  expect(result.text).toBe("the gist");
});

test("by default a quiet compaction stream is cut at 2 minutes, not before", async () => {
  fakeClock();
  const model = pacedModel({ gaps: [Infinity], text: "the gist" });
  const call = compaction(model).then(() => "resolved", () => "rejected");
  await moveOn(LLM_STREAM_IDLE_TIMEOUT_MS - 1);
  expect(model.seen.aborted).toBe(false);
  await moveOn(1);
  expect(model.seen.aborted).toBe(true);
  realClock();
  expect(await call).toBe("rejected");
});

// Memory extraction: a model that stalls hands the window to the next, as
// any failure does.
const said = (text: string) => stub<AgentMessage>({ id: "m_1", threadId: "thr_1", role: "user", source: "user", seq: 1, createdAt: "2026-10-29T00:00:00.000Z", content: { type: "text", text } });
function extraction(models: unknown[], streamIdleTimeoutMs?: number) {
  const env = freshStoresEnv("md-extract-idle-");
  onCleanup(() => env.cleanup());
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  return extractFromWindow({
    memory, records: new FeatureRecordStore(env.store.db),
    candidates: models.map((model) => ({ model: model as never, provider: "openai-compatible", supportsReasoning: undefined })),
    repeatCheck: [], trigger: "compression", threadId: "thr_1",
    messages: [said("From now on project-1 commit messages are written in English")],
    projects: [], worker: null, budgetTokens: 50_000,
    ...(streamIdleTimeoutMs ? { streamIdleTimeoutMs } : {})
  });
}
const nothingToKeep = JSON.stringify({ entries: [] });

test("an extraction whose stream goes quiet past the window is cut, and the next model reads the window", async () => {
  const stalled = pacedModel({ gaps: [400], text: nothingToKeep });
  const next = pacedModel({ gaps: [], text: nothingToKeep });
  expect(await extraction([stalled, next], 100)).toMatchObject({ processed: true });
  expect([stalled.calls.length, next.calls.length]).toEqual([1, 1]);
});

test("an extraction whose parts keep coming outlives the window", async () => {
  const steady = pacedModel({ gaps: [40, 40, 40, 40, 40, 40], text: nothingToKeep });
  const next = pacedModel({ gaps: [], text: nothingToKeep });
  expect(await extraction([steady, next], 100)).toMatchObject({ processed: true });
  expect([steady.calls.length, next.calls.length]).toEqual([1, 0]);
});

test("an extraction on the Open Responses package lives on the provider's deltas the SDK holds back", async () => {
  const steady = pacedModel({ gaps: Array.from({ length: 10 }, () => 30), text: nothingToKeep, as: "raw", openResponses: true });
  const next = pacedModel({ gaps: [], text: nothingToKeep });
  expect(await extraction([steady, next], 200)).toMatchObject({ processed: true });
  expect([steady.calls.length, next.calls.length]).toEqual([1, 0]);
});

test("by default a quiet extraction stream is cut at 2 minutes, not before", async () => {
  fakeClock();
  const stalled = pacedModel({ gaps: [Infinity], text: nothingToKeep });
  const next = pacedModel({ gaps: [], text: nothingToKeep });
  const call = extraction([stalled, next]);
  await moveOn(LLM_STREAM_IDLE_TIMEOUT_MS - 1);
  expect(stalled.seen.aborted).toBe(false);
  await moveOn(1);
  expect(stalled.seen.aborted).toBe(true);
  // The next model reads the window on the same clock: going back to the
  // real one would fire its pending timers and cut it too.
  let out: unknown = "pending";
  void call.then((result) => { out = result; }, (error) => { out = error; });
  for (let i = 0; i < 50 && out === "pending"; i++) await moveOn(0);
  expect(out).toMatchObject({ processed: true });
  expect(next.calls.length).toBe(1);
});

// The guard is cleaned up on every path, a call the SDK refuses before it
// streams included. The SDK leaves a timer of its own after any call, so each
// is counted against the same call made without the guard.
async function timersLeftBy(call: () => Promise<unknown>): Promise<number> {
  jest.clearAllTimers();
  await call().catch(() => {});
  for (let i = 0; i < 5; i++) await moveOn(0);
  return jest.getTimerCount();
}

test("a call the SDK refuses before it streams leaves no idle timer behind", async () => {
  fakeClock();
  const parent = new AbortController();
  const refused = (opts: { streamIdleTimeoutMs?: number }) => () => callTextModelForProvider("openai-compatible", {
    model: pacedModel({ gaps: [], text: "the gist" }) as never, messages: history, maxOutputTokens: 0, abortSignal: parent.signal
  }, undefined, opts);
  const sdkOwn = await timersLeftBy(refused({}));
  expect(await timersLeftBy(refused({ streamIdleTimeoutMs: 1_000 }))).toBe(sdkOwn);
});

test("a compaction cut for going quiet leaves no idle timer behind", async () => {
  fakeClock();
  const sdkOwn = await timersLeftBy(() => compaction(pacedModel({ gaps: [], text: "the gist" }), 1_000));
  jest.clearAllTimers();
  let out = "pending";
  void compaction(pacedModel({ gaps: [Infinity], text: "the gist" }), 1_000).then(() => { out = "resolved"; }, () => { out = "rejected"; });
  for (let i = 0; i < 50 && out === "pending"; i++) await moveOn(500);
  expect(out).toBe("rejected");
  for (let i = 0; i < 5; i++) await moveOn(0);
  expect(jest.getTimerCount()).toBe(sdkOwn);
});
