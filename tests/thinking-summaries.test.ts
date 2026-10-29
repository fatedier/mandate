import { expect, test } from "bun:test";
import * as os from "node:os";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { toAgentClientMessage } from "../src/server/modules/agent/agent-message-dto.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher, WakeLlmCandidate } from "../src/server/modules/agent/wake-loop.js";
import { createAiSdkLanguageModel } from "../src/server/modules/llm/ai-sdk-model-factory.js";
import { sseFrame } from "./helpers/sse.js";

// Thinking summaries: OpenAI-style calls ask for the reasoning
// summary; each step keeps it, unshown; the page hears only the heading the
// summary has reached, for its working line.

function fresh() {
  const store = new MandateStore(tempDir("md-thinking-"));
  onCleanup(() => store.db.close());
  return { agentStore: new AgentStore(store.db) };
}
const STUB_SCOPE = (_t: string): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] });
const NO_TOOLS: ToolDispatcher = { registry: { tools: {} }, dispatch: async () => ({ result: "ok" }) };
/** What the wake loop reads of a candidate's model. */
type CandidateMeta = NonNullable<WakeLlmCandidate["meta"]>;

function run(provider: string, turns: Parameters<typeof createMockLLM>[0], modelProvider = "openai.responses", meta: CandidateMeta = {}) {
  const { agentStore } = fresh();
  const thread = agentStore.createManagerThread("project-1 3.22 release");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  const llm = createMockLLM(turns, { provider: modelProvider, modelId: "gpt-5.5" });
  const events: Array<{ name: string; data: any }> = [];
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => NO_TOOLS,
    llmModel: llm,
    llmForThread: () => ({ model: llm, candidates: [{ model: llm, meta: { provider, model: "gpt-5.5", baseURL: "https://proxy.example/v1", ...meta } }] }),
    sse: { emit: (name, data) => events.push({ name, data }) },
    buildToolScope: STUB_SCOPE
  });
  return { agentStore, thread, ask, llm, events, wake: () => wakeAndWait(thread.id, "user", ask.id), wakeOn: (id: string) => wakeAndWait(thread.id, "user", id) };
}

test("an OpenAI-style call asks for the reasoning summary; another provider's does not", async () => {
  for (const [provider, modelProvider, asked] of [
    ["openai-compatible", "openai.responses", "auto"],
    ["openai", "openai.responses", "auto"],
    ["anthropic", "anthropic.messages", undefined],
    ["openai-compatible", "openai.chat", undefined]
  ] as const) {
    const r = run(provider, [{ text: "ok", finishReason: "stop" }], modelProvider);
    await r.wake();
    expect([provider, modelProvider, r.llm.streamCalls[0]!.providerOptions?.openai?.reasoningSummary]).toEqual([provider, modelProvider, asked]);
  }
  // A custom provider's model on Chat Completions gets none of the
  // Responses-only options.
  const chat = run("openai-compatible", [{ text: "ok", finishReason: "stop" }], "openai.chat");
  await chat.wake();
  const options = chat.llm.streamCalls[0]!.providerOptions?.openai;
  expect([options?.store, options?.promptCacheKey, options?.reasoningSummary]).toEqual([undefined, undefined, undefined]);
});

test("with reasoning off no summary is asked, even of a model the SDK takes for a reasoning one", async () => {
  const r = run("openai-compatible", [{ text: "ok", finishReason: "stop" }], "openai.responses", { supportsReasoning: false });
  await r.wake();
  const openai = r.llm.streamCalls[0]!.providerOptions?.openai;
  expect([openai?.reasoningSummary, openai?.forceReasoning]).toEqual([null, undefined]);
});

test("a step keeps its summary; the page hears each new heading once and never the summary", async () => {
  const summary = ["**Gathering merged changes**\n\nI need what merged since 3.21.", "**Checking the changelog format**\n\nKeep the 3.21 shape."];
  const r = run("openai-compatible", [{ reasoning: summary, text: "Here is a draft.", finishReason: "stop" }]);
  await r.wake();
  const step = r.agentStore.getMessages(r.thread.id).find((m) => m.role === "assistant")!;
  expect(step.content).toMatchObject({ type: "assistant", text: "Here is a draft.", reasoning: { text: summary.join("\n\n") } });
  expect((step.content as { reasoning?: { ms: number } }).reasoning?.ms).toBeGreaterThanOrEqual(0);
  const headings = r.events.filter((e) => e.name === SSE_EVENTS.agentReasoningHeading);
  expect(headings.map((e) => e.data.heading)).toStrictEqual(["Gathering merged changes", "Checking the changelog format"]);
  expect(headings.every((e) => e.data.threadId === r.thread.id && e.data.wakeId === step.wakeId)).toBe(true);
  // Not shown, so not sent: the page's copy of the step — what thread reads
  // return and what the SSE route delivers for an append — leaves it out.
  const appended = r.events.find((e) => e.name === SSE_EVENTS.agentMessageAppended && e.data.message.id === step.id)!;
  for (const copy of [toAgentClientMessage(step), toAgentClientMessage(appended.data.message)]) {
    expect(JSON.stringify(copy)).toContain("Here is a draft.");
    expect(JSON.stringify(copy)).not.toContain("I need what merged");
  }
});

test("a step that did not reason keeps none and sends no heading", async () => {
  const r = run("openai-compatible", [{ text: "ok", finishReason: "stop" }]);
  await r.wake();
  const step = r.agentStore.getMessages(r.thread.id).find((m) => m.role === "assistant")!;
  expect("reasoning" in step.content).toBe(false);
  expect(r.events.some((e) => e.name === SSE_EVENTS.agentReasoningHeading)).toBe(false);
});

test("a gateway that refuses the summary option gets the turn without it, and is not asked again", async () => {
  const refused = Object.assign(new Error("Unsupported parameter: 'reasoning.summary'."), { statusCode: 400 });
  const r = run("openai-compatible", [{ error: refused }, { text: "ok", finishReason: "stop" }, { text: "again", finishReason: "stop" }]);
  const wakeId = await r.wake();
  expect(r.agentStore.getWakeById(wakeId)?.status).toBe("finished");
  const asked = () => r.llm.streamCalls.map((call) => call.providerOptions?.openai?.reasoningSummary);
  expect(asked()).toStrictEqual(["auto", null]);
  const next = r.agentStore.appendMessage({ threadId: r.thread.id, role: "user", source: "user", content: { type: "text", text: "and now?" } });
  await r.wakeOn(next.id);
  expect(asked()).toStrictEqual(["auto", null, null]);
});

test("another 400 is not taken for a refused summary: the option stays", async () => {
  const unknown = Object.assign(new Error("Invalid request: unknown parameter 'tool_choice.mode'."), { statusCode: 400 });
  const r = run("openai-compatible", [{ error: unknown }, { error: unknown }, { text: "ok", finishReason: "stop" }]);
  const wakeId = await r.wake();
  expect(r.agentStore.getWakeById(wakeId)?.status).toBe("error");
  const next = r.agentStore.appendMessage({ threadId: r.thread.id, role: "user", source: "user", content: { type: "text", text: "retry" } });
  await r.wakeOn(next.id);
  // Tried once without the summary too (it might have been the summary); that
  // failed the same way, so it was not the summary: asked again next time.
  expect(r.llm.streamCalls.map((call) => call.providerOptions?.openai?.reasoningSummary)).toStrictEqual(["auto", null, "auto"]);
});

test("an error about the input itself is thrown as before: no request without the summary, so no blip on one can turn it into a retry", async () => {
  const tooLong = Object.assign(new Error("This model's maximum context length is 400000 tokens."), { statusCode: 400 });
  const overloaded = Object.assign(new Error("upstream overloaded"), { statusCode: 503 });
  const r = run("openai-compatible", [{ error: tooLong }, { error: overloaded }, { text: "ok", finishReason: "stop" }]);
  expect(r.agentStore.getWakeById(await r.wake())?.status).toBe("error");
  expect(r.llm.streamCalls.map((call) => call.providerOptions?.openai?.reasoningSummary)).toStrictEqual(["auto"]);
});

test("the summary is not replayed to the model: the next step gets the reasoning's encrypted state only", async () => {
  const r = run("openai-compatible", [
    { reasoning: ["**Gathering merged changes**\n\nI need what merged since 3.21."], toolCalls: [{ toolCallId: "c1", toolName: "read", args: { path: "CHANGELOG.md" } }], finishReason: "tool-calls" },
    { text: "Here is a draft.", finishReason: "stop" }
  ]);
  await r.wake();
  const first = r.agentStore.getMessages(r.thread.id).find((m) => m.role === "assistant")!;
  expect((first.content as { reasoning?: { text: string } }).reasoning?.text).toContain("I need what merged");
  const kept = JSON.stringify((first.content as { sdkAssistantMessages?: unknown }).sdkAssistantMessages);
  expect(kept).toContain("enc-mock");
  expect(kept).not.toContain("I need what merged");
  expect(JSON.stringify(r.llm.calls[1]!.options.prompt)).not.toContain("I need what merged");
});

test("dropping a refused summary does not spend the model's normal retry", async () => {
  const refused = Object.assign(new Error("Unsupported parameter: 'reasoning.summary'."), { statusCode: 400 });
  const overloaded = Object.assign(new Error("upstream overloaded"), { statusCode: 503 });
  // Refused, then a transient failure without it: that failure still gets its retry.
  const first = run("openai-compatible", [{ error: refused }, { error: overloaded }, { text: "ok", finishReason: "stop" }]);
  expect(first.agentStore.getWakeById(await first.wake())?.status).toBe("finished");
  expect(first.llm.streamCalls.map((call) => call.providerOptions?.openai?.reasoningSummary)).toStrictEqual(["auto", null, null]);
  // A transient failure first, then the refusal on the retry: still a request without it.
  const second = run("openai-compatible", [{ error: overloaded }, { error: refused }, { text: "ok", finishReason: "stop" }]);
  expect(second.agentStore.getWakeById(await second.wake())?.status).toBe("finished");
  expect(second.llm.streamCalls.map((call) => call.providerOptions?.openai?.reasoningSummary)).toStrictEqual(["auto", "auto", null]);
});

test("a reasoning item streamed as several summary parts is replayed as one part with its newest encrypted state", async () => {
  const r = run("openai-compatible", [
    { reasoning: ["**Gathering**\n\nfirst", "**Checking**\n\nsecond", "**Drafting**\n\nthird"], toolCalls: [{ toolCallId: "c1", toolName: "read", args: { path: "a" } }], finishReason: "tool-calls" },
    { text: "done", finishReason: "stop" }
  ]);
  await r.wake();
  const first = r.agentStore.getMessages(r.thread.id).find((m) => m.role === "assistant")!;
  const parts = ((first.content as { sdkAssistantMessages?: Array<{ content: Array<{ type: string; text?: string }> }> }).sdkAssistantMessages ?? [])
    .flatMap((message) => message.content.filter((part) => part.type === "reasoning"));
  expect(parts).toHaveLength(1);
  expect(parts[0]!.text).toBe("");
  expect(JSON.stringify(parts[0])).toContain("enc-mock");
});

// The real OpenAI SDK model, a fake gateway: what goes on the wire.
const sse = (events: object[]) => new Response(events.map((e) => sseFrame({ data: e })).join(""), { headers: { "content-type": "text/event-stream" } });
/** Events in order, the last held back: past the SDK's early-error window, so
 *  it arrives as a provider stream error rather than with the response body. */
function sseLate(events: object[], lateMs: number): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [index, event] of events.entries()) {
        if (index === events.length - 1) await new Promise((resolve) => setTimeout(resolve, lateMs));
        controller.enqueue(encoder.encode(sseFrame({ data: event })));
      }
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}
function reply(id: string, text: string): object[] {
  const message = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { type: "response.created", response: { id: `resp_${id}`, created_at: 1, model: "gpt-5.5" } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [message], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }
  ];
}
function onGateway(refuse: (body: any, n: number) => Response | null) {
  const { agentStore } = fresh();
  const thread = agentStore.createManagerThread("project-1 3.22 release");
  const bodies: any[] = [];
  const model = createAiSdkLanguageModel({
    provider: "openai-compatible", model: "gpt-5.5", apiKey: "k", baseURL: "https://gateway.example/v1",
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return refuse(body, bodies.length) ?? sse(reply(String(bodies.length), "ok"));
    }) as unknown as typeof fetch
  })!;
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => NO_TOOLS,
    llmModel: model,
    llmForThread: () => ({ model, candidates: [{ model, meta: { provider: "openai-compatible", model: "gpt-5.5", baseURL: "https://gateway.example/v1", reasoningEffort: "high", supportsReasoning: true } }] }),
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE
  });
  const say = async (text: string) => {
    const m = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text } });
    return agentStore.getWakeById(await wakeAndWait(thread.id, "user", m.id))?.status;
  };
  return { bodies, say };
}
const refusal = () => new Response(
  JSON.stringify({ error: { message: "Invalid value: 'auto'.", type: "invalid_request_error", param: "reasoning.summary" } }),
  { status: 400, headers: { "content-type": "application/json" } }
);

test("on the wire: a refused summary is retried without one, even at an effort that would add a summary by default, and stays off", async () => {
  const g = onGateway((body) => (body.reasoning?.summary ? refusal() : null));
  expect(await g.say("Draft the notes")).toBe("finished");
  expect(await g.say("Again")).toBe("finished");
  expect(g.bodies.map((body) => [body.reasoning?.effort, body.reasoning?.summary ?? null])).toStrictEqual([["high", "auto"], ["high", null], ["high", null]]);
});

test("on the wire: a refusal that arrives as a stream error, naming the parameter only in its data, is recovered too", async () => {
  const g = onGateway((body) => (body.reasoning?.summary
    ? sseLate([
      { type: "response.created", response: { id: "resp_x", created_at: 1, model: "gpt-5.5" } },
      { type: "response.in_progress", response: { id: "resp_x", created_at: 1, model: "gpt-5.5" } },
      { type: "error", sequence_number: 3, code: "invalid_value", message: "Invalid value: 'auto'.", param: "reasoning.summary" }
    ], 150)
    : null));
  expect(await g.say("Draft the notes")).toBe("finished");
  expect(g.bodies.map((body) => body.reasoning?.summary ?? null)).toStrictEqual(["auto", null]);
});

test("on the wire: a response.failed frame whose parameter the SDK drops is recovered without the summary, and remembered", async () => {
  const g = onGateway((body) => (body.reasoning?.summary
    ? sseLate([
      { type: "response.created", response: { id: "resp_x", created_at: 1, model: "gpt-5.5" } },
      { type: "response.in_progress", response: { id: "resp_x", created_at: 1, model: "gpt-5.5" } },
      { type: "response.failed", sequence_number: 3, response: { id: "resp_x", status: "failed", error: { code: "invalid_value", message: "Invalid value: 'auto'.", param: "reasoning.summary" } } }
    ], 150)
    : null));
  expect(await g.say("Draft the notes")).toBe("finished");
  expect(await g.say("Again")).toBe("finished");
  expect(g.bodies.map((body) => body.reasoning?.summary ?? null)).toStrictEqual(["auto", null, null]);
});

test("once reasoning has streamed the summary was taken: a later failure is not retried without it", async () => {
  const g = onGateway((body, n) => (n === 1
    ? sseLate([
      { type: "response.created", response: { id: "resp_x", created_at: 1, model: "gpt-5.5" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "**Gathering**" },
      { type: "response.failed", sequence_number: 5, response: { id: "resp_x", status: "failed", error: { code: "invalid_prompt", message: "Invalid prompt." } } }
    ], 150)
    : null));
  expect(await g.say("Draft the notes")).toBe("error");
  expect(g.bodies.map((body) => body.reasoning?.summary ?? null)).toStrictEqual(["auto"]);
});

test("on the wire: a gateway that stamps the refusal 500 is recovered when it names the summary, or calls it an invalid request", async () => {
  for (const message of ["Internal server error: Unsupported parameter: reasoning.summary", "Internal server error: Invalid request: Invalid value: auto."]) {
    const g = onGateway((body) => (body.reasoning?.summary
      ? new Response(JSON.stringify({ error: { message } }), { status: 500, headers: { "content-type": "application/json" } })
      : null));
    expect([message, await g.say("Draft the notes")]).toEqual([message, "finished"]);
    expect(g.bodies.map((body) => body.reasoning?.summary ?? null)).toStrictEqual(["auto", null]);
  }
});

test("a candidate that was never asked for a summary keeps the normal policy: a hard failure falls back at once", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.createManagerThread("project-1 3.22 release");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  const forbidden = Object.assign(new Error("Forbidden"), { statusCode: 403 });
  const primary = createMockLLM([{ error: forbidden }, { text: "primary", finishReason: "stop" }], { provider: "anthropic.messages", modelId: "claude" });
  const fallback = createMockLLM([{ text: "fallback", finishReason: "stop" }], { provider: "google.generative-ai", modelId: "gemini" });
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => NO_TOOLS,
    llmModel: primary,
    llmForThread: () => ({ model: primary, candidates: [
      { model: primary, meta: { provider: "anthropic", model: "claude", baseURL: "" } },
      { model: fallback, meta: { provider: "google", model: "gemini", baseURL: "" } }
    ] }),
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE
  });
  const wakeId = await wakeAndWait(thread.id, "user", ask.id);
  expect(agentStore.getWakeById(wakeId)?.status).toBe("finished");
  expect([primary.streamCalls.length, fallback.streamCalls.length]).toEqual([1, 1]);
});

/** A non-reasoning Responses model on the wire (the SDK drops the summary
 *  option for it), with a fallback model behind it. */
function nonReasoningWithFallback(answer: (n: number) => Response | null) {
  const { agentStore } = fresh();
  const thread = agentStore.createManagerThread("project-1 3.22 release");
  const bodies: any[] = [];
  const primary = createAiSdkLanguageModel({
    provider: "openai-compatible", model: "gpt-4.1", apiKey: "k", baseURL: "https://gateway.example/v1",
    fetch: (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return answer(bodies.length) ?? sse(reply(String(bodies.length), "primary"));
    }) as unknown as typeof fetch
  })!;
  const fallback = createMockLLM([{ text: "fallback", finishReason: "stop" }, { text: "fallback", finishReason: "stop" }], { provider: "google.generative-ai", modelId: "gemini" });
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => NO_TOOLS,
    llmModel: primary,
    llmForThread: () => ({ model: primary, candidates: [
      { model: primary, meta: { provider: "openai-compatible", model: "gpt-4.1", baseURL: "https://gateway.example/v1", supportsReasoning: false } },
      { model: fallback, meta: { provider: "google", model: "gemini", baseURL: "" } }
    ] }),
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE
  });
  const say = async (text: string) => {
    const m = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text } });
    return agentStore.getWakeById(await wakeAndWait(thread.id, "user", m.id))?.status;
  };
  return { bodies, fallback, say };
}

test("on the wire: a model with reasoning off keeps the normal policy on a hard failure", async () => {
  const forbidden = () => new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403, headers: { "content-type": "application/json" } });
  const g = nonReasoningWithFallback((n) => (n === 1 ? forbidden() : null));
  expect(await g.say("Draft the notes")).toBe("finished");
  expect(g.bodies.map((body) => body.reasoning?.summary ?? null)).toStrictEqual([null]);
  expect(g.fallback.streamCalls).toHaveLength(1);
});

test("on the wire: with reasoning off a later stream error is not retried without the summary", async () => {
  const g = nonReasoningWithFallback((n) => (n === 2
    ? sseLate([
      { type: "response.created", response: { id: "resp_x", created_at: 1, model: "gpt-4.1" } },
      { type: "response.in_progress", response: { id: "resp_x", created_at: 1, model: "gpt-4.1" } },
      { type: "response.failed", sequence_number: 3, response: { id: "resp_x", status: "failed", error: { code: "invalid_prompt", message: "Invalid prompt." } } }
    ], 150)
    : null));
  expect(await g.say("Draft the notes")).toBe("finished");
  expect(await g.say("Again")).toBe("finished");
  expect(g.bodies).toHaveLength(2);
  expect(g.fallback.streamCalls).toHaveLength(1);
});

/** A proxied id the AI SDK does not take for a reasoning model, its settings
 *  read per wake from `meta` (change it between wakes). */
function proxied(meta: CandidateMeta, answer: (body: any, n: number) => Response | null = () => null) {
  const { agentStore } = fresh();
  const thread = agentStore.createManagerThread("project-1 3.22 release");
  const bodies: any[] = [];
  const model = createAiSdkLanguageModel({
    provider: "openai-compatible", model: "openai/gpt-6.1-sol", apiKey: "k", baseURL: "https://gateway.example/v1",
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return answer(body, bodies.length) ?? sse(reply(String(bodies.length), "ok"));
    }) as unknown as typeof fetch
  })!;
  const base = { provider: "openai-compatible", model: "openai/gpt-6.1-sol", baseURL: "https://gateway.example/v1" };
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => NO_TOOLS,
    llmModel: model,
    llmForThread: () => ({ model, candidates: [{ model, meta: { ...base, ...meta } }] }),
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE
  });
  const say = async (text: string) => {
    const m = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text } });
    return agentStore.getWakeById(await wakeAndWait(thread.id, "user", m.id))?.status;
  };
  return { bodies, say };
}

test("on the wire: a model run with reasoning off, then on, still recovers a refused summary", async () => {
  const meta: CandidateMeta = { supportsReasoning: false };
  const g = proxied(meta, (body) => (body.reasoning?.summary
    ? sseLate([
      { type: "response.created", response: { id: "resp_x", created_at: 1, model: "gpt-6.1-sol" } },
      { type: "response.in_progress", response: { id: "resp_x", created_at: 1, model: "gpt-6.1-sol" } },
      { type: "response.failed", sequence_number: 3, response: { id: "resp_x", status: "failed", error: { code: "invalid_value", message: "Invalid value: 'auto'.", param: "reasoning.summary" } } }
    ], 150)
    : null));
  expect(await g.say("Draft the notes")).toBe("finished");
  Object.assign(meta, { supportsReasoning: true });
  expect(await g.say("Again")).toBe("finished");
  expect(g.bodies.map((body) => body.reasoning?.summary ?? null)).toStrictEqual([null, "auto", null]);
});

test("on the wire: a proxied model with reasoning on is sent as a reasoning model at the provider's default effort, summary included", async () => {
  for (const meta of [{}, { supportsReasoning: true, reasoningEffort: "provider-default" }] satisfies CandidateMeta[]) {
    const g = proxied(meta);
    expect(await g.say("Draft the notes")).toBe("finished");
    const body = g.bodies[0];
    expect([JSON.stringify(meta), body.reasoning?.summary, body.reasoning?.effort ?? null, body.include, body.input[0]?.role])
      .toEqual([JSON.stringify(meta), "auto", null, ["reasoning.encrypted_content"], "developer"]);
  }
});

test("on the wire: a proxied model with reasoning off gets no reasoning options and no summary", async () => {
  const g = proxied({ supportsReasoning: false, reasoningEffort: "high" });
  expect(await g.say("Draft the notes")).toBe("finished");
  const body = g.bodies[0];
  expect([body.reasoning ?? null, body.include ?? null, body.input[0]?.role]).toEqual([null, null, "system"]);
});
