import { expect, spyOn, test } from "bun:test";
import { generateText, streamText, type LanguageModel } from "ai";
import { collectStream } from "../src/server/modules/agent/stream-collector.js";
import { callTextModelForProvider } from "../src/server/modules/llm/text-model.js";
import { errorMessage, isInputRejectedLlmError, isNonFallbackLlmError, isRetryableLlmError } from "../src/server/modules/llm/retry-policy.js";
import { createAiSdkLanguageModel } from "../src/server/modules/llm/ai-sdk-model-factory.js";
import { createAgentProvider } from "../src/server/modules/agent/llm-provider.js";
import { candidateCallOptions } from "../src/server/modules/agent/wake-llm-attempts.js";
import { isOpenAiModelId, needsReasoningPlaceholder, OPEN_RESPONSES_NAME, withResponsesFields } from "../src/server/modules/llm/open-responses-model.js";
import { latestReasoningHeading } from "../src/shared/reasoning-heading.js";

// A model that is not OpenAI's own, on a Responses endpoint, is built with
// the AI SDK's Open Responses package: it reads a model's raw reasoning
// (reasoning_text) and sends it back. Mandate adds the fields that package
// does not send (store, include, the cache key). OpenAI's own models, Chat
// models and the openai type stay on @ai-sdk/openai.

const NEW = `${OPEN_RESPONSES_NAME}.responses`;
const ANSWERS: Record<string, unknown> = {
  responses: { id: "resp_1", object: "response", created_at: 0, status: "completed", model: "m", output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  "chat/completions": { id: "c_1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
};

function capture() {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const url = String(input);
    seen.push({ url, headers, body: JSON.parse(String(init?.body ?? "{}")) });
    const kind = Object.keys(ANSWERS).find((k) => url.endsWith(`/${k}`))!;
    return new Response(JSON.stringify(ANSWERS[kind]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, fetch };
}

const providerOf = (model: LanguageModel | null) => (model as { provider: string }).provider;

test("isOpenAiModelId: OpenAI's own models by name, Kilo's aliases too", () => {
  for (const id of ["openai/gpt-6.1-sol", "gpt-5.5", "o4-mini", "o3", "chatgpt-4o-latest", "codex-mini-latest", "~openai/gpt-sol-latest", "~openai/omni-latest", "OpenAI/GPT-5.5"]) {
    expect([id, isOpenAiModelId(id)]).toEqual([id, true]);
  }
  for (const id of ["deepseek/deepseek-flash", "x-ai/grok-4.7", "~x-ai/grok-latest", "meta/muse-spark-1.3", "qwen/qwen3-coder", "openai/gpt-oss-120b", "gpt-oss-20b", "vendor/model-o3x"]) {
    expect([id, isOpenAiModelId(id)]).toEqual([id, false]);
  }
});

// OpenAI's open-weight model is served only by others and returns its raw
// reasoning: it goes where that reasoning is carried back.
test("gpt-oss is not OpenAI-hosted", () => {
  const { fetch } = capture();
  const model = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: "openai/gpt-oss-120b", apiKey: "k-test", baseURL: "https://gw.example/v1", fetch });
  expect(providerOf(model)).toBe(NEW);
});

test("a non-OpenAI Responses model is built with the new package", async () => {
  const { seen, fetch } = capture();
  const model = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: "deepseek/deepseek-flash", apiKey: "k-test", baseURL: "https://gw.example/v1/", fetch })!;
  expect(providerOf(model)).toBe(NEW);
  await generateText({ model, prompt: "hi" });
  expect(seen[0]!.url).toBe("https://gw.example/v1/responses");
  expect(seen[0]!.headers.authorization).toBe("Bearer k-test");
  expect(seen[0]!.body.model).toBe("deepseek/deepseek-flash");
});

test("OpenAI models, Chat models and the openai type stay on @ai-sdk/openai", async () => {
  const gpt = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: "openai/gpt-6.1-sol", apiKey: "k-test", baseURL: "https://gw.example/v1" });
  expect(providerOf(gpt)).not.toBe(NEW);
  const { seen, fetch } = capture();
  const chat = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: "deepseek/deepseek-flash", apiKey: "k-test", baseURL: "https://gw.example/v1", openaiModelApi: "chat", fetch })!;
  await generateText({ model: chat, prompt: "hi" });
  expect(seen[0]!.url).toBe("https://gw.example/v1/chat/completions");
  expect(providerOf(createAiSdkLanguageModel({ provider: "openai", model: "deepseek/deepseek-flash", apiKey: "k-test" }))).toBe("openai.responses");
});

test("Kilo's non-OpenAI Responses models use the new package; its OpenAI ones do not", async () => {
  const { seen, fetch } = capture();
  const kilo = (model: string) => createAiSdkLanguageModel({ provider: "openai-compatible", providerType: "kilo", providerName: "kilo", model, apiKey: "k-test", baseURL: "https://gateway.example/api/gateway", organizationId: "org-test", fetch })!;
  const grok = kilo("x-ai/grok-4.7");
  expect(providerOf(grok)).toBe(NEW);
  await generateText({ model: grok, prompt: "hi" });
  expect(seen[0]!.url).toBe("https://gateway.example/api/gateway/v1/responses");
  expect(seen[0]!.headers.authorization).toBe("Bearer k-test");
  expect(seen[0]!.headers["x-kilocode-organizationid"]).toBe("org-test");
  expect(providerOf(kilo("openai/gpt-6.1-sol"))).not.toBe(NEW);
});

test("the fields are added only when absent", async () => {
  const { seen, fetch } = capture();
  const model = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: "deepseek/deepseek-flash", apiKey: "k-test", baseURL: "https://gw.example/v1", fetch })!;
  await generateText({ model, prompt: "hi", headers: { "x-session-id": "thr_x" }, reasoning: "medium" });
  expect(seen[0]!.body).toMatchObject({ store: false, include: ["reasoning.encrypted_content"], prompt_cache_key: "thr_x" });
  await generateText({ model, prompt: "hi" });
  expect("prompt_cache_key" in seen[1]!.body).toBe(false);

  const bodies: Array<BodyInit | null | undefined> = [];
  const wrapped = withResponsesFields((async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(init?.body);
    return new Response("{}");
  }) as typeof fetch);
  await wrapped("https://gw.example/v1/responses", { method: "POST", body: JSON.stringify({ store: true, include: ["x"], prompt_cache_key: "own" }), headers: { "x-session-id": "thr_y" } });
  expect(JSON.parse(String(bodies[0]))).toEqual({ store: true, include: ["x"], prompt_cache_key: "own" });
  await wrapped("https://gw.example/v1/responses", { method: "POST", body: "not json" });
  expect(bodies[1]).toBe("not json");
  await wrapped("https://gw.example/v1/responses", { method: "GET" });
  expect(bodies[2]).toBeUndefined();
});

// As on @ai-sdk/openai, which asks for it only for a model it takes for a
// reasoning one: a call that asks for no reasoning goes without it.
test("encrypted reasoning is asked for only on a call that asks for reasoning", async () => {
  const { seen, fetch } = capture();
  const model = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: "deepseek/deepseek-flash", apiKey: "k-test", baseURL: "https://gw.example/v1", fetch })!;
  await generateText({ model, prompt: "hi" });
  expect("include" in seen[0]!.body).toBe(false);
  expect(seen[0]!.body.store).toBe(false);
  await generateText({ model, prompt: "hi", reasoning: "medium" });
  expect(seen[1]!.body.include).toEqual(["reasoning.encrypted_content"]);
  await generateText({ model, prompt: "hi", providerOptions: { [OPEN_RESPONSES_NAME]: { reasoningSummary: "auto" } } });
  expect(seen[2]!.body.include).toEqual(["reasoning.encrypted_content"]);
});

// A search is one call with nothing to replay: it keeps the package that
// carries the hosted web_search tool.
test("model search keeps @ai-sdk/openai", () => {
  const provider = createAgentProvider({
    provider: "openai-compatible", providerType: "openai-compatible", providerName: "gw",
    model: "deepseek/deepseek-flash", apiKey: "k-test", baseURL: "https://gw.example/v1",
    reasoningEffort: "low", responsesSdk: "openai"
  });
  expect(providerOf(provider.model)).not.toBe(NEW);
  const normal = createAgentProvider({
    provider: "openai-compatible", providerType: "openai-compatible", providerName: "gw",
    model: "deepseek/deepseek-flash", apiKey: "k-test", baseURL: "https://gw.example/v1", reasoningEffort: "low"
  });
  expect(providerOf(normal.model)).toBe(NEW);
});

// The live reasoning heading asks for a summary; the new package reads it
// under its own key (the openai options it ignores).
test("the reasoning summary goes under the new package's key", async () => {
  const { seen, fetch } = capture();
  const model = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: "deepseek/deepseek-flash", apiKey: "k-test", baseURL: "https://gw.example/v1", fetch })!;
  const candidate = { model, meta: { provider: "openai-compatible", providerType: "openai-compatible", model: "deepseek/deepseek-flash", supportsReasoning: true, reasoningEffort: "medium" as const } };
  const asked = candidateCallOptions(candidate as never, "thr_x", { askSummary: true });
  expect((asked.providerOptions as Record<string, unknown>)[OPEN_RESPONSES_NAME]).toEqual({ reasoningSummary: "auto" });
  expect((candidateCallOptions(candidate as never, "thr_x", { askSummary: false }).providerOptions as Record<string, unknown>)[OPEN_RESPONSES_NAME]).toEqual({ reasoningSummary: null });
  await generateText({ ...asked, prompt: "hi" } as never);
  expect(seen[0]!.body.reasoning).toMatchObject({ effort: "medium", summary: "auto" });
});

test("needsReasoningPlaceholder: a DeepSeek model on the new package with reasoning on", () => {
  const on = (model: string, opts: Record<string, unknown> = {}) => createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model, apiKey: "k-test", baseURL: "https://gw.example/v1", ...opts })!;
  expect(needsReasoningPlaceholder(on("deepseek/deepseek-flash"), { reasoningEffort: "medium" })).toBe(true);
  expect(needsReasoningPlaceholder(on("deepseek/deepseek-flash"), { reasoningEffort: "provider-default" })).toBe(true);
  expect(needsReasoningPlaceholder(on("deepseek/deepseek-flash"), { reasoningEffort: "medium", supportsReasoning: false })).toBe(false);
  expect(needsReasoningPlaceholder(on("deepseek/deepseek-flash"), { reasoningEffort: "none" })).toBe(false);
  expect(needsReasoningPlaceholder(on("x-ai/grok-4.7"), { reasoningEffort: "medium" })).toBe(false);
  expect(needsReasoningPlaceholder(on("deepseek/deepseek-flash", { openaiModelApi: "chat" }), { reasoningEffort: "medium" })).toBe(false);
});

// A gateway's error inside the stream keeps the provider's words and a status,
// so the retry policy decides as it did on @ai-sdk/openai: OpenAI's flat
// `error` event (the package reads only a nested one) and a failed response.
function sse(events: Array<Record<string, unknown>>) {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}
const created = { type: "response.created", response: { id: "resp_x", object: "response", created_at: 0, status: "in_progress", model: "m", output: [] } };
const failedResponse = { type: "response.failed", response: { id: "resp_x", object: "response", created_at: 0, status: "failed", model: "m", output: [], error: { code: "server_error", message: "The server had an error while processing your request." } } };
const flatError = { type: "error", code: "server_error", message: "The server had an error while processing your request.", param: null, sequence_number: 1 };

for (const [label, events] of [["a flat error event", [created, flatError]], ["a failed response", [created, failedResponse]]] as const) {
  test(`${label} keeps the provider's message and is decided as on @ai-sdk/openai`, async () => {
    const build = (id: string) => createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: id, apiKey: "k-test", baseURL: "https://gw.example/v1", fetch: sse([...events]) })!;
    const failure = async (model: LanguageModel) => ({
      step: await collectStream(streamText({ model, prompt: "hi", includeRawChunks: true, maxRetries: 0 }).fullStream).then(() => null, (e: unknown) => e),
      // A background call (a compaction, a judgement) throws it too, not an empty answer.
      text: await callTextModelForProvider("openai-compatible", { model, prompt: "hi" } as never).then(() => null, (e: unknown) => e)
    });
    const viaNew = await failure(build("deepseek/deepseek-flash"));
    const viaOpenAi = await failure(build("openai/gpt-6.1-sol"));
    for (const error of [viaNew.step, viaNew.text]) expect(errorMessage(error)).toContain("The server had an error while processing your request.");
    // A step's failure is decided as on @ai-sdk/openai (by the provider's words: collectStream keeps them).
    expect(isRetryableLlmError(viaNew.step)).toBe(isRetryableLlmError(viaOpenAi.step));
    // A background call's failure keeps its status (a server error): retried on the same model.
    expect(isRetryableLlmError(viaNew.text)).toBe(true);
  });
}

// Only an event that can be an error is read for the flat form: every other
// event is parsed once, by the package, not a second time on its way there.
test("an event that is not an error is parsed once on its way to the package", async () => {
  const data = JSON.stringify(created);
  const parse = spyOn(JSON, "parse");
  try {
    const model = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: "deepseek/deepseek-flash", apiKey: "k-test", baseURL: "https://gw.example/v1", fetch: sse([created, flatError]) })!;
    await collectStream(streamText({ model, prompt: "hi", maxRetries: 0 }).fullStream).catch(() => null);
    expect(parse.mock.calls.filter(([text]) => text === data)).toHaveLength(1);
    // The error event is still read, and given its nested form.
    expect(parse.mock.calls.filter(([text]) => text === JSON.stringify(flatError)).length).toBeGreaterThanOrEqual(1);
  } finally {
    parse.mockRestore();
  }
});

// However a server writes it (spaces after its colons, letters escaped), a
// flat error is still found.
for (const [label, write] of [
  ["with spaces", (e: Record<string, unknown>) => JSON.stringify(e).replace(/":/g, '": ')],
  ["with its type's letters escaped", (e: Record<string, unknown>) => JSON.stringify(e).replace('"type":"error"', '"type":"err\\u006fr"')]
] as const) test(`a flat error event written ${label} keeps the provider's message`, async () => {
  const body = [created, flatError].map((e) => `event: ${String(e.type)}\ndata: ${write(e)}\n\n`).join("");
  const fetch = (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof globalThis.fetch;
  const model = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: "deepseek/deepseek-flash", apiKey: "k-test", baseURL: "https://gw.example/v1", fetch })!;
  const failure = await collectStream(streamText({ model, prompt: "hi", maxRetries: 0 }).fullStream).then(() => null, (e: unknown) => e);
  expect(errorMessage(failure)).toContain("The server had an error while processing your request.");
});

// A gateway's HTTP error body keeps its message whatever its code's type
// (OpenRouter-style gateways send a number): the retry policy reads the
// provider's words, and "Bad Request" alone would stop the fallback.
test("an HTTP error with a numeric code keeps the provider's message, as on @ai-sdk/openai", async () => {
  const body = { error: { message: "This model's maximum context length is 131072 tokens.", type: "invalid_request_error", param: 7, code: 400 } };
  const fetch = (async () => new Response(JSON.stringify(body), { status: 400, statusText: "Bad Request", headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
  const fail = (id: string) => generateText({ model: createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: id, apiKey: "k-test", baseURL: "https://gw.example/v1", fetch })!, prompt: "hi", maxRetries: 0 }).then(() => null, (e: unknown) => e);
  const viaNew = await fail("deepseek/deepseek-flash");
  const viaOpenAi = await fail("openai/gpt-6.1-sol");
  expect(errorMessage(viaNew)).toContain("maximum context length");
  expect([isInputRejectedLlmError(viaNew), isNonFallbackLlmError(viaNew)]).toEqual([isInputRejectedLlmError(viaOpenAi), isNonFallbackLlmError(viaOpenAi)]);
});

// A reasoning summary in two parts, each headed by a bolded phrase, reaches
// the working line part by part on both packages. The Open Responses package
// streams both parts under the item's id and drops the new part's event, so
// the second part starts its own paragraph from the raw one.
test("a two-part reasoning summary keeps its parts apart on both packages", async () => {
  const PART_1 = "**Checking the changelog**\n\nI read the entries since 3.21.";
  const PART_2 = "**Drafting the release notes**\n\nOne line per change.";
  const summary = (index: number, text: string) => [
    { type: "response.reasoning_summary_part.added", item_id: "rs_1", output_index: 0, summary_index: index, part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: index, delta: text },
    { type: "response.reasoning_summary_part.done", item_id: "rs_1", output_index: 0, summary_index: index, part: { type: "summary_text", text } }
  ];
  const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: PART_1 }, { type: "summary_text", text: PART_2 }] };
  const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Here are the notes.", annotations: [] }] };
  const events = [
    created,
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
    ...summary(0, PART_1),
    ...summary(1, PART_2),
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "Here are the notes." },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.completed", response: { id: "resp_x", object: "response", created_at: 0, status: "completed", model: "m", output: [reasoning, message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
  ];
  for (const id of ["deepseek/deepseek-flash", "openai/gpt-6.1-sol"]) {
    const model = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: id, apiKey: "k-test", baseURL: "https://gw.example/v1", fetch: sse(events) })!;
    const headings: string[] = [];
    const collected = await collectStream(streamText({ model, prompt: "hi", includeRawChunks: true, maxRetries: 0 }).fullStream, {
      onReasoningDelta: (text) => {
        const heading = latestReasoningHeading(text);
        if (heading && heading !== headings.at(-1)) headings.push(heading);
      }
    });
    expect([id, headings]).toEqual([id, ["Checking the changelog", "Drafting the release notes"]]);
    expect([id, collected.reasoning?.text]).toEqual([id, `${PART_1}\n\n${PART_2}`]);
  }
});
