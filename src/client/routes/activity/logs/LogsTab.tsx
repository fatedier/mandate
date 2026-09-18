import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, Search, X } from "lucide-react";
import { SimpleSelect, type SimpleSelectOption } from "@/components/ui/select";
import { CallDetailPanel } from "../CallDetailPanel";
import { ActivityListSkeleton } from "../ActivitySkeleton";
import { useActivityData } from "../useActivityData";
import { useActivityFilters } from "../useActivityFilters";
import { useLogsPageSummary } from "../useActivityPageSummary";
import type { ActivityCall, StatusFilter } from "../types";
import { LogRow } from "./LogRow";

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

export function LogsTab({ refreshToken }: LogsTabProps) {
  const {
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
  } = useActivityFilters();
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

  const openCall = calls.find((call) => call.id === openCallId) ?? null;
  useLogsPageSummary({
    statusFilter,
    purposeFilter,
    providerFilter,
    modelFilter,
    scopeTypeFilter,
    dayFilter,
    fallbackFilter,
    queryFilter,
    calls,
    hasMore,
    openCall
  });

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
    dayFilter ? { label: `day: ${dayFilter}`, remove: () => removeLinkFilter("day") } : null,
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
    return (
      <ErrorOr error={error}>
        <div className="px-3.5 py-3 text-2xs text-faint">
          No data yet.
        </div>
      </ErrorOr>
    );
  }

  return (
    <ErrorOr error={error}>
      {/* The container the row's narrow rules query. Sized by the card, not by
          the viewport: the assistant dock is resizable, so the width a row
          actually gets has no fixed relationship to the window. */}
      <section className="@container overflow-hidden rounded-lg border border-border-soft bg-panel">
        <header className="border-b border-border-soft">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <h2 className="text-sm font-semibold">Recent calls</h2>
            {refreshing && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            <span className="num ml-auto text-2xs text-chrome">{calls.length} loaded</span>
            {activeFilterItems.length > 0 && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 rounded-md border border-border-soft bg-muted/60 px-1.5 py-0.5 text-2xs text-foreground/75 hover:border-border hover:bg-muted hover:text-foreground"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            )}
          </div>
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
          failed={Boolean(paginationError)}
          onLoadMore={loadMore}
        />
      </section>
      <CallDetailPanel callId={openCallId} onClose={() => setOpenCallId(null)} />
    </ErrorOr>
  );
}

function ErrorOr({ error, children }: { error: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
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
      className="flex flex-wrap items-center gap-2 border-t border-border-soft px-3 py-2"
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
        className="rounded-md border border-border-soft bg-muted/60 px-3 py-1.5 text-xs text-foreground/80 hover:border-border hover:bg-muted"
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
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border-soft px-3 py-1.5 text-2xs text-foreground/65">
      <span className="label-micro text-muted-foreground">Showing</span>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.remove}
          className="inline-flex max-w-[18rem] items-center gap-1 rounded-md border border-border-soft bg-background px-1.5 py-0.5 text-foreground/75 hover:border-border hover:bg-muted hover:text-foreground"
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
  failed,
  onLoadMore
}: {
  hasMore: boolean;
  loadingMore: boolean;
  failed: boolean;
  onLoadMore: () => void;
}) {
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

  return (
    <div
      ref={sentinelRef}
      className="flex items-center justify-center border-t border-border-soft px-4 py-3"
    >
      <button
        type="button"
        onClick={onLoadMore}
        disabled={loadingMore}
        className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
        <span>{loadingMore ? "Loading older..." : failed ? "Retry loading older" : "Load older"}</span>
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

function buildModelOptions(
  calls: ActivityCall[],
  activeProvider: string | null,
  activeModel: string | null
): SimpleSelectOption[] {
  const seen = new Set<string>();
  const options: SimpleSelectOption[] = [{ value: "", label: "Any model" }];
  if (activeProvider) {
    const value = providerModelValue(activeProvider, activeModel);
    seen.add(value);
    options.push({
      value,
      label: activeModel ? `${activeProvider} / ${activeModel}` : activeProvider
    });
  }
  for (const call of calls) {
    if (!call.provider) continue;
    const value = providerModelValue(call.provider, call.model);
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({
      value,
      label: call.model ? `${call.provider} / ${call.model}` : call.provider
    });
  }
  return options;
}

function providerModelValue(provider: string | null, model: string | null): string {
  if (!provider) return "";
  return JSON.stringify([provider, model]);
}

function parseProviderModelValue(value: string): { provider: string | null; model: string | null } {
  if (!value) return { provider: null, model: null };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") {
      return { provider: null, model: null };
    }
    return {
      provider: parsed[0],
      model: typeof parsed[1] === "string" ? parsed[1] : null
    };
  } catch {
    return { provider: null, model: null };
  }
}
