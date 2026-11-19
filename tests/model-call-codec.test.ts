import { afterEach, expect, test } from "bun:test";
import { APICallError, TypeValidationError } from "@ai-sdk/provider";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { MandateStore } from "../src/server/app/store.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { decodeError, decodePrompt, encodeError, encodePrompt } from "../src/server/modules/agent/model-call-codec.js";
import { openAttemptStreamState, requestBodyOf, streamModelOnce } from "../src/server/modules/agent/model-stream.js";
import { isReasoningSummaryRefusal } from "../src/server/modules/llm/reasoning.js";
import { isCyberPolicyLlmError, isInputRejectedLlmError, isNonFallbackLlmError, isRetryableLlmError, isTimeoutLlmError } from "../src/server/modules/llm/retry-policy.js";
import { getLogLevel, setLogLevel } from "../src/server/platform/logger.js";
import { mockFetch } from "./helpers/fetch.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { tempDir } from "./helpers/temp.js";
import { testStore } from "./helpers/test-store.js";

// An error or a prompt that crosses to another thread arrives as it left:
// whatever the retry policy, the summary check and Activity's record read of
// an error reads the same; a prompt's URLs are URLs again.

const across = <T>(value: T, encode: (v: T) => unknown, decode: (v: unknown) => T): T => decode(structuredClone(encode(value)));

function errors(): Array<[string, unknown]> {
  const refusal = new APICallError({
    message: "Invalid value: 'auto'.", url: "https://gateway.example/v1/responses",
    requestBodyValues: { model: "m", reasoning: { effort: "high", summary: "auto" }, input: [{ role: "user", content: "hi" }] },
    statusCode: 400, responseHeaders: { "x-request-id": "req_1" },
    responseBody: JSON.stringify({ error: { message: "Invalid value: 'auto'.", type: "invalid_request_error", param: "reasoning.summary" } }),
    isRetryable: false, data: { error: { param: "reasoning.summary", type: "invalid_request_error" } }
  });
  const overloaded = new APICallError({ message: "Overloaded", url: "https://a.example/v1/messages", requestBodyValues: { model: "c" }, statusCode: 529, isRetryable: true, responseBody: "{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}" });
  const wrapped = Object.assign(new Error("The provider ended the response with an error", { cause: overloaded }), {
    facts: { reportedCostUsd: 0.0123, cacheWrite1hTokens: 640, serviceTier: "priority" },
    usageSoFar: { promptTokens: 1200, completionTokens: 40 },
    firstOutputMs: 812
  });
  const timeout = new DOMException("LLM stream timed out waiting for activity after 120000ms.", "TimeoutError");
  const cyber = Object.assign(new Error("Request flagged"), { code: "cyber_policy", status: 400 });
  // The SDK's error for a malformed frame or tool input wraps zod's, whose
  // message is a getter of its own.
  const invalidFrame = new TypeValidationError({ value: { type: "delta", text: 1 }, cause: z.object({ text: z.string() }).safeParse({ text: 1 }).error });
  return [["summary refusal", refusal], ["invalid frame with a zod cause", invalidFrame], ["wrapped overload with stream facts", wrapped], ["idle timeout", timeout], ["cyber policy", cyber], ["plain", new Error("socket hang up")], ["string", "boom"], ["null", null]];
}

const verdicts = (e: unknown) => ({
  retryable: isRetryableLlmError(e), timeout: isTimeoutLlmError(e), nonFallback: isNonFallbackLlmError(e),
  inputRejected: isInputRejectedLlmError(e), cyber: isCyberPolicyLlmError(e), summaryRefusal: isReasoningSummaryRefusal(e),
  requestBody: requestBodyOf(e)
});

test("the retry policy, the summary check and the request body read an error the same after crossing", () => {
  for (const [label, error] of errors()) {
    expect([label, verdicts(across(error, encodeError, decodeError))]).toEqual([label, verdicts(error)]);
  }
});

let restoreLevel: string | null = null;
afterEach(() => { if (restoreLevel) setLogLevel(restoreLevel); restoreLevel = null; });

/** The row Activity keeps for a failed call, without what differs between
 *  two calls (id, times). Each call is a row of its own, so one store serves
 *  every comparison: a store's start-up builds every module's tables. */
function storedFailure(store: MandateStore, error: unknown) {
  const recorder = new AgentLlmCallRecorder({ store, logRequests: "metadata", provider: "anthropic", model: "c", baseURL: "", apiMode: "streamText" });
  const id = recorder.startCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: "thr_1" });
  recorder.finishCall(id, { status: "failed", error, metadata: {}, ttftMs: null, latencyMs: 10 });
  const row = store.db.prepare("select * from llm_calls where id = ?").get(id) as Record<string, unknown>;
  const { id: _id, created_at: _c, updated_at: _u, finished_at: _f, started_at: _s, ...rest } = row;
  return rest;
}

test("Activity stores the same failed call for an error that crossed, at the normal and the debug log level", () => {
  restoreLevel = getLogLevel();
  const store = testStore(tempDir("md-codec-recorder-"));
  try {
    for (const level of ["info", "debug"]) {
      setLogLevel(level);
      for (const [label, error] of errors()) {
        const crossed = across(error, encodeError, decodeError);
        expect([level, label, storedFailure(store, crossed)]).toEqual([level, label, storedFailure(store, error)]);
      }
    }
  } finally {
    store.db.close();
  }
});

test("a decoded error is an Error with the original's name, message and stack", () => {
  const [, refusal] = errors()[0]!;
  const crossed = across(refusal, encodeError, decodeError) as Error;
  expect(crossed).toBeInstanceOf(Error);
  expect([crossed.name, crossed.message, crossed.stack]).toEqual([(refusal as Error).name, (refusal as Error).message, (refusal as Error).stack]);
  expect(Object.keys(crossed).sort()).toEqual(Object.keys(refusal as object).sort());
});

test("a cyclic error crosses without hanging", () => {
  const loop: Record<string, unknown> = { message: "loop" };
  loop.self = loop;
  const error = Object.assign(new Error("cyclic"), { data: loop });
  expect((across(error, encodeError, decodeError) as Error).message).toBe("cyclic");
});

test("a prompt's URL parts are URLs again, and the SDK reads them as before", async () => {
  const messages: ModelMessage[] = [
    { role: "user", content: [
      { type: "text", text: "What is in these?" },
      { type: "image", image: new URL("https://img.example/a.png") },
      { type: "file", data: new URL("data:text/plain;base64,aGVsbG8="), mediaType: "text/plain" },
      { type: "image", image: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" }
    ] },
    { role: "assistant", content: [{ type: "text", text: "ok" }], providerOptions: { openai: { reasoningSummary: null } } }
  ];
  const crossed = across(messages, encodePrompt, decodePrompt);
  const user = crossed[0]!.content as Array<Record<string, unknown>>;
  expect([user[1]!.image instanceof URL, user[2]!.data instanceof URL, user[3]!.image instanceof Uint8Array]).toEqual([true, true, true]);
  expect(crossed[1]!.providerOptions).toEqual({ openai: { reasoningSummary: null } });
  // What the model is handed for each: the SDK downloads a URL the model
  // does not take, inlines a data: URL, and passes bytes on.
  mockFetch(() => new Response(new Uint8Array([137, 80, 78, 71, 13, 10]), { headers: { "content-type": "image/png" } }));
  const sent = async (prompt: ModelMessage[]) => {
    const model = createMockLLM([{ text: "ok", finishReason: "stop" }]);
    const state = openAttemptStreamState({ model, timeout: {}, idleMs: 60_000, diagnostics: { startedAt: 0, callId: null, wakeId: "w", candidateIndex: 0, attempt: 1, idleTimeoutMs: 60_000 } });
    try {
      await streamModelOnce({ model, messages: prompt, callOptions: { providerOptions: undefined, headers: undefined, reasoning: undefined }, askSummary: false }, state, { onReasoning() {}, onHeading() {}, onTextDelta() {} });
    } finally {
      state.idle.cleanup();
    }
    return model.streamCalls[0]!.prompt;
  };
  expect(await sent(crossed)).toEqual(await sent(messages));
});
