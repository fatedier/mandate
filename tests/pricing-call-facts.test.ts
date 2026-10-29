import { expect, test } from "bun:test";
import { CallFactsCollector, resolveCallFacts } from "../src/server/modules/pricing/call-facts.js";

test("openrouter byok adds the upstream cost", () => {
  expect(resolveCallFacts({ usageCost: 0.0032, isByok: true, upstreamCost: 0.0642 }, "openai-compatible"))
    .toMatchObject({ reportedMicros: 67_400, reportedField: "usage.cost+upstream_inference_cost" });
});

test("without byok the upstream cost is not added", () => {
  expect(resolveCallFacts({ usageCost: 0.01, upstreamCost: 0.0095 }, "openai-compatible").reportedMicros).toBe(10_000);
});

test("kilo takes the upstream cost", () => {
  expect(resolveCallFacts({ usageCost: 0.0032, upstreamCost: 0.0642 }, "kilo")).toMatchObject({ reportedMicros: 64_200, reportedField: "upstream_inference_cost" });
});

test("kilo takes marketCost when there is no upstream cost", () => {
  expect(resolveCallFacts({ marketCost: 0.140985 }, "kilo")).toMatchObject({ reportedMicros: 140_985, reportedField: "gateway.marketCost" });
});

test.each([
  ["", null],
  ["  ", null],
  ["0.0", 0],
  ["0.0042", 4_200],
  ["abc", null],
  ["-1", null]
])("litellm header %p", (header, micros) => {
  expect(resolveCallFacts({ litellmHeader: header }, "anthropic").reportedMicros).toBe(micros);
});

test("decisions cost", () => {
  expect(resolveCallFacts({ decisionsCost: 0.0003 }, "openai-compatible")).toMatchObject({ reportedMicros: 300, reportedField: "decisions.cost" });
});

test("nothing reported", () => {
  expect(resolveCallFacts({}, "openai")).toEqual({ reportedMicros: null, reportedField: null, cacheWrite1hTokens: null, cacheWrite5mTokens: null, serviceTier: null });
});

test("the collector reads a non-streaming result: metadata, headers, raw usage, a decisions cost", () => {
  const c = new CallFactsCollector();
  c.noteResult({
    providerMetadata: { openai: { serviceTier: "priority" }, anthropic: { usage: { cache_creation: { ephemeral_1h_input_tokens: 70, ephemeral_5m_input_tokens: 30 } } } },
    response: { headers: { "X-LiteLLM-Response-Cost": "0.0042" } },
    usage: { raw: { cost: 0.01, is_byok: false } }
  });
  expect(c.candidates()).toMatchObject({ serviceTier: "priority", cacheWrite1h: 70, cacheWrite5m: 30, litellmHeader: "0.0042", usageCost: 0.01, isByok: false });
});

test("an OpenRouter Decisions response's cost is read from its usage", () => {
  const d = new CallFactsCollector();
  d.noteResult({ answers: { done: { type: "boolean", value: true } }, model: "m", usage: { cost: 0.0003, inputTokens: 10, outputTokens: 1 } });
  expect(d.candidates()).toEqual({ decisionsCost: 0.0003 });
});

test("anthropic's service tier is read from its usage, raw or in provider metadata", () => {
  const raw = new CallFactsCollector();
  raw.noteRaw({ type: "message_start", message: { usage: { input_tokens: 1, service_tier: "priority" } } });
  expect(raw.candidates().serviceTier).toBe("priority");
  const meta = new CallFactsCollector();
  meta.noteFinishStep({ providerMetadata: { anthropic: { usage: { service_tier: "standard" } } } });
  expect(meta.candidates().serviceTier).toBe("standard");
});

test("Kilo at its own address is Kilo whatever the connection's type: its fee is never the spend", () => {
  for (const baseURL of ["https://api.kilo.ai/api/gateway", "https://api.kilo.ai/api/gateway/", "https://KILO.ai/v1"]) {
    expect(resolveCallFacts({ usageCost: 0.0032 }, "openai-compatible", baseURL).reportedMicros).toBeNull();
    expect(resolveCallFacts({ usageCost: 0.0032, upstreamCost: 0.0642 }, "openai-compatible", baseURL)).toMatchObject({ reportedMicros: 64_200, reportedField: "upstream_inference_cost" });
  }
  // A host that only ends in the same letters is someone else's.
  expect(resolveCallFacts({ usageCost: 0.0032 }, "openai-compatible", "https://notkilo.ai/v1").reportedMicros).toBe(3_200);
  expect(resolveCallFacts({ usageCost: 0.0032 }, "openai-compatible", null).reportedMicros).toBe(3_200);
});

test("a reported amount at a half micro-dollar rounds up, without float error", () => {
  expect(resolveCallFacts({ usageCost: 0.0001245 }, "openai-compatible").reportedMicros).toBe(125);
  expect(resolveCallFacts({ litellmHeader: "0.0002445" }, "openai-compatible").reportedMicros).toBe(245);
});

// Kilo reports what the upstream charged in every API's usage: Messages (in
// the message events or the provider metadata), Responses (the completed
// response), Chat (the final chunk, as OpenRouter's SDK passes it on).
test("Kilo's upstream cost is read on Messages, Responses and Chat", () => {
  const KILO = "https://gateway.kilo.ai/api/gateway";
  const kiloUsage = { cost: 0.03, is_byok: false, cost_details: { upstream_inference_cost: 0.0312 } };
  const fromRaw = (raw: unknown) => {
    const c = new CallFactsCollector();
    c.noteRaw(raw);
    return resolveCallFacts(c.candidates(), "anthropic", KILO);
  };
  expect(fromRaw({ type: "message_start", message: { usage: { input_tokens: 4, ...kiloUsage } } })).toMatchObject({ reportedField: "upstream_inference_cost", reportedMicros: 31_200 });
  expect(fromRaw({ type: "message_delta", usage: { output_tokens: 9, ...kiloUsage } })).toMatchObject({ reportedField: "upstream_inference_cost", reportedMicros: 31_200 });
  expect(fromRaw({ type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 9, ...kiloUsage } } })).toMatchObject({ reportedMicros: 31_200 });
  expect(fromRaw({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 4, completion_tokens: 9, ...kiloUsage } })).toMatchObject({ reportedMicros: 31_200 });
  const meta = new CallFactsCollector();
  meta.noteResult({ providerMetadata: { anthropic: { usage: { input_tokens: 4, ...kiloUsage } } } });
  expect(resolveCallFacts(meta.candidates(), "anthropic", KILO)).toMatchObject({ reportedField: "upstream_inference_cost", reportedMicros: 31_200 });
});
