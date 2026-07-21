import { expect, test } from "bun:test";
import { decideBargeIn, JITTER_OFFSET_MS } from "../src/server/modules/voice/voice-barge-in.js";

test("decideBargeIn: noop when no response in flight", () => {
  const r = decideBargeIn({
    responseInFlight: false,
    currentResponseItemId: null,
    audioMsSentForResponse: 0
  });
  expect(r).toEqual({ kind: "noop" });
});

test("decideBargeIn: noop even when itemId is set if responseInFlight is false", () => {
  const r = decideBargeIn({
    responseInFlight: false,
    currentResponseItemId: "item_123",
    audioMsSentForResponse: 1000
  });
  expect(r).toEqual({ kind: "noop" });
});

test("decideBargeIn: cancel-only when in flight but item id not yet known", () => {
  const r = decideBargeIn({
    responseInFlight: true,
    currentResponseItemId: null,
    audioMsSentForResponse: 0
  });
  expect(r).toEqual({ kind: "cancel-only" });
});

test("decideBargeIn: cancel-and-truncate subtracts jitter offset", () => {
  const r = decideBargeIn({
    responseInFlight: true,
    currentResponseItemId: "item_abc",
    audioMsSentForResponse: 1500
  });
  expect(r).toEqual({
    kind: "cancel-and-truncate",
    itemId: "item_abc",
    audioEndMs: 1500 - JITTER_OFFSET_MS
  });
});

test("decideBargeIn: audioEndMs clamped to 0 when sent < jitter offset", () => {
  const r = decideBargeIn({
    responseInFlight: true,
    currentResponseItemId: "item_abc",
    audioMsSentForResponse: 100
  });
  expect(r).toEqual({
    kind: "cancel-and-truncate",
    itemId: "item_abc",
    audioEndMs: 0
  });
});

test("decideBargeIn: JITTER_OFFSET_MS is 250", () => {
  expect(JITTER_OFFSET_MS).toBe(250);
});
