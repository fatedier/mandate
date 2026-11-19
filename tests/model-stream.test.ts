import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { candidateCallOptions, WakeLlmAttempts, type WakeLlmCandidate } from "../src/server/modules/agent/wake-llm-attempts.js";
import { openAttemptStreamState, streamModelOnce } from "../src/server/modules/agent/model-stream.js";
import { createAiSdkLanguageModel } from "../src/server/modules/llm/ai-sdk-model-factory.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { sseFrame } from "./helpers/sse.js";

// A wake step's model stream is one function, called the same way wherever it
// runs: what it returns is what the attempt runner returns for the same
// candidate, and the page hears the same reasoning and headings.

const THREAD = "thr_stream";
const WAKE = "wake_stream";
const messages: ModelMessage[] = [{ role: "user", content: "Draft the release notes" }];

function attempts(events: Array<{ name: string; data: unknown }> = []) {
  return new WakeLlmAttempts({
    sse: { emit: (name, data) => events.push({ name, data }) },
    llmTimeout: () => ({}),
    streamIdleTimeoutMs: () => 120_000
  });
}

async function viaAttempts(candidate: WakeLlmCandidate) {
  return attempts().run({
    candidates: [candidate], threadId: THREAD, wakeId: WAKE, requestPayload: {}, purpose: "agent_wake_step",
    metadata: {}, callId: null, streamArgs: { system: "You are terse.", messages },
    signal: new AbortController().signal, onAttemptFailed: () => {}
  });
}

async function viaFunction(candidate: WakeLlmCandidate, askSummary = false) {
  const seen = { reasoning: 0, headings: [] as string[], deltas: [] as Array<[string, string]> };
  const state = openAttemptStreamState({
    model: candidate.model, timeout: {}, idleMs: 120_000,
    diagnostics: { startedAt: Date.now(), callId: null, wakeId: WAKE, candidateIndex: 0, attempt: 1, idleTimeoutMs: 120_000 }
  });
  try {
    const { model, ...callOptions } = candidateCallOptions(candidate, THREAD, { askSummary });
    const output = await streamModelOnce(
      { model, system: "You are terse.", messages, callOptions, askSummary },
      state,
      {
        onReasoning: () => { seen.reasoning += 1; },
        onHeading: (heading) => { seen.headings.push(heading); },
        onTextDelta: (delta, total) => { seen.deltas.push([delta, total]); }
      }
    );
    return { output, seen };
  } finally {
    state.idle.cleanup();
  }
}

const reply = () => [{ text: "Notes drafted.", reasoning: ["**Reading the diff**\n\nLooked at the changes.", "**Writing**\n\nPut them in order."], finishReason: "stop" as const }];

test("one stream returns what the attempt runner returns for the same candidate", async () => {
  const runner = await viaAttempts({ model: createMockLLM(reply(), { provider: "anthropic.messages", modelId: "claude-x" }), meta: { provider: "anthropic", model: "claude-x" } });
  const { output } = await viaFunction({ model: createMockLLM(reply(), { provider: "anthropic.messages", modelId: "claude-x" }), meta: { provider: "anthropic", model: "claude-x" } });
  const { sdkAssistantMessages, answeredBy: _a, writtenBy: _w, ...collected } = runner;
  // Clock readings differ between two runs; everything else is the same.
  const untimed = (c: typeof collected) => ({ ...c, firstOutputMs: null, ...(c.reasoning ? { reasoning: { ...c.reasoning, ms: 0 } } : {}) });
  expect(untimed(output.collected)).toEqual(untimed(collected));
  expect(output.collected.reasoning?.text).toBeTruthy();
  expect(output.sdkAssistantMessages).toEqual(sdkAssistantMessages ?? []);
  expect(output.summaryInBody).toBeUndefined();
});

test("reasoning is heard once, at its first delta, even with no heading; a heading only when it changes", async () => {
  const plain = await viaFunction({ model: createMockLLM([{ text: "ok", reasoning: ["thinking it over", "and a bit more"], finishReason: "stop" }]), meta: {} });
  expect([plain.seen.reasoning, plain.seen.headings]).toEqual([1, []]);
  const titled = await viaFunction({ model: createMockLLM([{ text: "ok", reasoning: ["**Plan**\n\nfirst", "**Plan**\n\nsecond", "**Write**\n\nthird"], finishReason: "stop" }]), meta: {} });
  expect([titled.seen.reasoning, titled.seen.headings]).toEqual([1, ["Plan", "Write"]]);
  expect(titled.seen.deltas.at(-1)).toEqual(["ok", "ok"]);
});

test("a stream that asked for the summary says whether its request carried it", async () => {
  const bodies: unknown[] = [];
  const events = [
    { type: "response.created", response: { id: "resp_1", created_at: 0, model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] } },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }
  ];
  const model = createAiSdkLanguageModel({
    provider: "openai-compatible", model: "gpt-5.5", apiKey: "k", baseURL: "https://gateway.example/v1",
    fetch: (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(events.map((e) => sseFrame({ data: e })).join(""), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch
  })!;
  const candidate: WakeLlmCandidate = { model, meta: { provider: "openai-compatible", model: "gpt-5.5", reasoningEffort: "high", supportsReasoning: true } };
  expect((await viaFunction(candidate, true)).output.summaryInBody).toBe(true);
  expect((await viaFunction(candidate, false)).output.summaryInBody).toBeUndefined();
  expect(bodies).toHaveLength(2);
});
