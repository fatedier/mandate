import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { formatCalendarDay } from "@/lib/format";
import { readerTimeZone } from "@/lib/time-zone";
import { Loader2, Search, X } from "lucide-react";
import { SimpleSelect, type SimpleSelectOption } from "@/components/ui/select";
import { InlineError } from "@/components/ViewState";
import { CallDetailPanel } from "../CallDetailPanel";
import { ActivityListSkeleton } from "../ActivitySkeleton";
import { useActivityData } from "../useActivityData";
import { useActivityFilters } from "../useActivityFilters";
import type { ActivityCall, StatusFilter } from "../types";
import { buildModelOptions, parseProviderModelValue, providerModelValue } from "./model-options";
import { LogRow } from "./LogRow";
import { LogPresets } from "./LogPresets";
import { PAID_ON_TOP, PRESETS, roleLabel } from "../ledger-copy";
import { formatUsd } from "../money";
import { formatWindow } from "../useActivitySummary";

/**
 * The stream, and the only surface on this page that pages.
 *
 * It owns its own query rather than taking it from the page: the Overview is
 * the landing tab, and a list fetch that ran whether or not anyone was looking
 * at the list is a request nobody asked for. Mounting this tab is what buys
 * the rows.
 */
interface LogsTabProps {
  /** Bumped by the page's Refresh button. */
  refreshToken: number;
  /** The page's window: the views that answer an Overview figure keep to it. */
  windowDays: number;
  /** Asks for the list again (the page's refresh). */
  onRetry: () => void;
}

type TextFilters = {
  purpose: string | null;
  provider: string | null;
  model: string | null;
  q: string | null;
};

interface ActiveFilterItem {
  label: string;
  remove: () => void;
}

export function LogsTab({ refreshToken, windowDays, onRetry }: LogsTabProps) {
  const {
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
    queryFilters: linkFilters,
    filterKey: linkFilterKey,
    setStatusFilter,
    setPreset,
    setTextFilters,
    removeLinkFilter,
    clearFilters
  } = useActivityFilters();
  // Cache expired, Timers and an agent answer a figure the Overview counted
  // for the page's window, so they list that window; the rest list all history.
  const periodBound = viewFilter === "expired" || viewFilter === "timers" || agentFilter !== null;
  // The reader's zone is part of what the list is: their days are cut in it,
  // and a machine that moves to another zone reads the list again from the
  // top rather than paging on in a different day.
  const zone = readerTimeZone();
  const queryFilters = useMemo(() => ({ ...linkFilters, days: periodBound ? windowDays : null, tz: zone }), [linkFilters, periodBound, windowDays, zone]);
  const filterKey = `${linkFilterKey}|${periodBound ? windowDays : ""}|${zone}`;
  const {
    currentData,
    calls,
    error,
    paginationError,
    initialLoading,
    refreshing,
    loadingMore,
    hasMore,
    loadedAtMs,
    loadMore
  } = useActivityData({ filterKey, queryFilters, refreshToken });
  const [openCallId, setOpenCallId] = useState<string | null>(null);

  const textFilters: TextFilters = {
    purpose: purposeFilter,
    provider: providerFilter,
    model: modelFilter,
    q: queryFilter
  };
  const applyTextFilter = (patch: Partial<TextFilters>) => {
    setTextFilters({ ...textFilters, ...patch });
  };
  const activeFilterItems: ActiveFilterItem[] = [
    statusFilter !== "all"
      ? { label: `status: ${statusFilter}`, remove: () => setStatusFilter("all") }
      : null,
    purposeFilter
      ? { label: `purpose: ${purposeFilter}`, remove: () => applyTextFilter({ purpose: null }) }
      : null,
    providerFilter || modelFilter
      ? {
          label: `model: ${providerFilter ?? "*"}${modelFilter ? ` / ${modelFilter}` : ""}`,
          remove: () => applyTextFilter({ provider: null, model: null })
        }
      : null,
    // The three that arrive by link. Shown for the same reason the others are,
    // and with more riding on it: the bar has no control that would hint at
    // them, so without a chip the list is filtered and the page says it is not
    // — and `Clear`, which only appears when something is showing, would not be
    // there either.
    scopeTypeFilter
      ? { label: `scope: ${scopeTypeFilter}`, remove: () => removeLinkFilter("scopeType") }
      : null,
    agentFilter
      ? { label: `agent: ${roleLabel(agentFilter)}`, remove: () => removeLinkFilter("agent") }
      : null,
    // The day reads as a date; the URL keeps its key.
    dayFilter ? { label: `day: ${formatCalendarDay(dayFilter) || dayFilter}`, remove: () => removeLinkFilter("day") } : null,
    fallbackFilter
      ? {
          label: `attempt: ${fallbackFilter === "1" ? "fallback" : "primary"}`,
          remove: () => removeLinkFilter("fallback")
        }
      : null,
    queryFilter
      ? { label: `id/hash: ${queryFilter}`, remove: () => applyTextFilter({ q: null }) }
      : null
  ].filter((item): item is ActiveFilterItem => Boolean(item));

  if (!currentData) {
    if (initialLoading) return <ActivityListSkeleton />;
    // A failure is said alone: "No data yet" beside it would claim the log
    // was read and found empty.
    if (error) return <InlineError detail={error} onRetry={onRetry}>Couldn't load the log.</InlineError>;
    return (
      <div className="px-3.5 py-3 text-2xs text-faint">
        No data yet.
      </div>
    );
  }

  return (
    <ErrorOr error={error} onRetry={onRetry}>
      {/* The container the row's narrow rules query. Sized by the card, not by
          the viewport: the assistant dock is resizable, so the width a row
          actually gets has no fixed relationship to the window. */}
      <section className="@container overflow-hidden rounded-lg border border-border-soft bg-panel">
        <header className="border-b border-border-soft">
          {/* 12px above and below on a touch screen: the panel clips, and
              Clear's touch area reaches 11px past it. */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 pointer-coarse:py-3">
            <h2 className="text-sm font-semibold">
              {periodBound ? (
                <>
                  {viewTitle(viewFilter, agentFilter)}
                  <span className="num font-normal text-faint">
                    {` · last ${formatWindow(windowDays)}`}
                    {currentData.totals ? ` · ${currentData.totals.calls.toLocaleString("en-US")} calls` : ""}
                  </span>
                </>
              ) : "Recent calls"}
            </h2>
            {refreshing && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            {viewFilter === "expired" && currentData.totals?.extraMicros != null && (
              <span className="num text-2xs text-muted-foreground">
                <span className="font-semibold text-amber">{formatUsd(currentData.totals.extraMicros, true)}</span> {PAID_ON_TOP}
              </span>
            )}
            <span className="num ml-auto text-2xs text-chrome">{calls.length} loaded</span>
            {activeFilterItems.length > 0 && (
              <button
                type="button"
                onClick={clearFilters}
                className="hit relative inline-flex items-center gap-1 rounded-md border border-border-soft bg-muted/60 px-1.5 py-0.5 text-2xs text-foreground/75 hover:border-border hover:bg-muted hover:text-foreground"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            )}
          </div>
          <LogPresets
            selected={viewFilter ?? (statusFilter === "failed" ? "failed" : "all")}
            onSelect={setPreset}
          />
          <FilterBar
            key={queryFilter ?? ""}
            statusFilter={statusFilter}
            purposeFilter={purposeFilter}
            modelFilterValue={providerModelValue(providerFilter, modelFilter)}
            queryFilter={queryFilter}
            purposeOptions={buildPurposeOptions(calls, purposeFilter)}
            modelOptions={buildModelOptions(calls, providerFilter, modelFilter)}
            onStatusFilterChange={setStatusFilter}
            onPurposeFilterChange={(purpose) => applyTextFilter({ purpose })}
            onProviderModelFilterChange={(provider, model) => applyTextFilter({ provider, model })}
            onQueryFilterApply={(q) => applyTextFilter({ q })}
          />
          {activeFilterItems.length > 0 && <ActiveFilters items={activeFilterItems} />}
        </header>
        {calls.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            No matching calls.
          </div>
        ) : (
          <ul>
            {calls.map((call) => (
              <LogRow
                key={call.id}
                call={call}
                nowMs={loadedAtMs}
                selected={call.id === openCallId}
                onOpen={() => setOpenCallId(call.id)}
              />
            ))}
          </ul>
        )}
        <FeedFooter
          hasMore={hasMore}
          loadingMore={loadingMore}
          failure={paginationError}
          onLoadMore={loadMore}
        />
      </section>
      <CallDetailPanel callId={openCallId} onClose={() => setOpenCallId(null)} />
    </ErrorOr>
  );
}

/** A period view's name: the preset's, else the agent's. */
function viewTitle(view: string | null, agent: string | null): string {
  const preset = PRESETS.find((p) => p.id === view && (view === "expired" || view === "timers"));
  return preset ? preset.label : agent ? roleLabel(agent) : "Recent calls";
}

/** The rows on screen, under a refresh that failed when one did: they are
 *  the last ones loaded. */
function ErrorOr({ error, onRetry, children }: { error: string; onRetry: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <InlineError detail={error} onRetry={onRetry}>
          Couldn't refresh the log. Showing the last loaded calls.
        </InlineError>
      )}
      {children}
    </div>
  );
}

function FilterBar({
  statusFilter,
  purposeFilter,
  modelFilterValue,
  queryFilter,
  purposeOptions,
  modelOptions,
  onStatusFilterChange,
  onPurposeFilterChange,
  onProviderModelFilterChange,
  onQueryFilterApply
}: {
  statusFilter: StatusFilter;
  purposeFilter: string | null;
  modelFilterValue: string;
  queryFilter: string | null;
  purposeOptions: SimpleSelectOption[];
  modelOptions: SimpleSelectOption[];
  onStatusFilterChange: (next: StatusFilter) => void;
  onPurposeFilterChange: (next: string | null) => void;
  onProviderModelFilterChange: (provider: string | null, model: string | null) => void;
  onQueryFilterApply: (q: string | null) => void;
}) {
  const [query, setQuery] = useState(queryFilter ?? "");
  const statusOptions: SimpleSelectOption[] = [
    { value: "all", label: "Any status" },
    { value: "failed", label: "Failed" },
    { value: "running", label: "Running" },
    { value: "succeeded", label: "Succeeded" }
  ];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onQueryFilterApply(trimOrNull(query));
  };

  // One row, sized to its controls. The labelled version stacked a caption over
  // every control and stretched all four across the card: 130px of header
  // saying `Status / Any status`, `Purpose / Any purpose`, `Model / Any model`
  // — a form four controls tall to report that nothing is filtered. The
  // controls say what they are when they are set, and the `Showing` chips below
  // say it again; the captions were the third telling. Named for a screen
  // reader by `aria-label`, which is what the caption was doing that the
  // placeholder does not.
  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-center gap-2 pointer-coarse:gap-y-4 border-t border-border-soft px-3 py-2"
    >
      <FilterSelect
        label="Status"
        value={statusFilter}
        options={statusOptions}
        onValueChange={(value) => onStatusFilterChange(value as StatusFilter)}
      />
      <FilterSelect
        label="Purpose"
        value={purposeFilter ?? ""}
        options={purposeOptions}
        onValueChange={(value) => onPurposeFilterChange(value || null)}
      />
      <FilterSelect
        label="Model"
        value={modelFilterValue}
        options={modelOptions}
        onValueChange={(value) => {
          const decoded = parseProviderModelValue(value);
          onProviderModelFilterChange(decoded.provider, decoded.model);
        }}
      />
      {/* The one control that cannot be sized to its content — it holds what
          the reader types. It takes the row's remaining width up to a cap, so
          the bar ends before the card does rather than a search box running
          the width of a screen. */}
      <span className="relative min-w-[12rem] max-w-[22rem] flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          aria-label="ID / hash"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Call id, parent id, or hash"
          className="h-8 w-full rounded-md border border-border-soft bg-background pl-7 pr-2 text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
        />
      </span>
      <button
        type="submit"
        className="hit relative rounded-md border border-border-soft bg-muted/60 px-3 py-1.5 text-xs text-foreground/80 hover:border-border hover:bg-muted"
      >
        Apply
      </button>
    </form>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onValueChange
}: {
  label: string;
  value: string;
  options: SimpleSelectOption[];
  onValueChange: (value: string) => void;
}) {
  return (
    <SimpleSelect
      aria-label={label}
      value={value}
      options={options}
      onValueChange={onValueChange}
      className="h-8 w-auto border-border-soft px-2 text-xs focus:border-ring focus:ring-ring/30"
      contentClassName="max-w-[min(36rem,calc(100vw-2rem))]"
      itemClassName="text-xs"
    />
  );
}

function ActiveFilters({ items }: { items: ActiveFilterItem[] }) {
  return (
    // On a touch screen 12px above and below and 24px between wrapped rows:
    // a 22px chip's touch area reaches 11px past it.
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border-soft px-3 py-1.5 text-2xs text-foreground/65 pointer-coarse:gap-y-6 pointer-coarse:py-3">
      <span className="label-micro text-muted-foreground">Showing</span>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.remove}
          className="hit relative inline-flex max-w-[18rem] items-center gap-1 rounded-md border border-border-soft bg-background px-1.5 py-0.5 text-foreground/75 hover:border-border hover:bg-muted hover:text-foreground"
          title={`Remove ${item.label}`}
        >
          <span className="truncate">{item.label}</span>
          <X className="h-3 w-3 shrink-0" />
        </button>
      ))}
    </div>
  );
}

function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function FeedFooter({
  hasMore,
  loadingMore,
  failure,
  onLoadMore
}: {
  hasMore: boolean;
  loadingMore: boolean;
  /** Why the last page of older calls failed; empty when it didn't. */
  failure: string;
  onLoadMore: () => void;
}) {
  const failed = failure !== "";
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Auto-trigger when the sentinel scrolls into view. The button below is
  // both a manual fallback and a visual hint that more data is reachable.
  useEffect(() => {
    if (!hasMore || loadingMore || failed) return undefined;
    const el = sentinelRef.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, failed, onLoadMore]);

  if (!hasMore && !loadingMore) {
    return (
      <div className="border-t border-border-soft px-4 py-3 text-center text-2xs text-muted-foreground">
        No older calls.
      </div>
    );
  }

  // Failed: said here, where the next page would be, with its reason, and
  // not loaded again until asked.
  if (failed && !loadingMore) {
    return (
      <div className="border-t border-border-soft px-4 py-3 pointer-coarse:py-3.5">
        <InlineError detail={failure} onRetry={onLoadMore}>Couldn't load older calls.</InlineError>
      </div>
    );
  }

  return (
    <div
      ref={sentinelRef}
      // 14px above and below on a touch screen: the card clips, and the
      // button's touch area reaches 14px past it.
      className="flex items-center justify-center border-t border-border-soft px-4 py-3 pointer-coarse:py-3.5"
    >
      <button
        type="button"
        onClick={onLoadMore}
        disabled={loadingMore}
        className="hit relative inline-flex items-center gap-1.5 text-2xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
        <span>{loadingMore ? "Loading older…" : "Load older"}</span>
      </button>
    </div>
  );
}

function buildPurposeOptions(calls: ActivityCall[], active: string | null): SimpleSelectOption[] {
  const seen = new Set<string>();
  const options: SimpleSelectOption[] = [{ value: "", label: "Any purpose" }];
  if (active) {
    seen.add(active);
    options.push({ value: active, label: active });
  }
  for (const call of calls) {
    const purpose = call.purpose.trim();
    if (!purpose || seen.has(purpose)) continue;
    seen.add(purpose);
    options.push({ value: purpose, label: purpose });
  }
  return options;
}
