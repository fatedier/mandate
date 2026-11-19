import { expect, test } from "bun:test";
import { streamText } from "ai";
import { createAiSdkLanguageModel } from "../src/server/modules/llm/ai-sdk-model-factory.js";
import { prepareAiSdkMessages } from "../src/server/modules/agent/wake-message-adapter.js";
import { withCacheMarksFor } from "../src/server/modules/agent/replay-target.js";
import { sseFrame } from "./helpers/sse.js";
import { freshAgentEnv } from "./helpers/fixtures.js";

// A held window's messages are frozen and shared between steps, and a step's
// stored provider state goes back to the provider as it was stored. Each
// provider's request is built from them without writing into one: a writer
// would fail every step from the second on.

const reply = (events: unknown[]) => new Response(events.map((data) => sseFrame({ data })).join(""), { headers: { "content-type": "text/event-stream" } });

/** One short answer in the stream each API speaks. */
async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/messages")) {
    return reply([
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" }
    ]);
  }
  if (url.endsWith("/responses")) {
    const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
    return reply([
      { type: "response.created", response: { id: "resp_1", created_at: 1, model: "test-model" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } } } }
    ]);
  }
  if (url.includes(":streamGenerateContent")) {
    return reply([
      { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 } }
    ]);
  }
  if (url.endsWith("/chat/completions")) {
    return new Response([
      sseFrame({ data: { id: "c1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] } }),
      sseFrame({ data: { id: "c1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } } }),
      "data: [DONE]\n\n"
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  }
  return new Response("not here", { status: 404 });
}

const providers = [
  { name: "Anthropic Messages", cfg: { provider: "anthropic" as const, model: "claude-test" }, state: { anthropic: { signature: "sig_1" } } },
  { name: "OpenAI Responses", cfg: { provider: "openai" as const, model: "gpt-test" }, state: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc_1" } } },
  { name: "OpenAI-compatible Chat", cfg: { provider: "openai-compatible" as const, model: "gpt-test", openaiModelApi: "chat" as const }, state: {} },
  { name: "OpenAI-compatible Responses", cfg: { provider: "openai-compatible" as const, model: "vendor/model-test" }, state: { openai: { itemId: "rs_1" } } },
  { name: "Google Generative AI", cfg: { provider: "google" as const, model: "gemini-test" }, state: { google: { thoughtSignature: "sig_g" } } },
  // Kilo on Chat through OpenRouter's SDK, its middleware carrying the reasoning details back.
  { name: "Kilo", cfg: { provider: "kilo" as const, model: "vendor/model-test" }, state: { openrouter: { reasoning_details: [{ type: "reasoning.text", text: "thinking", format: "unknown" }] } } }
];

for (const { name, cfg, state } of providers) {
  test(`a held window's frozen messages go out unchanged on ${name}`, async () => {
    const env = freshAgentEnv("md-window-providers-");
    const thread = env.agentStore.getOrCreateThread("worker", "wkr-providers");
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "list the files" } });
    env.agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self",
      content: {
        type: "assistant", text: "let me look",
        toolCalls: [{ toolCallId: "call_1", toolName: "bash", args: { command: "ls" } }],
        sdkAssistantMessages: [{
          role: "assistant",
          content: [
            { type: "reasoning", text: "thinking", providerOptions: state },
            { type: "text", text: "let me look" },
            { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "ls" } }
          ]
        }]
      } as never
    });
    env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "call_1", toolName: "bash", result: "a.txt" } });
    // Held, then read again: the second read hands out the held copies.
    env.agentStore.getActiveMessages(thread.id);
    const active = env.agentStore.getActiveMessages(thread.id);
    expect(Object.isFrozen(active[1]!.content)).toBe(true);
    const model = createAiSdkLanguageModel({ ...cfg, providerName: "provider-1", apiKey: "test-key", baseURL: "http://stub.invalid/v1", fetch: stubFetch as typeof fetch });
    expect(model).not.toBeNull();
    const messages = withCacheMarksFor({ model: cfg.model, meta: { provider: cfg.provider === "anthropic" ? "anthropic" : "openai" } } as never, prepareAiSdkMessages(active, { includeImages: false }), "5m");

    // The stored provider state goes out as held: frozen, not a copy.
    expect(messages.some((message) => Object.isFrozen(message))).toBe(true);
    const errors: unknown[] = [];
    const result = streamText({ model: model!, messages, onError: ({ error }) => { errors.push(error); } });
    expect(await result.text).toBe("ok");
    expect(errors).toEqual([]);
    expect(env.agentStore.getActiveMessages(thread.id)).toEqual(new (env.agentStore.constructor as typeof import("../src/server/modules/agent/agent-store.js").AgentStore)(env.store.db).getActiveMessages(thread.id));
  });
}
