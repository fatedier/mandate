import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import { extractErrorMessage } from "@/lib/error-message";
import type { ActivityGroupKey, ActivitySummaryResponse } from "@shared/api-contracts";

/**
 * The windows the page offers, and the one it opens on.
 *
 * Still one window per page: the chart total, the group totals and the header
 * figure all read the same span, which is the invariant that lets them
 * reconcile. What changed is that the reader picks the span. Two windows on
 * one page at once is still forbidden — that is what makes the numbers
 * disagree — and nothing here does it.
 *
 * Rolling, not calendar: the server's window is `now - days`, and its day key
 * is `substr(created_at, 1, 10)`, which is UTC. A "Today" starting at local
 * midnight would put a headline count and the chart's own last bar out of step
 * by up to a day's edge. `24 hours` says what the reading actually is.
 *
 * No 90-day option, though the endpoint clamps to it: the chart is shaped for
 * a month of bars, the group table is a ranking rather than a trend, and
 * retention nulls payloads at 90 days so the far end is already degrading.
 * Adding an entry later is one line; taking one away is a change readers
 * notice.
 */
export const ACTIVITY_WINDOW_OPTIONS = [
  { days: 1, label: "24 hours", short: "24h" },
  { days: 7, label: "7 days", short: "7d" },
  { days: 30, label: "30 days", short: "30d" }
] as const;

export const DEFAULT_ACTIVITY_WINDOW_DAYS = 30;

export type ActivityWindowDays = (typeof ACTIVITY_WINDOW_OPTIONS)[number]["days"];

/** How a window is named in running text — "Last 24 hours", "calls · 7 days".
 *  `${days} days` renders "1 days" at the short end, which is the one span a
 *  reader is most likely to be looking at. */
export function formatWindow(days: number): string {
  return ACTIVITY_WINDOW_OPTIONS.find((option) => option.days === days)?.label ?? `${days} days`;
}

interface SummaryState {
  data: ActivitySummaryResponse | null;
  error: string;
  loading: boolean;
}

const FRESH_MS = 5 * 60 * 1000;

// The page offers three windows and five groupings. Expiry triggers a refresh;
// it does not discard the previous answer while that request is in flight.
export const activitySummaryCache = new Map<string, {
  data: ActivitySummaryResponse;
  fetchedAt: number;
}>();

interface SummaryRequest {
  controller: AbortController;
  promise: Promise<ActivitySummaryResponse>;
  consumers: Set<AbortSignal>;
}

const requests = new Map<string, SummaryRequest>();

function requestSummary(
  key: string,
  days: number,
  group: ActivityGroupKey,
  signal: AbortSignal,
  force: boolean
): Promise<ActivitySummaryResponse> {
  let request = force ? undefined : requests.get(key);
  if (!request) {
    const controller = new AbortController();
    const current: SummaryRequest = {
      controller,
      consumers: new Set(),
      promise: (async () => {
        const response = await fetch(api.activitySummary(days, group), { signal: controller.signal });
        const data = await readJson<ActivitySummaryResponse>(response);
        // A forced refresh can supersede a request another mounted reader still
        // needs. Only the newest request may update the shared cache.
        if (!controller.signal.aborted && requests.get(key)?.controller === controller) {
          activitySummaryCache.set(key, { data, fetchedAt: Date.now() });
        }
        return data;
      })().catch((cause) => {
        if (!controller.signal.aborted && requests.get(key)?.controller === controller) {
          const cached = activitySummaryCache.get(key);
          // Keep the last answer visible, but retry on return even if a manual
          // refresh failed before that answer's normal freshness period ended.
          if (cached) activitySummaryCache.set(key, { ...cached, fetchedAt: -Infinity });
        }
        throw cause;
      }).finally(() => {
        if (requests.get(key)?.controller === controller) requests.delete(key);
      })
    };
    requests.set(key, current);
    request = current;
  }

  const shared = request;
  shared.consumers.add(signal);
  const release = () => {
    shared.consumers.delete(signal);
    if (shared.consumers.size === 0) {
      shared.controller.abort();
      if (requests.get(key) === shared) requests.delete(key);
    }
  };
  signal.addEventListener("abort", release, { once: true });
  return shared.promise.finally(() => {
    signal.removeEventListener("abort", release);
    shared.consumers.delete(signal);
  });
}

/** Summary reads reuse a five-minute cache across page mounts. A null group
 *  is the Logs tab: keep the answer and any pending request until it returns. */
export function useActivitySummary(
  group: ActivityGroupKey | null,
  days: number
) {
  const wanted = group === null ? null : `${group}:${days}`;
  const [state, setState] = useState<SummaryState>(() => {
    const cached = wanted === null ? undefined : activitySummaryCache.get(wanted);
    return {
      data: cached?.data ?? null,
      error: "",
      loading: wanted !== null && (!cached || Date.now() - cached.fetchedAt >= FRESH_MS)
    };
  });

  // One request at a time, whoever started it. Refresh used to fetch without a
  // signal, which left two holes: a refresh still in flight when the tab closed
  // resolved onto a dead root, and a refresh that overtook the mount fetch was
  // settled by whichever landed last rather than by whichever was asked for
  // last. Aborting the previous request closes both.
  const inFlight = useRef<AbortController | null>(null);

  // Preserve a pending request across a trip through Logs. Completed answers
  // go through the freshness check again when the reader returns.
  const asked = useRef<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (group === null || wanted === null) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const signal = controller.signal;
    const cached = activitySummaryCache.get(wanted);
    const fresh = cached && Date.now() - cached.fetchedAt < FRESH_MS;
    queueMicrotask(() => {
      if (!signal.aborted) setState((previous) => ({
        data: cached?.data ?? previous.data,
        error: "",
        loading: force || !fresh
      }));
    });
    try {
      const data = fresh && !force
        ? cached.data
        : await requestSummary(wanted, days, group, signal, force);
      // Also defer cache hits beyond the effect, and ignore an answer whose
      // consumer left even when another consumer kept the shared fetch alive.
      await Promise.resolve();
      if (signal.aborted) return;
      setState({ data, error: "", loading: false });
    } catch (cause) {
      // An abort is this component going away, or a second load overtaking
      // the first. Neither is an error the reader should be shown.
      if (signal.aborted || (cause as Error)?.name === "AbortError") return;
      // A failed request is not one the hook holds, so coming back to the tab
      // that wanted it tries again rather than sitting on the error until
      // someone finds the Refresh button. Not on an abort: that is a newer
      // request taking over, and the newer request owns this.
      asked.current = null;
      setState((prev) => ({
        ...prev,
        error: extractErrorMessage(cause) || "Could not load activity.",
        loading: false
      }));
    }
  }, [group, days, wanted]);

  const refresh = useCallback(async () => {
    if (group === null) return;
    setState((prev) => ({ ...prev, loading: true }));
    await load(true);
  }, [group, load]);

  useEffect(() => {
    if (wanted === null) return;
    const signal = inFlight.current?.signal;
    if (asked.current === wanted && signal && requests.get(wanted)?.consumers.has(signal)) return;
    asked.current = wanted;
    void load();
  }, [load, wanted]);

  // Teardown only. Supersession is `load`'s own job — it aborts the previous
  // controller before starting — so the one case left is the component going
  // away. Aborting from the fetching effect's cleanup instead would also fire
  // on the way to a tab that reads no summary, throwing away a request already
  // paid for and leaving the tab it was for holding a `loading` that never
  // clears.
  useEffect(
    () => () => {
      inFlight.current?.abort();
      // And forget the cut, because the abort above is what threw it away. A
      // teardown is not always the end: StrictMode runs cleanup and then setup
      // again on the same mount, and `asked` survives that. Leaving it set
      // makes the second setup skip — no request, and a `loading` that never
      // clears, which also disables the Refresh button that is the only way
      // out. That is the whole app in dev, `main.tsx` mounts under StrictMode.
      asked.current = null;
    },
    []
  );

  return { ...state, refresh };
}
