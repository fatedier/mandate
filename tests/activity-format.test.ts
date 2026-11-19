import { expect, test } from "bun:test";
import {
  durationMsForCall,
  tokenBreakdown
} from "../src/client/routes/activity/format.js";

test("durationMsForCall uses startedAt for running calls", () => {
  expect(durationMsForCall({
    status: "running",
    startedAt: "2026-05-25T00:00:00.000Z",
    createdAt: "2026-05-24T23:59:00.000Z",
    latencyMs: null
  }, Date.parse("2026-05-25T00:01:30.000Z"))).toBe(90_000);
});

test("durationMsForCall uses persisted latency for completed calls", () => {
  expect(durationMsForCall({
    status: "succeeded",
    startedAt: "2026-05-25T00:00:00.000Z",
    createdAt: "2026-05-25T00:00:00.000Z",
    latencyMs: 1234
  }, Date.parse("2026-05-25T00:01:30.000Z"))).toBe(1234);
});

test("tokenBreakdown pairs each whole with the part it contains", () => {
  // cache is the cached portion of input and reasoning the thinking portion of
  // output — each counted inside its whole, never beside it. The
  // shares are of the group's own whole, not of some grand total.
  expect(tokenBreakdown({
    inputTokens: 25_412,
    outputTokens: 200,
    reasoningTokens: 139,
    cacheReadTokens: 22_016
  })).toEqual([
    { label: "input", value: 25_412, part: { label: "cached", value: 22_016, share: 86.6 } },
    { label: "output", value: 200, part: { label: "reasoning", value: 139, share: 69.5 } }
  ]);
});

test("tokenBreakdown drops a part the provider never reported", () => {
  // A zero share would claim a measurement that was never taken. in/out stay,
  // because those are readings even at zero.
  expect(tokenBreakdown({
    inputTokens: 15_357,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0
  })).toEqual([
    { label: "input", value: 15_357 },
    { label: "output", value: 0 }
  ]);
});

test("tokenBreakdown answers nothing for a call that recorded nothing", () => {
  expect(tokenBreakdown({
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null
  })).toEqual([]);
});
