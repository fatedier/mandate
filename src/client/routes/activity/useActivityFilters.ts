import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { readEnum, readString, withParam } from "@/lib/url-params";
import type { LlmCallView } from "@shared/api-contracts";
import type { PresetId } from "./ledger-copy";
import type { StatusFilter } from "./types";

const STATUS_VALUES = [
  "all",
  "succeeded",
  "failed",
  "running"
] as const satisfies readonly StatusFilter[];

export type ActivityQueryFilters = {
  status: Exclude<StatusFilter, "all"> | null;
  /** A preset that is not a status: slow, the Cache expired calls, timers. */
  view: LlmCallView | null;
  /** A ledger role, from a By agent row. */
  agent: string | null;
  /** The page's window, sent with the views that answer an Overview figure. */
  days?: number | null;
  /** The reader's time zone, which `day` is a date in. */
  tz?: string | null;
  purpose: string | null;
  provider: string | null;
  model: string | null;
  scopeType: string | null;
  day: string | null;
  fallback: string | null;
  q: string | null;
};

/** The filters that arrive from a breakdown row and from nowhere else. The bar
 *  offers no control for them — a scope type or a day is not a choice a reader
 *  makes here — so a chip is the whole of their interface, and each one has to
 *  be removable on its own. */
const LINK_FILTER_PARAMS = ["scopeType", "day", "fallback", "agent"] as const;

/** Every filter the log can hold. A link that opens the log on one question
 *  (a Breakdown row, an Overview figure) clears them all first, so what it
 *  opens is that question and not one narrowed by an earlier visit. `group`
 *  and `days` are not filters: they name the cut and window the reader came
 *  from, and keeping them is what makes the way back the one they left. */
export const LOG_FILTER_PARAMS = [
  "purpose", "provider", "model", "scopeType", "day", "fallback", "status", "q", "view", "agent"
] as const;

/** The log's address for one question: the page's query (its window and
 *  grouping) with every log filter cleared, then `set`. A day the Overview
 *  shows is part of its questions: its sections pass it in `set`. */
export function logsQuery(current: URLSearchParams, set: Record<string, string> = {}): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const name of LOG_FILTER_PARAMS) next.delete(name);
  next.set("tab", "logs");
  for (const [name, value] of Object.entries(set)) next.set(name, value);
  return next;
}

/** The presets that are views; Failed is the status filter. */
const VIEW_VALUES = ["slow", "expired", "timers"] as const satisfies readonly LlmCallView[];

type LinkFilterParam = (typeof LINK_FILTER_PARAMS)[number];

/**
 * The two values the log can actually filter on, and nothing else.
 *
 * `fallback` is the one link filter with a closed set of values: the server
 * applies a clause for "1" and for "0" and none at all for anything else, so a
 * hand-edited or stale `?fallback=` is not a filter the list is under. Read
 * raw, every statement the page makes about it was then wrong in the same
 * direction — the chip said `attempt: primary`, which is the *opposite* of an
 * unfiltered list, and the description handed to the agent named a filter the
 * list did not have. Narrowed here rather than at either reader, because both
 * are describing the request, and this is where the request is built.
 */
function readFallback(params: URLSearchParams): string | null {
  const value = params.get("fallback");
  return value === "1" || value === "0" ? value : null;
}

export function useActivityFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = readEnum<StatusFilter>(searchParams, "status", STATUS_VALUES, "all");
  const purposeFilter = readString(searchParams, "purpose");
  const providerFilter = readString(searchParams, "provider");
  const modelFilter = readString(searchParams, "model");
  const scopeTypeFilter = readString(searchParams, "scopeType");
  const dayFilter = readString(searchParams, "day");
  const fallbackFilter = readFallback(searchParams);
  const queryFilter = readString(searchParams, "q");
  const rawView = searchParams.get("view");
  const viewFilter: LlmCallView | null = (VIEW_VALUES as readonly string[]).includes(rawView ?? "") ? (rawView as LlmCallView) : null;
  const agentFilter = readString(searchParams, "agent");
  const queryFilters = useMemo<ActivityQueryFilters>(
    () => ({
      status: statusFilter === "all" ? null : statusFilter,
      view: viewFilter,
      agent: agentFilter,
      purpose: purposeFilter,
      provider: providerFilter,
      model: modelFilter,
      scopeType: scopeTypeFilter,
      day: dayFilter,
      fallback: fallbackFilter,
      q: queryFilter
    }),
    [
      statusFilter,
      purposeFilter,
      providerFilter,
      modelFilter,
      scopeTypeFilter,
      dayFilter,
      fallbackFilter,
      queryFilter,
      viewFilter,
      agentFilter
    ]
  );
  const filterKey = useMemo(() => JSON.stringify(queryFilters), [queryFilters]);

  const setStatusFilter = useCallback(
    (next: StatusFilter) => {
      setSearchParams((prev) => withParam(prev, "status", next === "all" ? null : next), {
        replace: true
      });
    },
    [setSearchParams]
  );

  const setTextFilters = useCallback(
    (filters: {
      purpose: string | null;
      provider: string | null;
      model: string | null;
      q: string | null;
    }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (filters.purpose) next.set("purpose", filters.purpose);
          else next.delete("purpose");
          if (filters.provider) next.set("provider", filters.provider);
          else next.delete("provider");
          if (filters.model) next.set("model", filters.model);
          else next.delete("model");
          if (filters.q) next.set("q", filters.q);
          else next.delete("q");
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const removeLinkFilter = useCallback(
    (name: LinkFilterParam) => {
      setSearchParams((prev) => withParam(prev, name, null), { replace: true });
    },
    [setSearchParams]
  );

  /** One preset at a time: Failed is the status filter, the rest are views,
   *  All is neither. Both params change in one write. */
  const setPreset = useCallback(
    (preset: PresetId) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("view");
          if (preset === "failed") next.set("status", "failed");
          else if (next.get("status") === "failed") next.delete("status");
          if (preset === "slow" || preset === "expired" || preset === "timers") next.set("view", preset);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const clearFilters = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("status");
        next.delete("purpose");
        next.delete("provider");
        next.delete("model");
        for (const name of LINK_FILTER_PARAMS) next.delete(name);
        next.delete("q");
        next.delete("view");
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  return {
    statusFilter,
    purposeFilter,
    providerFilter,
    modelFilter,
    scopeTypeFilter,
    dayFilter,
    fallbackFilter,
    queryFilter,
    viewFilter,
    agentFilter,
    queryFilters,
    filterKey,
    setStatusFilter,
    setPreset,
    setTextFilters,
    removeLinkFilter,
    clearFilters
  };
}
