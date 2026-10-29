import { expect, test } from "bun:test";
import { CacheSealLedger } from "../src/server/modules/agent/cache-seal/seal-ledger.js";

// Each model's cache-seal state: active until a seal fails; paused, it keeps
// hour-long marks and lets one seal through as a try on a 1 h → 4 h → 24 h →
// daily schedule; a try that passes both layers resumes it. What a seal finds
// is told with the ticket it started with, so it counts for that seal alone.

const C = "provider-1";
const M = "anthropic/claude-sonnet-5-5";
const HOUR = 3_600_000;
const DAY = 86_400_000;

function ledgerAt(start = 0) {
  const clock = { t: start };
  const ledger = new CacheSealLedger(() => clock.t);
  /** A seal of the model starting now (it must be allowed). */
  const seal = () => {
    const ticket = ledger.startSeal(C, M);
    if (!ticket) throw new Error("no seal allowed now");
    return ticket;
  };
  return { clock, ledger, seal };
}

test("a model is active until it fails: short marks, seals allowed, no pauses", () => {
  const { ledger, seal } = ledgerAt();
  expect([ledger.shortMarks(C, M), ledger.sealAllowed(C, M), ledger.pauses()]).toEqual([true, true, []]);
  const ticket = seal();
  ledger.layer1(ticket, "pass");
  ledger.layer1(seal(), "neutral");
  ledger.layer2(ticket, "pass");
  ledger.layer2(seal(), "excused");
  expect([ledger.shortMarks(C, M), ledger.sealAllowed(C, M), ledger.pauses()]).toEqual([true, true, []]);
});

test("a layer-1 failure pauses at once: hour marks, no seal until the try is due 1 h later", () => {
  const { clock, ledger, seal } = ledgerAt();
  ledger.layer1(seal(), "short_write");
  expect(ledger.shortMarks(C, M)).toBe(false);
  clock.t = HOUR - 1;
  expect([ledger.sealAllowed(C, M), ledger.startSeal(C, M)]).toEqual([false, null]);
  clock.t = HOUR;
  expect(ledger.sealAllowed(C, M)).toBe(true);
  expect(ledger.pauses()).toEqual([{ connection: C, model: M, failure: "short_write", nextTryAt: HOUR }]);
});

test("a try passes only when layer 1 then layer 2 pass; marks stay hour-long until then", () => {
  const { clock, ledger, seal } = ledgerAt();
  ledger.layer1(seal(), "short_write");
  clock.t = HOUR;
  const attempt = seal();
  ledger.layer1(attempt, "pass");
  expect([ledger.shortMarks(C, M), ledger.sealAllowed(C, M)]).toEqual([false, true]);
  ledger.layer2(attempt, "pass");
  expect([ledger.shortMarks(C, M), ledger.sealAllowed(C, M), ledger.pauses()]).toEqual([true, true, []]);
});

test("a layer-2 pass without a passed try does not resume", () => {
  const { clock, ledger, seal } = ledgerAt();
  ledger.layer1(seal(), "short_write");
  clock.t = HOUR;
  ledger.layer2(seal(), "pass");
  expect(ledger.shortMarks(C, M)).toBe(false);
  expect(ledger.pauses()).toHaveLength(1);
});

test("an excused or unjudged try stays open, and its pass is not lent to the next seal", () => {
  const { clock, ledger, seal } = ledgerAt();
  ledger.layer1(seal(), "short_write");
  clock.t = HOUR;
  const first = seal();
  ledger.layer1(first, "pass");
  ledger.layer2(first, "excused");
  expect([ledger.sealAllowed(C, M), ledger.shortMarks(C, M)]).toEqual([true, false]);
  clock.t = HOUR + 10 * HOUR;
  const second = seal();
  ledger.layer1(second, "neutral");
  ledger.layer2(second, "pass");
  expect([ledger.sealAllowed(C, M), ledger.shortMarks(C, M)]).toEqual([true, false]);
  expect(ledger.pauses()).toEqual([{ connection: C, model: M, failure: "short_write", nextTryAt: HOUR }]);
});

test("a seal started while active cannot resume a pause that came after it", () => {
  const { ledger, seal } = ledgerAt();
  const early = seal();
  ledger.layer1(seal(), "short_write");
  ledger.layer1(early, "pass");
  ledger.layer2(early, "pass");
  expect(ledger.shortMarks(C, M)).toBe(false);
  expect(ledger.pauses()).toHaveLength(1);
});

test("a try of an earlier pause cannot end a later one", () => {
  const { clock, ledger, seal } = ledgerAt();
  ledger.layer1(seal(), "short_write");
  clock.t = HOUR;
  const oldTry = seal();
  ledger.layer1(oldTry, "pass");
  ledger.layer1(seal(), "short_write");
  ledger.layer2(oldTry, "pass");
  expect([ledger.shortMarks(C, M), ledger.sealAllowed(C, M)]).toEqual([false, false]);
  expect(ledger.pauses()[0]!.nextTryAt).toBe(HOUR + 4 * HOUR);
});

test("each failure moves the interval along: 1 h, 4 h, 24 h, then daily", () => {
  const { clock, ledger, seal } = ledgerAt();
  const offsets: number[] = [];
  for (let i = 0; i < 4; i++) {
    const at = clock.t;
    ledger.layer1(seal(), "short_write");
    const next = ledger.pauses()[0]!.nextTryAt;
    offsets.push(next - at);
    clock.t = next;
  }
  expect(offsets).toEqual([3_600_000, 14_400_000, 86_400_000, 86_400_000]);
});

test("the count resets after 24 h active without a failure", () => {
  for (const [after, interval] of [[DAY, HOUR], [DAY - 1, 4 * HOUR]] as const) {
    const { clock, ledger, seal } = ledgerAt();
    ledger.layer1(seal(), "short_write");
    clock.t = HOUR;
    const attempt = seal();
    ledger.layer1(attempt, "pass");
    ledger.layer2(attempt, "pass");
    clock.t = HOUR + after;
    ledger.layer1(seal(), "short_write");
    expect(ledger.pauses()[0]!.nextTryAt - clock.t).toBe(interval);
  }
});

test("three failed seal requests in a row pause with errors; a success in between resets the streak", () => {
  const { ledger, seal } = ledgerAt();
  ledger.sendFailed(seal());
  ledger.sendFailed(seal());
  ledger.sendSucceeded(seal());
  ledger.sendFailed(seal());
  ledger.sendFailed(seal());
  expect(ledger.pauses()).toEqual([]);
  ledger.sendFailed(seal());
  expect(ledger.pauses()).toEqual([{ connection: C, model: M, failure: "errors", nextTryAt: HOUR }]);
});

test("a try whose request fails again is the next failure: the interval moves on", () => {
  const { clock, ledger, seal } = ledgerAt();
  for (let i = 0; i < 3; i++) ledger.sendFailed(seal());
  clock.t = HOUR;
  ledger.sendFailed(seal());
  expect(ledger.pauses()).toEqual([{ connection: C, model: M, failure: "errors", nextTryAt: HOUR + 4 * HOUR }]);
  expect(ledger.sealAllowed(C, M)).toBe(false);
});

test("a layer-2 failure pauses with its own reason", () => {
  for (const reason of ["prefix_changed", "not_read"] as const) {
    const { ledger, seal } = ledgerAt();
    ledger.layer2(seal(), reason);
    expect(ledger.pauses().map((p) => p.failure)).toEqual([reason]);
    expect(ledger.shortMarks(C, M)).toBe(false);
  }
});

test("an output failure keeps its token count for the note", () => {
  const { ledger, seal } = ledgerAt();
  ledger.layer1(seal(), "output", 120);
  expect(ledger.pauses()).toEqual([{ connection: C, model: M, failure: "output", nextTryAt: HOUR, outputTokens: 120 }]);
});

test("models are kept apart by connection and model", () => {
  const { ledger, seal } = ledgerAt();
  ledger.layer1(seal(), "short_write");
  expect([ledger.shortMarks(C, M), ledger.shortMarks("kilo", M), ledger.shortMarks(C, "anthropic/claude-opus-5-5")]).toEqual([false, true, true]);
  expect(ledger.pauses()).toHaveLength(1);
});

// One incident is one failure: seals already out when the model paused (the
// other quiet threads' seals of that moment) find the same fault, and a try
// of a pause the model has left is out of date too.
test("seals that were out when the model paused do not count again: the try is still 1 h away", () => {
  const { clock, ledger, seal } = ledgerAt();
  const out = [seal(), seal(), seal()];
  for (const ticket of out) ledger.layer1(ticket, "short_write");
  expect(ledger.pauses()).toEqual([{ connection: C, model: M, failure: "short_write", nextTryAt: HOUR }]);
  ledger.layer2(out[0]!, "not_read");
  for (const ticket of out) ledger.sendFailed(ticket);
  expect(ledger.pauses()).toEqual([{ connection: C, model: M, failure: "short_write", nextTryAt: HOUR }]);
  clock.t = HOUR;
  // Their failed requests are not in the count either: a try's one failed
  // request is the first of three, not the fourth.
  ledger.sendFailed(seal());
  expect(ledger.pauses()).toEqual([{ connection: C, model: M, failure: "short_write", nextTryAt: HOUR }]);
  ledger.layer1(seal(), "short_write");
  expect(ledger.pauses()).toEqual([{ connection: C, model: M, failure: "short_write", nextTryAt: HOUR + 4 * HOUR }]);
});

test("a try of the pause that fails after another try resumed the model does not pause it again", () => {
  const { clock, ledger, seal } = ledgerAt();
  ledger.layer1(seal(), "short_write");
  clock.t = HOUR;
  const [first, second] = [seal(), seal()];
  ledger.layer1(first, "pass");
  ledger.layer1(second, "pass");
  ledger.layer2(first, "pass");
  expect(ledger.shortMarks(C, M)).toBe(true);
  ledger.layer2(second, "not_read");
  expect([ledger.shortMarks(C, M), ledger.pauses()]).toEqual([true, []]);
});
