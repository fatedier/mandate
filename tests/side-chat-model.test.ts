import { expect, test } from "bun:test";
import type { WakeLlmCandidate } from "../src/server/modules/agent/wake-llm-attempts.js";

const FIRST = { candidateIndex: 0, attempt: 1, hasNext: false };

test("a side call is timed on the clock it is given", async () => {
  const { createMockLLM } = await import("./helpers/mock-llm.js");
  const { sideChatModelCall } = await import("../src/server/modules/side-chat/side-chat-model.js");
  const finished: number[] = [];
  const times = [1_000, 1_250];
  const call = sideChatModelCall(() => times.shift() ?? 9_999);
  const model = createMockLLM([{ text: "Hi.", finishReason: "stop" }]);
  const timed = {
    model, meta: { provider: "mock", model: "mock-1" },
    llmCallRecorder: { startCall: () => "c1", finishCall: (_id: string, input: { latencyMs?: number }) => { finished.push(input.latencyMs ?? -1); } }
  } as unknown as WakeLlmCandidate;
  const prompt = { tools: {}, system: "SYSTEM", systemContent: "SYSTEM" } as never;
  const reply = await call({ candidate: timed, prompt, messages: [{ role: "user", content: "Hi?" }], threadId: "thr_g", signal: new AbortController().signal, at: FIRST });
  expect(reply.text).toBe("Hi.");
  expect(finished).toEqual([250]);
});

test("a side call is recorded for its usage only: no request, answer or response text", async () => {
  const { createMockLLM } = await import("./helpers/mock-llm.js");
  const { sideChatModelCall } = await import("../src/server/modules/side-chat/side-chat-model.js");
  const started: Array<Record<string, unknown>> = [];
  const finished: Array<Record<string, unknown>> = [];
  const call = sideChatModelCall(() => 0);
  const model = createMockLLM([{ text: "The install script stays.", finishReason: "stop" }]);
  const recorded = {
    model, meta: { provider: "mock", model: "mock-1" },
    llmCallRecorder: { startCall: (input: Record<string, unknown>) => { started.push(input); return "c1"; }, finishCall: (_id: string, input: Record<string, unknown>) => { finished.push(input); } }
  } as unknown as WakeLlmCandidate;
  const prompt = { tools: {}, system: "SYSTEM", systemContent: "SYSTEM" } as never;
  await call({ candidate: recorded, prompt, messages: [{ role: "user", content: "What about the install script?" }], threadId: "thr_g", signal: new AbortController().signal, at: FIRST });
  expect(started[0]!.requestPayload).toBeUndefined();
  expect(started[0]!.purpose).toBe("side_chat");
  const kept = JSON.stringify(finished[0]);
  expect(kept).not.toContain("install script");
  expect(Object.keys(finished[0]!.result as object).sort()).toEqual(expect.arrayContaining(["totalUsage", "usage"]));
});

test("a cost the gateway reports stays with the record; the words do not", async () => {
  const { usageOf } = await import("../src/server/modules/side-chat/side-chat-model.js");
  const kept = usageOf({
    text: "The install script stays.", usage: { inputTokens: 10 }, totalUsage: { inputTokens: 10 }, finishReason: "stop", firstOutputMs: 12,
    response: { headers: { "x-litellm-response-cost": "0.0042" }, messages: [{ role: "assistant", content: "The install script stays." }], body: "The install script stays." }
  } as never);
  expect((kept.response as { headers?: Record<string, string> }).headers).toEqual({ "x-litellm-response-cost": "0.0042" });
  expect(JSON.stringify(kept)).not.toContain("install script");
});

test("a side call on a fallback, or a retry, is marked so in its record, as a step's is", async () => {
  const { createMockLLM } = await import("./helpers/mock-llm.js");
  const { sideChatModelCall } = await import("../src/server/modules/side-chat/side-chat-model.js");
  const started: Array<Record<string, unknown>> = [];
  const call = sideChatModelCall(() => 0);
  const candidate = () => ({
    model: createMockLLM([{ text: "Kept.", finishReason: "stop" }]), meta: { provider: "mock", model: "mock-1" },
    llmCallRecorder: { startCall: (input: Record<string, unknown>) => { started.push(input); return "c1"; }, finishCall: () => {} }
  }) as unknown as WakeLlmCandidate;
  const prompt = { tools: {}, system: "SYSTEM", systemContent: "SYSTEM" } as never;
  const ask = (at: { candidateIndex: number; attempt: number; hasNext: boolean }) =>
    call({ candidate: candidate(), prompt, messages: [{ role: "user", content: "Anything new?" }], threadId: "thr_g", signal: new AbortController().signal, at });
  await ask({ candidateIndex: 0, attempt: 1, hasNext: true });
  await ask({ candidateIndex: 1, attempt: 1, hasNext: false });
  expect(started.map((s) => (s.metadata as { fallbackAttempt?: boolean }).fallbackAttempt ?? null)).toEqual([null, true]);
  expect(started.map((s) => (s.metadata as { model?: string }).model)).toEqual(["mock-1", "mock-1"]);
});
