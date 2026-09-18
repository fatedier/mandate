import { expect, test } from "bun:test";
import { generateText, type LanguageModel } from "ai";
import {
  createAiSdkLanguageModel,
  createDisabledLanguageModel
} from "../src/server/modules/llm/ai-sdk-model-factory.js";
import { textGenerationApiMode } from "../src/server/modules/llm/text-model.js";
import {
  providerInstanceSupportsToolResultImages,
  providerSupportsToolResultImages
} from "../src/server/runtime/agent-scopes.js";

test("textGenerationApiMode uses streaming for background text calls", () => {
  expect(textGenerationApiMode("codex")).toBe("streamText");
  expect(textGenerationApiMode("openai")).toBe("streamText");
  expect(textGenerationApiMode("openai-compatible")).toBe("streamText");
  expect(textGenerationApiMode("anthropic")).toBe("streamText");
});

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
    baseURL: "https://proxy.example/v1",
    openaiProviderName: "proxy"
  }) as ProviderModel | null;
  expect(model?.provider).toBe("proxy.responses");
  expect(model?.modelId).toBe("openai/gpt-4.1-mini");
});

test("createAiSdkLanguageModel creates Kilo Gateway chat models", () => {
  const model = createAiSdkLanguageModel({
    provider: "kilo",
    model: "kilo-auto/balanced",
    apiKey: "sk-kilo",
    baseURL: "https://api.kilo.ai/api/gateway",
    organizationId: "org_123"
  }) as ProviderModel | null;
  expect(model?.provider).toBe("kilo.chat");
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

test("providerInstanceSupportsToolResultImages uses actual AI SDK model provider path", () => {
  expect(providerInstanceSupportsToolResultImages({
    meta: { provider: "openai-compatible" },
    model: { provider: "proxy.responses" }
  })).toBe(true);
  expect(providerInstanceSupportsToolResultImages({
    meta: { provider: "openai-compatible" },
    model: { provider: "proxy.chat" }
  })).toBe(false);
});

test("Kilo Gateway requests include organization header when configured", async () => {
  let requestedUrl = "";
  let authorization = "";
  let organizationId = "";
  const model = createAiSdkLanguageModel({
    provider: "kilo",
    model: "kilo-auto/balanced",
    apiKey: "sk-kilo",
    baseURL: "https://api.kilo.ai/api/gateway",
    organizationId: "org_123",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requestedUrl = String(input);
      authorization = headers.get("authorization") ?? "";
      organizationId = headers.get("X-KiloCode-OrganizationId") ?? "";
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "kilo-auto/balanced",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch
  });

  const result = await generateText({ model: model!, prompt: "hello", maxRetries: 0 });
  expect(result.text).toBe("ok");
  expect(requestedUrl).toBe("https://api.kilo.ai/api/gateway/chat/completions");
  expect(authorization).toBe("Bearer sk-kilo");
  expect(organizationId).toBe("org_123");
});

test("createDisabledLanguageModel fails predictably", async () => {
  const model = createDisabledLanguageModel("missing config") as ProviderModel;
  await expect(model.doGenerate({} as any)).rejects.toThrow("missing config");
  await expect(model.doStream({} as any)).rejects.toThrow("missing config");
});
