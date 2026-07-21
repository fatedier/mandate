export interface BargeInState {
  responseInFlight: boolean;
  currentResponseItemId: string | null;
  audioMsSentForResponse: number;
}

export type BargeInDecision =
  | { kind: "noop" }
  | { kind: "cancel-only" }
  | { kind: "cancel-and-truncate"; itemId: string; audioEndMs: number };

/** Subtracted from the server's "ms of audio sent" to approximate what the
 *  user actually heard. Accounts for the client's typical playback buffer
 *  depth (Web Audio scheduling lookahead + small queue). */
export const JITTER_OFFSET_MS = 250;

/** Pure: given response state at the moment `speech_started` fires, decide
 *  what to do. Three cases:
 *  - no response in flight → nothing to interrupt
 *  - in flight but assistant item id not yet seen → cancel only (cannot
 *    truncate a non-existent item)
 *  - in flight with item id → cancel + truncate to (sent - JITTER_OFFSET_MS),
 *    floored at 0 */
export function decideBargeIn(state: BargeInState): BargeInDecision {
  if (!state.responseInFlight) return { kind: "noop" };
  if (state.currentResponseItemId === null) return { kind: "cancel-only" };
  const audioEndMs = Math.max(0, state.audioMsSentForResponse - JITTER_OFFSET_MS);
  return {
    kind: "cancel-and-truncate",
    itemId: state.currentResponseItemId,
    audioEndMs
  };
}
