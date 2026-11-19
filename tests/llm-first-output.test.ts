import { expect, jest, test } from "bun:test";
import { firstOutputClock, firstOutputOf } from "../src/server/modules/llm/first-output.js";
import { callTextModelForProvider } from "../src/server/modules/llm/text-model.js";
import { fakeClock } from "./helpers/fake-clock.js";

// Time to first token for the calls outside the wake loop (the dream, memory
// extraction, a compaction, a seal, a chat judgement, a model search): the
// first part the provider sent, timed from the request, as the wake loop's is.

test("a stream's first output is the first part the provider sent, timed from the request; the SDK's own parts and later parts do not move it", () => {
  let now = 1_000;
  const clock = firstOutputClock(() => now);
  for (const type of ["start", "start-step", "finish-step"]) {
    now += 5;
    clock.note(type);
  }
  // A provider's raw frame (response.created) carries no output of itself.
  now += 40;
  clock.note("raw");
  // Nothing from the provider yet: no reading, not a zero.
  expect(clock.ms()).toBeNull();
  now = 2_250;
  clock.note("reasoning-delta");
  now = 4_000;
  clock.note("text-delta");
  clock.note("finish");
  expect(clock.ms()).toBe(1_250);
});

test("what a call's result or error carries of its first output is read back, and nothing else is", () => {
  expect(firstOutputOf({ text: "ok", firstOutputMs: 900 })).toBe(900);
  expect(firstOutputOf(Object.assign(new Error("dropped"), { firstOutputMs: 40 }))).toBe(40);
  for (const value of [{ firstOutputMs: null }, { firstOutputMs: "900" }, {}, null, undefined, "text"]) expect(firstOutputOf(value)).toBeNull();
});

const history = [{ role: "user" as const, content: "Summarize the release notes thread." }];
async function moveOn(ms: number) {
  for (let i = 0; i < 100; i++) await Promise.resolve();
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** A model that starts its answer after `delayMs`, on the test's clock. */
function lateModel(delayMs: number) {
  return {
    specificationVersion: "v4" as const, provider: "late.chat", modelId: "late-1", supportedUrls: {},
    doGenerate: async () => { throw new Error("streams only"); },
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "the gist" });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
          controller.close();
        }
      })
    })
  };
}

test("a text model call carries the time to its first output; one that fails before any carries none", async () => {
  fakeClock();
  const call = callTextModelForProvider("openai-compatible", { model: lateModel(1_500) as never, messages: history });
  let result: { firstOutputMs: number | null } | null = null;
  void call.then((r) => { result = r; });
  await moveOn(1_500);
  for (let i = 0; i < 20 && !result; i++) await moveOn(0);
  expect(result!.firstOutputMs).toBe(1_500);

  // The request refused before the provider sent anything.
  const refused = await callTextModelForProvider("openai-compatible", {
    model: { ...lateModel(0), doStream: async () => { throw new Error("refused"); } } as never, messages: history
  }).catch((error: unknown) => error);
  expect(firstOutputOf(refused)).toBeNull();
});
