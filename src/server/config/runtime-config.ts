import { DEFAULT_SSE_HEARTBEAT_MS } from "../../shared/api/sse.js";
import type { RuntimeConfig } from "./types.js";

/** The background jobs' pacing, from config.json's `runtime`, read at start.
 *  Each default is the pace the server has always kept; each floor is the
 *  least the file may give (file-check.ts refuses less, and more than a
 *  timer can wait), so no job runs so often, or so soon after start, that
 *  the server spends itself on it. Not shown in Settings: tuning, not a
 *  choice a user makes (a test runs the same scheduling on short times). */
export const RUNTIME_PACES: Record<keyof RuntimeConfig, { default: number; floor: number }> = {
  pricingPassEveryMs: { default: 5_000, floor: 100 },
  /** How often the schedules are looked at for one that is due. */
  scheduleTickMs: { default: 5_000, floor: 100 },
  /** What came due while the server was down runs from one tick after the
   *  start, one schedule this far apart: no burst of checks and wakes. */
  scheduleBootStaggerMs: { default: 5_000, floor: 0 },
  dreamCheckEveryMs: { default: 300_000, floor: 1_000 },
  /** Price data: first refreshed a while after the start, then daily. */
  priceDataFirstMs: { default: 600_000, floor: 1_000 },
  priceDataEveryMs: { default: 86_400_000, floor: 60_000 },
  retentionEveryMs: { default: 3_600_000, floor: 60_000 },
  /** Often enough that a few messages at most come in between, each merge
   *  at most 20 ms (mergeHistoryWords). */
  historyWordsMergeEveryMs: { default: 10_000, floor: 100 },
  /** The memory vectors are loaded this long after a start, a few at a time,
   *  so the first search after a restart does not read them all at once. */
  memoryVectorsWarmMs: { default: 20_000, floor: 0 },
  /** A checkpoint that finds nothing new to copy costs nothing; one that
   *  does copies at most this long's writes. */
  checkpointEveryMs: { default: 30_000, floor: 1_000 },
  /** How often the Activity slices are looked at for hours to work out
   *  ahead: a look that finds none reads no call. */
  activitySlicesCheckEveryMs: { default: 30_000, floor: 1_000 },
  /** Each heartbeat names the interval, which the page then expects. */
  sseHeartbeatMs: { default: DEFAULT_SSE_HEARTBEAT_MS, floor: 1_000 }
};

const KEYS = Object.keys(RUNTIME_PACES) as Array<keyof RuntimeConfig>;

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = Object.fromEntries(
  KEYS.map((key) => [key, RUNTIME_PACES[key].default])
) as unknown as RuntimeConfig;

/** A value the (checked) file gives; null when it gives none. */
function given(raw: unknown, key: keyof RuntimeConfig): number | null {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" ? value : null;
}

/** The section as the server runs it: the file's values, the defaults for
 *  the rest. */
export function normalizeRuntimeConfig(raw: unknown): RuntimeConfig {
  return Object.fromEntries(KEYS.map((key) => [key, given(raw, key) ?? RUNTIME_PACES[key].default])) as unknown as RuntimeConfig;
}

/** One start-log line per value the file changed from its default. */
export function runtimeConfigLines(raw: unknown): string[] {
  return KEYS.flatMap((key) => {
    const value = given(raw, key);
    const fallback = RUNTIME_PACES[key].default;
    return value === null || value === fallback ? [] : [`[mandate] runtime: ${key} ${value} ms (default ${fallback} ms)`];
  });
}
