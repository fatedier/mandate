import { expect, test } from "bun:test";
import { createLlmStreamDiagnostics } from "../src/server/modules/agent/wake-loop.js";

/**
 * Time to first token is the one figure on the Activity page that cannot be
 * derived after the fact, so what counts as "first" is the whole of it.
 *
 * The stream opens with parts the SDK emits locally the moment the request goes
 * out — `start`, then `start-step`. On the real store the first part of any kind
 * landed 14.9ms in, against a mean call of 11 seconds: that number measures our
 * own dispatch and says nothing about the provider. The first part that carries
 * model output is the one worth recording.
 */

function diagnostics(startedAt: number) {
  return createLlmStreamDiagnostics({
    startedAt,
    callId: "llm_test",
    wakeId: "wake_test",
    candidateIndex: 0,
    attempt: 1,
    provider: "codex",
    model: "gpt-5.5",
    idleTimeoutMs: 90_000
  });
}

test("the lifecycle parts the SDK emits locally do not count as a first token", () => {
  const diag = diagnostics(Date.now());
  for (const type of ["start", "start-step"]) diag.recordPart({ type }, true, false);
  // Nothing from the provider yet, so there is no reading — not a zero, which
  // would report an instant answer.
  expect(diag.ttftMs()).toBeNull();

  diag.recordPart({ type: "reasoning-start" }, true, false);
  expect(diag.ttftMs()).not.toBeNull();
});

test("the reading is the first model part, and later parts do not move it", async () => {
  const started = Date.now() - 5_000;
  const diag = diagnostics(started);
  diag.recordPart({ type: "start" }, true, false);
  diag.recordPart({ type: "text-start" }, true, false);
  const first = diag.ttftMs();

  // Real time before the later parts. A stream delivers its deltas over
  // seconds, and without that gap here every part carries the same elapsed
  // reading — so an accumulator that kept overwriting would look identical to
  // one that kept the first.
  await Bun.sleep(12);
  diag.recordPart({ type: "text-delta" }, true, true);
  diag.recordPart({ type: "finish" }, false, false);

  // Around five seconds, and unchanged by everything after it. Asserted as a
  // range because the clock runs during the test; the point is that it tracks
  // the start of the call rather than the end.
  expect(first).toBeGreaterThanOrEqual(5_000);
  expect(first).toBeLessThan(5_500);
  expect(diag.ttftMs()).toBe(first);
});

test("a call the provider never answered has no reading at all", () => {
  const diag = diagnostics(Date.now());
  diag.recordPart({ type: "start" }, true, false);
  diag.recordPart({ type: "start-step" }, true, false);
  diag.recordPart({ type: "error" }, false, false);
  expect(diag.ttftMs()).toBeNull();
  // And the summary agrees with the accessor, since one goes to a column and
  // the other to metadata and they must not disagree about the same call.
  expect(diag.summary("failed").firstModelDataAtMs).toBeNull();
});

test("tool-only calls report a first token too", () => {
  // Two thirds of the calls on the real store emit no text at all: the model
  // answers with a tool call. Anything keyed on text-delta would leave those
  // with no reading, which is most of the window.
  const diag = diagnostics(Date.now());
  diag.recordPart({ type: "start" }, true, false);
  diag.recordPart({ type: "start-step" }, true, false);
  diag.recordPart({ type: "tool-input-start" }, true, false);
  expect(diag.ttftMs()).not.toBeNull();
});

test("the first token is not the first part", async () => {
  // The two numbers travel together in metadata, and the older one is the trap:
  // it looks like a time to first token and is a measure of our own dispatch.
  // Real elapsed time between them, because that gap is the whole claim — with
  // both parts recorded in one millisecond the two fields agree by accident and
  // the assertion proves nothing.
  const diag = diagnostics(Date.now());
  diag.recordPart({ type: "start" }, true, false);
  await Bun.sleep(12);
  diag.recordPart({ type: "text-start" }, true, false);

  const summary = diag.summary("succeeded");
  expect(summary.firstPartAtMs as number).toBeLessThan(summary.firstModelDataAtMs as number);
  expect(summary.firstModelDataAtMs as number).toBeGreaterThanOrEqual(10);
});
