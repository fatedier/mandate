import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import type { ActivityCallsResponse, ActivityResponse } from "./types";
import type { ActivityQueryFilters } from "./useActivityFilters";

const PAGE_SIZE = 20;

// Module-level cache that survives unmount. When the user navigates away
// from /activity and back, the previous data renders immediately and a
// background refresh updates it without a skeleton flash.
let cachedData: ActivityResponse | null = null;
let cachedHasMore = true;
let cachedFilterKey = "";
let cachedLoadedAtMs = 0;

export function useActivityData({
  filterKey,
  queryFilters,
  refreshToken = 0
}: {
  filterKey: string;
  queryFilters: ActivityQueryFilters;
  /** Bumped by the page's Refresh button. It rides the same effect the filter
   *  key does rather than calling `fetchTopPage` from an effect of its own:
   *  that call raises `refreshing` synchronously, and a synchronous state
   *  write inside an effect is what `react-hooks/set-state-in-effect` exists
   *  to stop. Here the fetch is already deferred to a microtask, and the
   *  cache-hit branch keeps the rows on screen while it runs. */
  refreshToken?: number;
}) {
  const [data, setData] = useState<ActivityResponse | null>(() => cachedData);
  const [error, setError] = useState<string>("");
  const [paginationError, setPaginationError] = useState("");
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState<boolean>(() => cachedHasMore);
  const [dataFilterKey, setDataFilterKey] = useState(() => cachedFilterKey);
  const [loadedAtMs, setLoadedAtMs] = useState(() => cachedLoadedAtMs || Date.now());
  const dataFilterKeyRef = useRef(cachedFilterKey);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const olderAbortRef = useRef<AbortController | null>(null);
  const olderRequestSeqRef = useRef(0);
  const feedGenerationRef = useRef(0);
  const refreshingRef = useRef(false);

  const abortOlderRequest = useCallback(() => {
    olderAbortRef.current?.abort();
    olderAbortRef.current = null;
  }, []);

  const fetchTopPage = useCallback(
    async (mode: "initial" | "refresh") => {
      const requestFilterKey = filterKey;
      refreshAbortRef.current?.abort();
      refreshingRef.current = true;
      olderRequestSeqRef.current++;
      abortOlderRequest();
      const controller = new AbortController();
      refreshAbortRef.current = controller;
      setLoadingMore(false);
      if (mode === "initial") setInitialLoading(true);
      else setRefreshing(true);
      try {
        const res = await fetch(api.activityCalls({ limit: PAGE_SIZE, ...queryFilters }), {
          signal: controller.signal
        });
        const payload = await readJson<ActivityResponse>(res);
        if (dataFilterKeyRef.current !== requestFilterKey) return;
        const fetchedAtMs = Date.now();
        feedGenerationRef.current++;
        olderRequestSeqRef.current++;
        abortOlderRequest();
        setError("");
        setPaginationError("");
        setHasMore(payload.calls.length >= PAGE_SIZE);
        setData(payload);
        setDataFilterKey(requestFilterKey);
        setLoadedAtMs(fetchedAtMs);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mode === "initial") setInitialLoading(false);
        else setRefreshing(false);
        if (refreshAbortRef.current === controller) {
          refreshAbortRef.current = null;
          refreshingRef.current = false;
        }
      }
    },
    [abortOlderRequest, filterKey, queryFilters]
  );

  const fetchOlder = useCallback(
    async (oldestCreatedAt: string, oldestId: string) => {
      const requestFilterKey = filterKey;
      const feedGeneration = feedGenerationRef.current;
      olderAbortRef.current?.abort();
      const requestSeq = ++olderRequestSeqRef.current;
      const controller = new AbortController();
      olderAbortRef.current = controller;
      setLoadingMore(true);
      try {
        const url = api.activityCalls({
          limit: PAGE_SIZE,
          before: oldestCreatedAt,
          // Paired with `before`: the two together are the cursor, and a
          // `before` sent alone silently drops rows sharing its millisecond.
          beforeId: oldestId,
          ...queryFilters
        });
        const res = await fetch(url, { signal: controller.signal });
        const payload = await readJson<ActivityCallsResponse>(res);
        if (
          controller.signal.aborted ||
          dataFilterKeyRef.current !== requestFilterKey ||
          olderRequestSeqRef.current !== requestSeq ||
          feedGenerationRef.current !== feedGeneration
        ) return;
        setPaginationError("");
        if (payload.calls.length === 0) {
          setHasMore(false);
          return;
        }
        if (payload.calls.length < PAGE_SIZE) setHasMore(false);
        setLoadedAtMs(Date.now());
        setData((prev) =>
          prev &&
          dataFilterKeyRef.current === requestFilterKey &&
          olderRequestSeqRef.current === requestSeq &&
          feedGenerationRef.current === feedGeneration
            ? { calls: [...prev.calls, ...payload.calls] }
            : prev
        );
      } catch (err) {
        if (
          (err as Error)?.name === "AbortError" ||
          controller.signal.aborted ||
          dataFilterKeyRef.current !== requestFilterKey ||
          olderRequestSeqRef.current !== requestSeq ||
          feedGenerationRef.current !== feedGeneration
        ) return;
        setPaginationError(err instanceof Error ? err.message : String(err));
      } finally {
        if (olderRequestSeqRef.current === requestSeq) {
          if (olderAbortRef.current === controller) olderAbortRef.current = null;
          setLoadingMore(false);
        }
      }
    },
    [filterKey, queryFilters]
  );

  useEffect(() => {
    if (!data) return;
    cachedData = data;
    cachedFilterKey = dataFilterKey;
  }, [data, dataFilterKey]);

  useEffect(() => {
    cachedHasMore = hasMore;
  }, [hasMore]);

  useEffect(() => {
    cachedLoadedAtMs = loadedAtMs;
  }, [loadedAtMs]);

  useEffect(() => {
    let cancelled = false;
    const cacheSnapshot = cachedData;
    const hasMatchingCache = cacheSnapshot && cachedFilterKey === filterKey;
    dataFilterKeyRef.current = filterKey;
    queueMicrotask(() => {
      if (cancelled) return;
      if (hasMatchingCache) {
        setData(cacheSnapshot);
        setDataFilterKey(filterKey);
        setHasMore(cachedHasMore);
        setLoadedAtMs(cachedLoadedAtMs || Date.now());
      } else {
        setData(null);
        setDataFilterKey(filterKey);
        setHasMore(true);
      }
    });
    queueMicrotask(() => {
      if (!cancelled) {
        void fetchTopPage(hasMatchingCache ? "refresh" : "initial");
      }
    });
    return () => {
      cancelled = true;
      refreshAbortRef.current?.abort();
      olderAbortRef.current?.abort();
      refreshingRef.current = false;
    };
  }, [fetchTopPage, filterKey, refreshToken]);

  const currentData = dataFilterKey === filterKey ? data : null;
  const calls = currentData?.calls ?? [];
  const oldest = calls.length > 0 ? calls[calls.length - 1] : null;

  const loadMore = useCallback(() => {
    if (!oldest || loadingMore || refreshingRef.current || !hasMore) return;
    void fetchOlder(oldest.createdAt, oldest.id);
  }, [oldest, loadingMore, hasMore, fetchOlder]);

  return {
    currentData,
    calls,
    error: error || paginationError,
    paginationError,
    initialLoading,
    refreshing,
    loadingMore,
    hasMore,
    loadedAtMs,
    fetchTopPage,
    loadMore
  };
}
