import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { readEnum, readString, withParam } from "@/lib/url-params";
import type { StatusFilter } from "./types";

const STATUS_VALUES = [
  "all",
  "succeeded",
  "failed",
  "running"
] as const satisfies readonly StatusFilter[];

export type ActivityQueryFilters = {
  status: Exclude<StatusFilter, "all"> | null;
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
export const LINK_FILTER_PARAMS = ["scopeType", "day", "fallback"] as const;

export type LinkFilterParam = (typeof LINK_FILTER_PARAMS)[number];

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
  const queryFilters = useMemo<ActivityQueryFilters>(
    () => ({
      status: statusFilter === "all" ? null : statusFilter,
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
      queryFilter
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
          // `scopeType` used to be dropped here along with `scopeId`, from when
          // neither was a filter the log could answer. It is one now, and a
          // filter that disappeared because the reader touched an unrelated
          // dropdown would widen the list without saying so. `scopeId` still
          // goes: nothing reads it, so it is a stale param rather than state.
          next.delete("scopeId");
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

  const clearFilters = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("status");
        next.delete("purpose");
        next.delete("provider");
        next.delete("model");
        next.delete("scopeId");
        for (const name of LINK_FILTER_PARAMS) next.delete(name);
        next.delete("q");
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
    queryFilters,
    filterKey,
    setStatusFilter,
    setTextFilters,
    removeLinkFilter,
    clearFilters
  };
}
