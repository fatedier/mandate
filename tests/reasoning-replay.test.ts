import { expect, test } from "bun:test";
import { generateText, type ModelMessage } from "ai";
import { forReplay } from "../src/server/modules/agent/reasoning-replay.js";
import { createAiSdkLanguageModel } from "../src/server/modules/llm/ai-sdk-model-factory.js";
import { OPEN_RESPONSES_NAME } from "../src/server/modules/llm/open-responses-model.js";
import type { AiSdkAssistantMessage } from "../src/shared/agent-message-types.js";
import { isReasoningSummaryRefusal } from "../src/server/modules/llm/reasoning.js";
import { codexHttpErrorFromResponse } from "../src/server/modules/codex/codex-oauth-provider.js";

const part = (itemId: string | null, encrypted: string | null, text: string) => ({
  type: "reasoning" as const, text,
  providerOptions: { openai: { ...(itemId ? { itemId } : {}), reasoningEncryptedContent: encrypted } }
});

test("an item's summary parts collapse to one blank part with the newest encrypted state; the rest is left alone", () => {
  const message: AiSdkAssistantMessage = {
    role: "assistant",
    content: [
      part("rs_a", "enc-1", "**Gathering**"),
      part("rs_a", null, "**Checking**"),
      part("rs_a", "enc-3", "**Drafting**"),
      part("rs_b", "enc-b", "**Other item**"),
      part(null, "enc-loose", "no item id"),
      { type: "reasoning", text: "Anthropic thinking", providerOptions: { anthropic: { signature: "sig" } } },
      { type: "text", text: "Here is a draft." }
    ]
  };
  const expected: unknown[] = [
    part("rs_a", "enc-3", ""),
    part("rs_b", "enc-b", ""),
    part(null, "enc-loose", ""),
    { type: "reasoning", text: "Anthropic thinking", providerOptions: { anthropic: { signature: "sig" } } },
    { type: "text", text: "Here is a draft." }
  ];
  expect(forReplay(message).content as unknown[]).toEqual(expected);
});

// The Open Responses package keeps a model's raw reasoning twice on a part:
// as its text and under its own key. A DeepSeek step of 40 KB of reasoning
// was stored three times (with the step's own copy for the transcript).
const raw = (itemId: string, text: string, content: Array<{ type: "reasoning_text"; text: string }> | null, summary: string[] = []) => ({
  type: "reasoning" as const, text,
  providerOptions: { [OPEN_RESPONSES_NAME]: { itemId, reasoningSummary: summary.map((s) => ({ type: "summary_text", text: s })), reasoningContent: content } }
});

test("raw reasoning the Open Responses package keeps under its key as well as in the part's text is kept once", () => {
  const message: AiSdkAssistantMessage = {
    role: "assistant",
    content: [
      raw("rs_1", "We need to read the changelog first.", [{ type: "reasoning_text", text: "We need to read the changelog first." }]),
      // Only a summary came back: nothing repeats, and the package must not
      // read the part's text as reasoning content.
      raw("rs_2", "Reading the changelog", null, ["Reading the changelog"]),
      // The key's copy is not the text: kept as it came.
      raw("rs_3", "First part.", [{ type: "reasoning_text", text: "First part." }, { type: "reasoning_text", text: "Second part." }]),
      raw("rs_4", "Reading the changelog", [{ type: "reasoning_text", text: "The changelog lists three fixes." }]),
      // An empty one: the package sends the text only when there is some.
      raw("rs_5", "", [{ type: "reasoning_text", text: "" }]),
      { type: "text", text: "Here is a draft." }
    ]
  };
  const [first, ...rest] = forReplay(message).content as unknown[];
  expect(first).toEqual({ type: "reasoning", text: "We need to read the changelog first.", providerOptions: { [OPEN_RESPONSES_NAME]: { itemId: "rs_1", reasoningSummary: [] } } });
  expect(rest).toEqual((message.content as unknown[]).slice(1));
});

test("a step kept once goes back to the Open Responses package exactly as it would have", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ id: "resp_1", object: "response", created_at: 0, status: "completed", model: "m", output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const model = createAiSdkLanguageModel({ provider: "openai-compatible", providerName: "gw", model: "deepseek/deepseek-flash", apiKey: "k-test", baseURL: "https://gw.example/v1", fetch })!;
  const stored: AiSdkAssistantMessage = {
    role: "assistant",
    content: [
      raw("rs_1", "We need to read the changelog first.", [{ type: "reasoning_text", text: "We need to read the changelog first." }]),
      raw("rs_2", "Reading the changelog", null, ["Reading the changelog"]),
      raw("rs_3", "", [{ type: "reasoning_text", text: "" }]),
      { type: "text", text: "Looked at the changelog." }
    ]
  };
  const history = (step: AiSdkAssistantMessage): ModelMessage[] => [
    { role: "user", content: "Draft the notes" },
    step as ModelMessage,
    { role: "user", content: "Go on" }
  ];
  await generateText({ model, messages: history(stored) });
  await generateText({ model, messages: history(forReplay(stored)) });
  expect(bodies[1]!.input).toEqual(bodies[0]!.input);
  expect(JSON.stringify(bodies[1]!.input)).toContain('"content":[{"type":"reasoning_text","text":"We need to read the changelog first."}]');
});

test("a refused summary is read from the structured parameter too, not only the message", async () => {
  const codex = await codexHttpErrorFromResponse(new Response(
    JSON.stringify({ error: { message: "Invalid value: 'auto'.", param: "reasoning.summary", type: "invalid_request_error" } }),
    { status: 400, statusText: "Bad Request" }
  ));
  expect(isReasoningSummaryRefusal(codex)).toBe(true);
  const sdk = Object.assign(new Error("Bad Request"), { statusCode: 400, responseBody: JSON.stringify({ error: { message: "Invalid value: 'auto'.", param: "reasoning.summary" } }) });
  expect(isReasoningSummaryRefusal(sdk)).toBe(true);
  const other = await codexHttpErrorFromResponse(new Response(
    JSON.stringify({ error: { message: "Invalid value: 'auto'.", param: "tool_choice" } }),
    { status: 400, statusText: "Bad Request" }
  ));
  expect(isReasoningSummaryRefusal(other)).toBe(false);
  // Named in the message, it is a refusal whatever the status: a gateway may stamp it 500.
  expect(isReasoningSummaryRefusal(Object.assign(new Error("Unsupported parameter: 'reasoning.summary'."), { statusCode: 500 }))).toBe(true);
  expect(isReasoningSummaryRefusal(Object.assign(new Error("Internal server error"), { statusCode: 500 }))).toBe(false);
});

test("a stream error names the refused parameter in its frame: read there as well", () => {
  const frames = [
    { type: "error", code: "invalid_value", message: "Invalid value: 'auto'.", param: "reasoning.summary" },
    { type: "error", error: { message: "Invalid value: 'auto'.", param: "reasoning.summary" } },
    { type: "response.failed", response: { error: { message: "Invalid value: 'auto'.", param: "reasoning.summary" } } }
  ];
  for (const data of frames) expect(isReasoningSummaryRefusal(Object.assign(new Error("Invalid value: 'auto'."), { data }))).toBe(true);
  // A frame the SDK could not parse arrives as its type-validation error's value.
  expect(isReasoningSummaryRefusal(Object.assign(new Error("Type validation failed"), { value: frames[0] }))).toBe(true);
  expect(isReasoningSummaryRefusal(Object.assign(new Error("Invalid value: 'auto'."), { data: { type: "error", param: "tool_choice" } }))).toBe(false);
});
