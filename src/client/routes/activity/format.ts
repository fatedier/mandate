import { sharePercent } from "./activity-model";

export function providerNameForCall(call: { metadata: unknown; matchedProviderName?: string }): string {
  const name = call.metadata && typeof call.metadata === "object"
    ? (call.metadata as Record<string, unknown>).providerName
    : undefined;
  return (typeof name === "string" ? name.trim() : "") || call.matchedProviderName || "";
}

/**
 * How long a call has been going, which is not always how long it took.
 *
 * A finished call carries its own `latency_ms`. A running one does not — it
 * has a start and no end — so the elapsed time is measured against a clock the
 * caller passes in. The log row passes the moment the page loaded rather than
 * `Date.now()`: the page refreshes on request, and a duration that advanced on
 * its own would be the only figure on screen claiming to be current.
 */
export function durationMsForCall(
  call: {
    status: string;
    startedAt: string | null;
    createdAt: string;
    latencyMs: number | null;
  },
  nowMs: number
): number | null {
  if (call.status !== "running" && call.status !== "pending") return call.latencyMs;
  const startedMs = Date.parse(call.startedAt || call.createdAt);
  if (!Number.isFinite(startedMs)) return call.latencyMs;
  return Math.max(0, nowMs - startedMs);
}

export interface TokenPart {
  label: string;
  value: number;
  /** Of the group's own total, one decimal. Null when the total is zero. */
  share: number | null;
}

export interface TokenGroup {
  label: string;
  value: number;
  /** The portion of `value` that this group's second reading accounts for.
   *  Absent when the provider reported none, or reported zero. */
  part?: TokenPart;
}

/**
 * A call's token counts, as the two containments they are.
 *
 * `cacheReadTokens` is the cached portion of `inputTokens` and
 * `reasoningTokens` the thinking portion of `outputTokens` — measured across
 * 32,352 calls with no exception either way. Rendering the four as peers joined
 * by a separator hides that, and hides the reading that actually matters: on a
 * typical wake 96% of the input was cached.
 *
 * The part is dropped when zero. Every call has an input and an output, so
 * those two are readings; the other two are only present when something used
 * them, and a `0%` share would claim a measurement the provider never made.
 */
export function tokenBreakdown(call: {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
}): TokenGroup[] {
  const groups: TokenGroup[] = [];
  const add = (label: string, whole: number | null, partLabel: string, part: number | null) => {
    if (whole == null) return;
    groups.push({
      label,
      value: whole,
      ...(part ? { part: { label: partLabel, value: part, share: sharePercent(part, whole) } } : {})
    });
  };
  add("input", call.inputTokens, "cached", call.cacheReadTokens);
  add("output", call.outputTokens, "reasoning", call.reasoningTokens);
  return groups;
}

/**
 * The exact count, grouped.
 *
 * Not `formatTokenCount`, which rounds to `25.4k` so a fixed-width column can
 * hold it. A reader who has opened one call is asking what that call did, and
 * `25,412` costs three characters in a panel with room for them. Pinned to
 * en-US because the UI is English; the browser locale would otherwise decide
 * the separator per machine.
 */
export function formatExactTokens(value: number): string {
  return value.toLocaleString("en-US");
}
