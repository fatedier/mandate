import { expect, setSystemTime, test } from "bun:test";
import { collectStream } from "../src/server/modules/agent/stream-collector.js";
import { onCleanup } from "./helpers/cleanup.js";

async function* iter(parts: any[]): AsyncIterable<any> {
  for (const p of parts) yield p;
}

test("collectStream: concatenates text-deltas and emits onTextDelta", async () => {
  const deltas: Array<{ delta: string; total: string }> = [];
  const r = await collectStream(
    iter([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", usage: { inputTokens: 5, outputTokens: 2 } }
    ]),
    { onTextDelta: (delta, total) => deltas.push({ delta, total }) }
  );
  expect(r.text).toBe("Hello");
  expect(deltas).toStrictEqual([
    { delta: "Hel", total: "Hel" },
    { delta: "lo", total: "Hello" }
  ]);
  expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
});

test("collectStream: collects tool calls with input mapped to args", async () => {
  const r = await collectStream(iter([
    { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } },
    { type: "tool-call", toolCallId: "c2", toolName: "read", input: { path: "/x" } },
    { type: "finish", usage: { inputTokens: 0, outputTokens: 0 } }
  ]));
  expect(r.toolCalls).toEqual([
    { toolCallId: "c1", toolName: "bash", args: { cmd: "ls" } },
    { toolCallId: "c2", toolName: "read", args: { path: "/x" } }
  ]);
});

test("collectStream: keeps the reasoning summary, a paragraph per part, and how long it took; never the encrypted state", async () => {
  const totals: string[] = [];
  const meta = (encrypted: string) => ({ openai: { itemId: "rs_1", reasoningEncryptedContent: encrypted } });
  const r = await collectStream(iter([
    { type: "reasoning-start", id: "rs_1:0", providerMetadata: meta("encrypted-v1") },
    { type: "reasoning-delta", id: "rs_1:0", text: "**Gathering**\n\n" },
    { type: "reasoning-delta", id: "rs_1:0", text: "I need what merged." },
    { type: "reasoning-end", id: "rs_1:0", providerMetadata: meta("encrypted-v2") },
    { type: "reasoning-start", id: "rs_1:1", providerMetadata: meta("encrypted-v2") },
    { type: "reasoning-delta", id: "rs_1:1", delta: "**Checking**\n\nKeep the shape." },
    { type: "reasoning-end", id: "rs_1:1", providerMetadata: meta("encrypted-v3") },
    { type: "text-delta", text: "done" },
    { type: "finish", usage: { inputTokens: 3, outputTokens: 2 } }
  ]), { onReasoningHeading: (heading) => totals.push(heading ?? "") });

  expect(r.text).toBe("done");
  expect(r.reasoning?.text).toBe("**Gathering**\n\nI need what merged.\n\n**Checking**\n\nKeep the shape.");
  expect(r.reasoning?.ms).toBeGreaterThanOrEqual(0);
  expect(totals).toStrictEqual(["Gathering", "Gathering", "Checking"]);
  expect(JSON.stringify(r)).not.toContain("encrypted-v");
});

test("collectStream: interleaved summary parts each keep their own text, in the order they began", async () => {
  const r = await collectStream(iter([
    { type: "reasoning-start", id: "rs_1:0" },
    { type: "reasoning-start", id: "rs_1:1" },
    { type: "reasoning-delta", id: "rs_1:0", text: "**Check" },
    { type: "reasoning-delta", id: "rs_1:1", text: "**Plan" },
    { type: "reasoning-delta", id: "rs_1:0", text: "ing**" },
    { type: "reasoning-delta", id: "rs_1:1", text: "ning**" },
    { type: "reasoning-end", id: "rs_1:0" },
    { type: "reasoning-end", id: "rs_1:1" },
    { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } }
  ]));
  expect(r.reasoning?.text).toBe("**Checking**\n\n**Planning**");
});

test("collectStream: reasoning time ends with its last summary text, not a deferred reasoning-end", async () => {
  // The Codex provider holds reasoning-end back until the response completes.
  const start = Date.parse("2026-11-01T09:00:00.000Z");
  onCleanup(() => setSystemTime());
  async function* slow(): AsyncIterable<any> {
    setSystemTime(start);
    yield { type: "reasoning-start", id: "rs_1:0" };
    setSystemTime(start + 40);
    yield { type: "reasoning-delta", id: "rs_1:0", text: "**Checking**" };
    setSystemTime(start + 190);
    yield { type: "text-delta", text: "done" };
    yield { type: "reasoning-end", id: "rs_1:0" };
    yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } };
  }
  const r = await collectStream(slow());
  expect(r.reasoning?.ms).toBe(40);
});

test("collectStream: a step that did not reason has no reasoning", async () => {
  const r = await collectStream(iter([
    { type: "reasoning-start", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "x" } } },
    { type: "reasoning-end", id: "rs_1:0" },
    { type: "text-delta", text: "done" },
    { type: "finish", usage: { inputTokens: 3, outputTokens: 2 } }
  ]));
  expect("reasoning" in r).toBe(false);
});

test("collectStream: accepts both `text` (v6) and `delta` (provider) on text-delta", async () => {
  const r = await collectStream(iter([
    { type: "text-delta", delta: "fall" },
    { type: "text-delta", text: "back" },
    { type: "finish", usage: {} }
  ]));
  expect(r.text).toBe("fallback");
});

test("collectStream: prefers totalUsage over usage on finish", async () => {
  const r = await collectStream(iter([
    { type: "finish", totalUsage: { inputTokens: 100, outputTokens: 50 }, usage: { inputTokens: 7, outputTokens: 3 } }
  ]));
  expect(r.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
});

// Streams that fail the step, and what the rejection names.
const rejectedStreams: { name: string; parts: unknown[]; error: RegExp }[] = [
  { name: "throws on `error` events with the provider message", parts: [{ type: "error", error: { message: "rate limited" } }], error: /rate limited/ },
  {
    name: "formats nested provider error events",
    parts: [{
      type: "error",
      error: {
        type: "error",
        sequence_number: 2,
        error: {
          type: "service_unavailable_error",
          code: "server_is_overloaded",
          message: "Our servers are currently overloaded. Please try again later.",
          param: null
        }
      }
    }],
    error: /server_is_overloaded/
  },
  { name: "throws on abort events with the abort reason", parts: [{ type: "abort", reason: "The operation timed out." }], error: /timed out/ },
  { name: "rejects empty streams that end without finish", parts: [{ type: "start" }, { type: "text-start" }], error: /without a finish event or content/ }
];

test.each(rejectedStreams)("collectStream: $name", async ({ parts, error }) => {
  await expect(collectStream(iter(parts))).rejects.toThrow(error);
});

test("collectStream: ignores unknown event types (start, text-start, text-end)", async () => {
  const r = await collectStream(iter([
    { type: "start" },
    { type: "text-start" },
    { type: "text-delta", text: "x" },
    { type: "text-end" },
    { type: "reasoning-delta", delta: "thinking..." },
    { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } }
  ]));
  expect(r.text).toBe("x");
  expect(r.usage).toEqual({ promptTokens: 1, completionTokens: 1 });
});

test("collectStream: defaults to zero usage when finish has no usage shape", async () => {
  const r = await collectStream(iter([{ type: "text-delta", text: "ok" }]));
  expect(r.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
});

// A gateway can end a step with the provider's error in band:
// kilo sends OpenAI's cyber_policy refusal inside a chat chunk that still
// carries `choices`, which the AI SDK parses as an ordinary chunk, dropping
// `error`, and the step looked like an empty reply that ended the turn.
const CYBER = {
  code: "cyber_policy",
  message: "This request has been flagged for potentially high-risk cyber activity. Learn more here: https://platform.openai.com/docs/guides/safety-checks/cybersecurity",
  type: "invalid_request",
  statusCode: 400,
  isRetryable: false
};

test("collectStream: a chat chunk carrying the provider's error beside its choices fails the step with that error", async () => {
  const failed = collectStream(iter([
    { type: "start" },
    { type: "raw", rawValue: { id: "gen_1", object: "chat.completion.chunk", error: CYBER, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] } },
    { type: "text-start", id: "t" },
    { type: "text-end", id: "t" },
    { type: "finish-step", finishReason: "other", rawFinishReason: "error" },
    { type: "finish", totalUsage: { inputTokenDetails: {}, outputTokenDetails: {} } }
  ]));
  await expect(failed).rejects.toThrow("This request has been flagged for potentially high-risk cyber activity");
  await expect(failed).rejects.toMatchObject({ code: "cyber_policy" });
});

test("collectStream: a raw chunk that is only an error is left to the error part the SDK raises for it", async () => {
  // A Responses-API gateway's bare error chunk: the SDK cannot parse it and
  // raises its own error part, which keeps its message shape.
  const r = await collectStream(iter([
    { type: "raw", rawValue: { error: { message: "litellm.APIError: Response API in-stream error", code: "500" } } },
    { type: "text-delta", text: "ok" },
    { type: "finish", totalUsage: { inputTokens: 5, outputTokens: 1 } }
  ]));
  expect(r.text).toBe("ok");
});

test("collectStream: a step the provider finished with an error fails, even without the error itself", async () => {
  await expect(collectStream(iter([
    { type: "finish-step", finishReason: "other", rawFinishReason: "error" },
    { type: "finish", totalUsage: { inputTokens: 5, outputTokens: 0 } }
  ]))).rejects.toThrow("The provider ended the response with an error");
});

test("collectStream: a step with no output and no usage did not complete; an empty reply the provider completed stays a reply", async () => {
  await expect(collectStream(iter([
    { type: "start" },
    { type: "text-start", id: "t" },
    { type: "text-end", id: "t" },
    { type: "finish-step", finishReason: "other" },
    { type: "finish", totalUsage: { inputTokenDetails: {}, outputTokenDetails: {} } }
  ]))).rejects.toThrow("The response ended before the provider finished it");
  const r = await collectStream(iter([
    { type: "finish-step", finishReason: "stop", rawFinishReason: "stop" },
    { type: "finish", totalUsage: { inputTokens: 85_000, outputTokens: 0 } }
  ]));
  expect(r).toMatchObject({ text: "", toolCalls: [] });
});

test("collectStream: raw chunks are read here and not passed on as parts", async () => {
  const seen: string[] = [];
  await collectStream(iter([
    { type: "raw", rawValue: { choices: [{ index: 0, delta: { content: "ok" } }] } },
    { type: "text-delta", text: "ok" },
    { type: "finish", totalUsage: { inputTokens: 5, outputTokens: 1 } }
  ]), { onPart: (part) => seen.push(part.type) });
  expect(seen).toStrictEqual(["text-delta", "finish"]);
});

// Google continues a long reply in further requests and sums their usage:
// what is billed is the sum, what the model read is the first prompt.
test("collectStream: a continued response keeps its first prompt as the context size", async () => {
  const finishStep = (providerMetadata?: unknown) => ({ type: "finish-step", finishReason: "length", ...(providerMetadata ? { providerMetadata } : {}) });
  const finish = { type: "finish", finishReason: "length", totalUsage: { inputTokens: 272_768, outputTokens: 10 } };
  const continued = await collectStream(iter([{ type: "text-delta", text: "long" }, finishStep({ google: { initialPromptTokenCount: 120_000 } }), finish]));
  expect(continued.usage).toMatchObject({ promptTokens: 272_768, contextPromptTokens: 120_000 });
  const plain = await collectStream(iter([{ type: "text-delta", text: "short" }, finishStep(), finish]));
  expect("contextPromptTokens" in plain.usage).toBe(false);
});

test("collectStream: times the first output from its start, past the SDK's own parts; a stream that fails carries what it saw", async () => {
  let now = 0;
  async function* timed(parts: Array<[number, any]>, fail?: Error): AsyncIterable<any> {
    for (const [at, part] of parts) {
      now = at;
      yield part;
    }
    if (fail) throw fail;
  }
  const done = await collectStream(timed([
    [0, { type: "start" }],
    [3, { type: "start-step" }],
    [1_200, { type: "text-delta", text: "Hi" }],
    [1_900, { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } }]
  ]), { now: () => now });
  expect(done.firstOutputMs).toBe(1_200);

  now = 0;
  const cut = await collectStream(timed([[0, { type: "start" }], [800, { type: "reasoning-delta", id: "r", text: "Reading." }]], new Error("dropped")), { now: () => now })
    .catch((error: unknown) => error as { firstOutputMs?: unknown });
  expect(cut.firstOutputMs).toBe(800);

  now = 0;
  const silent = await collectStream(timed([[0, { type: "start" }]], new Error("refused")), { now: () => now })
    .catch((error: unknown) => error as { firstOutputMs?: unknown });
  expect(silent.firstOutputMs).toBeNull();
});

test("collectStream: a long reasoning summary is read once, not again at every delta", async () => {
  const deltas = Array.from({ length: 30_000 }, (_, i) => ({ type: "reasoning-delta", id: "rs_1:0", text: i % 500 === 0 ? `\n\n**Step ${i}**\n\n` : "some words " }));
  const headings: Array<string | null> = [];
  const started = performance.now();
  await collectStream(iter([
    { type: "reasoning-start", id: "rs_1:0" },
    ...deltas,
    { type: "reasoning-end", id: "rs_1:0" },
    { type: "finish", usage: { inputTokens: 1, outputTokens: 1 } }
  ]), { onReasoningHeading: (heading) => { if (heading !== headings.at(-1)) headings.push(heading); } });
  expect(performance.now() - started).toBeLessThan(3000);
  expect(headings.at(-1)).toBe("Step 29500");
  expect(headings).toHaveLength(60);
}, 60_000);

const finish = { type: "finish", usage: { inputTokens: 10, outputTokens: 2 } };
const text = { type: "text-delta", text: "ok" };

test("anthropic 1-hour writes from message_start", async () => {
  const r = await collectStream(iter([
    { type: "raw", rawValue: { type: "message_start", message: { usage: { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 100 } } } } },
    text, finish
  ]));
  expect(r.facts).toMatchObject({ cacheWrite1h: 900 });
});

test("openai service tier from finish-step metadata", async () => {
  const r = await collectStream(iter([text, { type: "finish-step", finishReason: "stop", providerMetadata: { openai: { serviceTier: "flex" } }, response: { headers: {} } }, finish]));
  expect(r.facts).toMatchObject({ serviceTier: "flex" });
});

test("litellm header from finish-step response headers", async () => {
  const r = await collectStream(iter([text, { type: "finish-step", finishReason: "stop", response: { headers: { "x-litellm-response-cost": "0.0042" } } }, finish]));
  expect(r.facts).toMatchObject({ litellmHeader: "0.0042" });
});

test("cost from the raw final chat chunk", async () => {
  const r = await collectStream(iter([
    text,
    { type: "raw", rawValue: { id: "x", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.01, is_byok: true, cost_details: { upstream_inference_cost: 0.2 } } } },
    finish
  ]));
  expect(r.facts).toMatchObject({ usageCost: 0.01, isByok: true, upstreamCost: 0.2 });
});

test("cost from a Responses completed event", async () => {
  const r = await collectStream(iter([
    text,
    { type: "raw", rawValue: { type: "response.completed", response: { service_tier: "default", usage: { input_tokens: 10, output_tokens: 2, cost: 0.003 } } } },
    finish
  ]));
  expect(r.facts).toMatchObject({ usageCost: 0.003, serviceTier: "default" });
});

test("kilo marketCost string from message_delta", async () => {
  const r = await collectStream(iter([
    text,
    { type: "raw", rawValue: { type: "message_delta", provider_metadata: { gateway: { cost: "0", marketCost: "0.140985" } } } },
    finish
  ]));
  expect(r.facts).toMatchObject({ marketCost: 0.140985 });
});

test("a stream with nothing to note carries no facts", async () => {
  const r = await collectStream(iter([text, finish]));
  expect("facts" in r).toBe(false);
});

test("a failed stream keeps its facts and its usage so far", async () => {
  const err = (await collectStream(iter([
    { type: "raw", rawValue: { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } } } } },
    { type: "error", error: new Error("boom") }
  ])).catch((e: unknown) => e)) as Error & { usageSoFar?: unknown; facts?: unknown };
  expect(err).toBeInstanceOf(Error);
  expect(err.facts).toStrictEqual({ cacheWrite1h: 0, cacheWrite5m: 0 });
  expect(err.usageSoFar).toEqual({ inputTokens: 5010, inputTokenDetails: { cacheReadTokens: 5000, cacheWriteTokens: 0 } });
});

test("a failed chat stream after its usage chunk keeps that usage", async () => {
  const err = (await collectStream(iter([
    { type: "raw", rawValue: { id: "x", choices: [], usage: { prompt_tokens: 300, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 200 } } } },
    { type: "error", error: new Error("boom") }
  ])).catch((e: unknown) => e)) as Error & { usageSoFar?: unknown };
  expect(err.usageSoFar).toEqual({ inputTokens: 300, outputTokens: 20, inputTokenDetails: { cacheReadTokens: 200 } });
});

test("anthropic's message_delta updates the 1-hour writes before a late failure", async () => {
  const err = (await collectStream(iter([
    { type: "raw", rawValue: { type: "message_start", message: { usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 100 } } } } },
    { type: "raw", rawValue: { type: "message_delta", usage: { output_tokens: 7, cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 } } } },
    { type: "error", error: new Error("late") }
  ])).catch((e: unknown) => e)) as Error & { facts?: { cacheWrite1h?: number } };
  expect(err.facts!.cacheWrite1h).toBe(100);
});

test("an error that cannot take properties is rethrown as it was", async () => {
  const frozen = Object.freeze(new Error("frozen"));
  async function* failing(): AsyncIterable<unknown> {
    yield { type: "text-delta", text: "a" };
    throw frozen;
  }
  const caught = await collectStream(failing()).catch((e: unknown) => e);
  expect(caught).toBe(frozen);
});
