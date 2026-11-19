import { expect, test } from "bun:test";
import { generateText, type LanguageModel } from "ai";
import {
  createAiSdkLanguageModel,
  createDisabledLanguageModel
} from "../src/server/modules/llm/ai-sdk-model-factory.js";
import { providerSupportsToolResultImages } from "../src/server/runtime/agent-scopes.js";

test("createAiSdkLanguageModel returns null for incomplete non-Codex config", () => {
  expect(
    createAiSdkLanguageModel({
      provider: "openai",
      model: "gpt-5.5"
    })
  ).toBe(null);
});

/** The factory's return type admits a bare model-id string (the AI SDK's
 *  global-provider shorthand); Mandate always builds a provider-backed model
 *  object, so narrow to that for inspection. */
type ProviderModel = Exclude<LanguageModel, string>;

test("createAiSdkLanguageModel creates OpenAI-compatible models", () => {
  const model = createAiSdkLanguageModel({
    provider: "openai-compatible",
    model: "openai/gpt-4.1-mini",
    apiKey: "sk-or",
    baseURL: "https://proxy.example/v1"
  }) as ProviderModel | null;
  expect(model?.provider).toBe("openai.responses");
  expect(model?.modelId).toBe("openai/gpt-4.1-mini");
});

// A Kilo model on Chat runs through OpenRouter's SDK (Kilo's own client does).
test("createAiSdkLanguageModel creates Kilo Gateway chat models", () => {
  const model = createAiSdkLanguageModel({
    provider: "kilo",
    model: "kilo-auto/balanced",
    apiKey: "sk-kilo",
    baseURL: "https://api.kilo.ai/api/gateway",
    organizationId: "org_123"
  }) as ProviderModel | null;
  expect(model?.provider).toBe("openrouter");
  expect(model?.modelId).toBe("kilo-auto/balanced");
});

test("providerSupportsToolResultImages gates chat-completions-backed providers", () => {
  expect(providerSupportsToolResultImages({ provider: "codex" })).toBe(true);
  expect(providerSupportsToolResultImages({ provider: "openai" })).toBe(true);
  expect(providerSupportsToolResultImages({ provider: "openai" }, "openai.responses")).toBe(true);
  expect(providerSupportsToolResultImages({ provider: "openai" }, "openai.chat")).toBe(false);
  expect(providerSupportsToolResultImages({ provider: "anthropic" })).toBe(true);
  expect(providerSupportsToolResultImages({ provider: "google" })).toBe(true);
  expect(providerSupportsToolResultImages({ provider: "kilo" })).toBe(false);
  expect(providerSupportsToolResultImages({ provider: "openai-compatible" })).toBe(false);
});

/** What a Messages request asks for — max_tokens and thinking — given the
 *  model id and the call's own cap and reasoning, and the SDK's warnings. */
async function anthropicRequest(
  modelId: string,
  call: { maxOutputTokens?: number; reasoning?: Parameters<typeof generateText>[0]["reasoning"] } = {}
) {
  let body: Record<string, unknown> = {};
  const model = createAiSdkLanguageModel({
    provider: "anthropic",
    model: modelId,
    apiKey: "sk-ant",
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: modelId,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch
  });
  const result = await generateText({ model: model!, prompt: "hello", maxRetries: 0, ...call });
  return { maxTokens: body.max_tokens, thinking: body.thinking, warnings: result.warnings };
}

async function anthropicMaxTokens(modelId: string, maxOutputTokens?: number): Promise<unknown> {
  return (await anthropicRequest(modelId, { maxOutputTokens })).maxTokens;
}

test("a non-Claude Messages model the Anthropic SDK does not know may write 32k in all, not 4096", async () => {
  // The SDK adds its thinking budget (at most 4,096 for such an id) on top.
  expect(await anthropicMaxTokens("opus-latest")).toBe(32_000 - 4096);
  for (const reasoning of ["high", "xhigh", "max"] as const) {
    const request = await anthropicRequest("opus-latest", { reasoning });
    expect(request.thinking).toMatchObject({ type: "enabled" });
    expect(request.maxTokens).toBeGreaterThan(32_000 - 4096);
    expect(request.maxTokens).toBeLessThanOrEqual(32_000);
  }
});

test("a Claude Messages model keeps what the Anthropic SDK gives it", async () => {
  expect(await anthropicMaxTokens("claude-opus-5-5")).toBe(128_000);
  // Known with a smaller real maximum: left alone, so the SDK has nothing
  // to clamp back and warn about.
  expect(await anthropicRequest("claude-3-haiku-20240307")).toMatchObject({ maxTokens: 4096, warnings: [] });
  // A legacy family the SDK does not list holds its real 4,096.
  expect(await anthropicMaxTokens("claude-3-opus-20240229")).toBe(4096);
  // Newer than the SDK's table: it already gives more than 32k.
  expect(await anthropicMaxTokens("claude-future-model")).toBe(128_000);
});

test("a caller's own output cap wins over the unknown-model default", async () => {
  expect(await anthropicMaxTokens("opus-latest", 1000)).toBe(1000);
});

test("createDisabledLanguageModel fails predictably", async () => {
  const model = createDisabledLanguageModel("missing config") as ProviderModel;
  await expect(model.doGenerate({ prompt: [] })).rejects.toThrow("missing config");
  await expect(model.doStream({ prompt: [] })).rejects.toThrow("missing config");
});
