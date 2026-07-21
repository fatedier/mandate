import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type {
  MemoryDreamRunsResponse,
  MemoryEntriesResponse,
  MemoryEntryDto,
  MemoryStatsResponse
} from "@shared/api-contracts";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import { withParam } from "@/lib/url-params";
import { ActivityView } from "./dream/ActivityView";
import { BrowseView } from "./BrowseView";
import { groupRunsIntoDreams, type DreamBatch } from "./dream/memory-run-model";
import { OverviewView } from "./OverviewView";
import { MemoryShell } from "./MemoryShell";
import { memoryViewFromParam, paramForMemoryView, type MemoryView } from "./memory-views";
import { filtersFromParams, paramsForFilters, type MemoryFilters } from "./memory-filters";

/** Enough runs to reconstruct the most recent dream, which spans one per partition. */
const DREAM_SAMPLE = 12;
const OVERVIEW_LIST_SIZE = 3;
/** How often to re-read while a dream is in flight. Only ticks while one is
 *  running — showing "running" on a page that never updates is half a state. */
const RUNNING_POLL_MS = 10_000;

export function MemoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = memoryViewFromParam(searchParams.get("view"));
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);

  const setView = (next: MemoryView) =>
    setSearchParams((prev) => withParam(prev, "view", paramForMemoryView(next)), { replace: true });

  const setFilters = (next: MemoryFilters) =>
    setSearchParams((prev) => paramsForFilters(prev, next), { replace: true });

  const overview = useOverviewData(view === "overview");

  return (
    <MemoryShell
      view={view}
      setView={setView}
      refreshing={overview.loading}
      onRefresh={() => void overview.reload()}
    >
      {view === "overview" && (
        <OverviewView
          stats={overview.stats}
          topRecalled={overview.topRecalled}
          justLearned={overview.justLearned}
          lastDream={overview.lastDream}
          loading={overview.loading}
          running={overview.running}
          onRunDream={() => void overview.runDream()}
        />
      )}
      {view === "activity" && <ActivityView />}
      {view === "browse" && (
        <BrowseView filters={filters} setFilters={setFilters} stats={overview.stats} />
      )}
    </MemoryShell>
  );
}

/**
 * Everything the Overview reads, in one place.
 *
 * The stats also feed Browse's project-name lookup, so they load regardless of
 * which view is showing; the three sample lists only load for the view that
 * displays them.
 */
function useOverviewData(active: boolean) {
  const [stats, setStats] = useState<MemoryStatsResponse | null>(null);
  const [topRecalled, setTopRecalled] = useState<MemoryEntryDto[]>([]);
  const [justLearned, setJustLearned] = useState<MemoryEntryDto[]>([]);
  const [lastDream, setLastDream] = useState<DreamBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(
    async (withSamples: boolean, signal?: AbortSignal) => {
      setLoading(true);
      try {
        const entries = (sort: string) =>
          fetch(api.memoryEntries(`status=available&sort=${sort}&limit=${OVERVIEW_LIST_SIZE}`), {
            signal
          }).then((res) => readJson<MemoryEntriesResponse>(res));

        const [statsPayload, recalled, created, runs] = await Promise.all([
          fetch(api.memoryStats, { signal }).then((res) => readJson<MemoryStatsResponse>(res)),
          withSamples ? entries("used") : null,
          withSamples ? entries("created") : null,
          withSamples
            ? fetch(`${api.memoryDreamRuns}?limit=${DREAM_SAMPLE}`, { signal }).then((res) =>
                readJson<MemoryDreamRunsResponse>(res)
              )
            : null
        ]);

        setStats(statsPayload);
        if (recalled) setTopRecalled(recalled.entries.filter((e) => e.useCount > 0));
        if (created) setJustLearned(created.entries);
        if (runs) setLastDream(groupRunsIntoDreams(runs.runs)[0] ?? null);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        // The Overview degrades to whatever it already had rather than
        // replacing the page with an error — the tabs must stay reachable.
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(active, controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, active]);

  // Poll only while something is actually running, so an idle page makes no
  // requests at all.
  const dreamRunning = Boolean(lastDream?.running);
  useEffect(() => {
    if (!dreamRunning) return;
    const controller = new AbortController();
    const id = window.setInterval(() => void load(active, controller.signal), RUNNING_POLL_MS);
    return () => {
      window.clearInterval(id);
      controller.abort();
    };
  }, [dreamRunning, load, active]);

  const runDream = useCallback(async () => {
    setRunning(true);
    try {
      await fetch(api.memoryDreamRuns, { method: "POST" });
      await load(true);
    } finally {
      setRunning(false);
    }
  }, [load]);

  return {
    stats,
    topRecalled,
    justLearned,
    lastDream,
    loading,
    running,
    runDream,
    reload: () => load(active)
  };
}
