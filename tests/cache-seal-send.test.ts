import { expect, test } from "bun:test";
import { createSealSender } from "../src/server/modules/agent/cache-seal/send-seal.js";
import type { WakeLlmCandidate } from "../src/server/modules/agent/wake-llm-attempts.js";

// A seal's request is bounded in time, as a wake step's is: one that the
// provider accepts and then never finishes is a failed request, counted by
// the safety net, not a promise left open.

/** A model that takes the request and never answers. */
const stalled = {
  specificationVersion: "v3",
  provider: "anthropic.messages",
  modelId: "anthropic/claude-sonnet-x",
  supportedUrls: {},
  doGenerate: async () => { throw new Error("not used"); },
  doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
    stream: new ReadableStream({
      start(controller) { abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason)); }
    })
  })
};

test("a seal the provider never finishes fails at its timeout", async () => {
  const candidate = { model: stalled as never, meta: { provider: "anthropic", providerName: "gw", model: "anthropic/claude-sonnet-x" } } as WakeLlmCandidate;
  const send = createSealSender({ recorderFor: () => null, threadScope: () => "manager", now: () => Date.now(), timeout: { totalMs: 50 } });
  const started = Date.now();
  const result = await send({ threadId: "thr_a", candidate, system: "You manage the release.", tools: {}, messages: [{ role: "user", content: [{ type: "text", text: "." }] }] });
  expect(result.ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(5_000);
});
