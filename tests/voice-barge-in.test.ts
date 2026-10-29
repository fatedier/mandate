import { expect, test } from "bun:test";
import { decideBargeIn, JITTER_OFFSET_MS } from "../src/server/modules/voice/voice-barge-in.js";

interface BargeInCase {
  name: string;
  responseInFlight: boolean;
  currentResponseItemId: string | null;
  audioMsSentForResponse: number;
  decision: ReturnType<typeof decideBargeIn>;
}

const cases: BargeInCase[] = [
  {
    name: "noop when no response in flight",
    responseInFlight: false, currentResponseItemId: null, audioMsSentForResponse: 0,
    decision: { kind: "noop" }
  },
  {
    name: "noop even when itemId is set if responseInFlight is false",
    responseInFlight: false, currentResponseItemId: "item_123", audioMsSentForResponse: 1000,
    decision: { kind: "noop" }
  },
  {
    name: "cancel-only when in flight but item id not yet known",
    responseInFlight: true, currentResponseItemId: null, audioMsSentForResponse: 0,
    decision: { kind: "cancel-only" }
  },
  {
    name: "cancel-and-truncate subtracts jitter offset",
    responseInFlight: true, currentResponseItemId: "item_abc", audioMsSentForResponse: JITTER_OFFSET_MS + 1500,
    decision: { kind: "cancel-and-truncate", itemId: "item_abc", audioEndMs: 1500 }
  },
  {
    name: "audioEndMs clamped to 0 when sent < jitter offset",
    responseInFlight: true, currentResponseItemId: "item_abc", audioMsSentForResponse: JITTER_OFFSET_MS - 1,
    decision: { kind: "cancel-and-truncate", itemId: "item_abc", audioEndMs: 0 }
  }
];

test.each(cases)("decideBargeIn: $name", ({ responseInFlight, currentResponseItemId, audioMsSentForResponse, decision }) => {
  expect(decideBargeIn({ responseInFlight, currentResponseItemId, audioMsSentForResponse })).toEqual(decision);
});
