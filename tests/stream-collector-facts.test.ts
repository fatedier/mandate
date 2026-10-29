import { expect, test } from "bun:test";
import { collectStream } from "../src/server/modules/agent/stream-collector.js";

async function* iter(parts: unknown[]): AsyncIterable<unknown> {
  for (const p of parts) yield p;
}

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
