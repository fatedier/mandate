import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";

/** What a call to this V3 mock carries: ai 7 also passes the V4 `reasoning`
 *  option through to a V3 model, and tests assert on it. */
type RecordedCallOptions = LanguageModelV3CallOptions & Pick<LanguageModelV4CallOptions, "reasoning">;

interface MockResponse {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: any }>;
  finishReason?: "stop" | "tool-calls" | "length" | "error";
  usage?: { promptTokens: number; completionTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  /** On the finish part (stream mode), as a provider reports its own usage
   *  there (Anthropic's cache_creation split, for one). */
  providerMetadata?: Record<string, Record<string, unknown>>;
  error?: unknown;
  /** Reasoning summary parts, streamed word by word before the text (stream mode). */
  reasoning?: string[];
}

type MockLlmMode = "both" | "generate" | "stream";

interface MockLlmOptions {
  mode?: MockLlmMode;
  provider?: string;
  modelId?: string;
}

interface MockLlmCall {
  mode: "generate" | "stream";
  options: RecordedCallOptions;
}

type MockLLM = LanguageModelV3 & {
  callsMade: number;
  calls: MockLlmCall[];
  generateCalls: RecordedCallOptions[];
  streamCalls: RecordedCallOptions[];
};

type ScriptedStreamEvent =
  | ((LanguageModelV3StreamPart & { delayMs?: number }) | {
    type: "hang";
    delayMs?: number;
  } | {
    type: "controller-error";
    error: unknown;
    delayMs?: number;
  });

/**
 * Test-only LanguageModel that returns scripted responses in order.
 *
 * Usage:
 *   const model = createMockLLM([
 *     { toolCalls: [{ toolCallId: "c1", toolName: "bash", args: { command: "ls" } }],
 *       finishReason: "tool-calls" },
 *     { text: "Done.", finishReason: "stop" }
 *   ]);
 *
 * Each doGenerate/doStream call consumes the next scripted response. Once exhausted,
 * subsequent calls throw.
 */
export function createMockLLM(
  scripted: MockResponse[],
  options: MockLlmOptions = {}
): MockLLM {
  let index = 0;
  const mode = options.mode ?? "both";

  const model: MockLLM = {
    specificationVersion: "v3" as const,
    provider: options.provider ?? "mock",
    modelId: options.modelId ?? "mock-1",
    supportedUrls: {},
    callsMade: 0,
    calls: [],
    generateCalls: [],
    streamCalls: [],

    async doGenerate(callOptions: LanguageModelV3CallOptions): Promise<any> {
      if (mode === "stream") {
        throw new Error("mock LLM is stream-only");
      }
      if (index >= scripted.length) {
        throw new Error(`mock LLM exhausted after ${scripted.length} calls`);
      }
      const r = scripted[index++]!;
      model.callsMade++;
      model.calls.push({ mode: "generate", options: callOptions });
      model.generateCalls.push(callOptions);
      if (r.error) throw r.error;

      const rawFinishReason =
        r.finishReason ?? (r.toolCalls?.length ? "tool-calls" : "stop");

      const content: any[] = [];
      if (r.text) {
        content.push({ type: "text", text: r.text });
      }
      for (const tc of r.toolCalls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }

      const usage = {
        inputTokens: {
          total: r.usage?.promptTokens ?? 100,
          noCache: (r.usage?.promptTokens ?? 100) - (r.usage?.cacheReadTokens ?? 0),
          cacheRead: r.usage?.cacheReadTokens,
          cacheWrite: r.usage?.cacheWriteTokens,
        },
        outputTokens: {
          total: r.usage?.completionTokens ?? 20,
          text: r.usage?.completionTokens ?? 20,
          reasoning: undefined,
        },
      };

      return {
        content,
        finishReason: { unified: rawFinishReason, raw: rawFinishReason },
        usage,
        warnings: [],
      };
    },

    async doStream(callOptions: LanguageModelV3CallOptions): Promise<any> {
      if (mode === "generate") {
        throw new Error("mock LLM is generate-only");
      }
      if (index >= scripted.length) {
        throw new Error(`mock LLM exhausted after ${scripted.length} calls`);
      }
      const r = scripted[index++]!;
      model.callsMade++;
      model.calls.push({ mode: "stream", options: callOptions });
      model.streamCalls.push(callOptions);
      if (r.error) throw r.error;

      const rawFinishReason =
        r.finishReason ?? (r.toolCalls?.length ? "tool-calls" : "stop");

      const usage = {
        inputTokens: {
          total: r.usage?.promptTokens ?? 100,
          noCache: (r.usage?.promptTokens ?? 100) - (r.usage?.cacheReadTokens ?? 0),
          cacheRead: r.usage?.cacheReadTokens,
          cacheWrite: r.usage?.cacheWriteTokens,
        },
        outputTokens: {
          total: r.usage?.completionTokens ?? 20,
          text: r.usage?.completionTokens ?? 20,
          reasoning: undefined,
        },
      };

      const parts: LanguageModelV3StreamPart[] = [];

      parts.push({ type: "stream-start", warnings: [] });

      (r.reasoning ?? []).forEach((summary, index) => {
        // As the OpenAI Responses provider marks them: the item and its encrypted state.
        const id = `rs_mock:${index}`;
        const providerMetadata = { openai: { itemId: "rs_mock", reasoningEncryptedContent: "enc-mock" } };
        parts.push({ type: "reasoning-start", id, providerMetadata });
        for (const word of summary.split(/(?<= )/)) parts.push({ type: "reasoning-delta", id, delta: word });
        parts.push({ type: "reasoning-end", id, providerMetadata });
      });

      if (r.text) {
        const textId = "text-0";
        parts.push({ type: "text-start", id: textId });
        parts.push({ type: "text-delta", id: textId, delta: r.text });
        parts.push({ type: "text-end", id: textId });
      }

      for (const tc of r.toolCalls ?? []) {
        parts.push({
          type: "tool-input-start",
          id: tc.toolCallId,
          toolName: tc.toolName,
        });
        parts.push({
          type: "tool-input-delta",
          id: tc.toolCallId,
          delta: JSON.stringify(tc.args),
        });
        parts.push({ type: "tool-input-end", id: tc.toolCallId });
        parts.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }

      parts.push({
        type: "finish",
        finishReason: { unified: rawFinishReason, raw: rawFinishReason },
        usage,
        ...(r.providerMetadata ? { providerMetadata: r.providerMetadata as never } : {}),
      });

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      });

      return { stream };
    },
  };

  return model;
}

export function createScriptedStreamLLM(
  scripted: ScriptedStreamEvent[][],
  options: MockLlmOptions = {}
): MockLLM {
  let index = 0;

  const model: MockLLM = {
    specificationVersion: "v3" as const,
    provider: options.provider ?? "mock",
    modelId: options.modelId ?? "mock-scripted-stream",
    supportedUrls: {},
    callsMade: 0,
    calls: [],
    generateCalls: [],
    streamCalls: [],

    async doGenerate(): Promise<any> {
      throw new Error("scripted stream LLM is stream-only");
    },

    async doStream(callOptions: LanguageModelV3CallOptions): Promise<any> {
      if (index >= scripted.length) {
        throw new Error(`scripted stream LLM exhausted after ${scripted.length} calls`);
      }
      const script = scripted[index++]!;
      model.callsMade++;
      model.calls.push({ mode: "stream", options: callOptions });
      model.streamCalls.push(callOptions);

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          let done = false;
          const finish = () => {
            done = true;
            callOptions.abortSignal?.removeEventListener("abort", abort);
          };
          const fail = (error: unknown) => {
            if (done) return;
            finish();
            controller.error(error);
          };
          const abort = () => {
            fail(callOptions.abortSignal?.reason ?? new DOMException("Operation aborted.", "AbortError"));
          };

          if (callOptions.abortSignal?.aborted) {
            abort();
            return;
          }
          callOptions.abortSignal?.addEventListener("abort", abort, { once: true });

          void (async () => {
            try {
              for (const event of script) {
                await sleep(event.delayMs ?? 0);
                if (done) return;
                if (event.type === "hang") return;
                if (event.type === "controller-error") {
                  fail(event.error);
                  return;
                }
                controller.enqueue(streamPart(event));
              }
              if (done) return;
              finish();
              controller.close();
            } catch (error) {
              fail(error);
            }
          })();
        }
      });

      return { stream };
    }
  };

  return model;
}

function streamPart(event: LanguageModelV3StreamPart & { delayMs?: number }): LanguageModelV3StreamPart {
  const part: Record<string, unknown> = { ...event };
  delete part.delayMs;
  return part as LanguageModelV3StreamPart;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
