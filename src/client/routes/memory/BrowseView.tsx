import { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, Search, X } from "lucide-react";
import type { MemoryEntriesResponse, MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";
import { MEMORY_ENTRY_SORTS, MEMORY_USAGE_FILTERS } from "@shared/api-contracts";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/select";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { KindBadge, MemoryDetailDialog } from "./MemoryEntryDetail";
import { entryLocation, entryReason, usageSummary } from "./memory-entry";
import {
  KIND_FILTERS,
  USAGE_LABEL,
  SCOPE_FILTERS,
  SORT_LABEL,
  STATUS_FILTERS,
  activeChips,
  entriesQuery,
  hasActiveFilters,
  withoutFilter,
  type MemoryFilters
} from "./memory-filters";

const PAGE_SIZE = 50;

/**
 * The one list surface. Everything that narrows it lives in the URL, so the
 * Overview's figures can link straight to a filtered view and a shared link
 * shows what the sender was looking at.
 */
export function BrowseView({
  filters,
  setFilters,
  stats
}: {
  filters: MemoryFilters;
  setFilters: (next: MemoryFilters) => void;
  stats: MemoryStatsResponse | null;
}) {
  const [entries, setEntries] = useState<MemoryEntryDto[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<MemoryEntryDto | null>(null);
  const [draftQuery, setDraftQuery] = useState(filters.q);
  const [committedQuery, setCommittedQuery] = useState(filters.q);

  // The box holds an uncommitted draft, but a doorway or the back button can
  // change the committed query underneath it. Adjusted during render rather
  // than in an effect — an effect would set state after the commit and render
  // one frame of the stale term.
  if (filters.q !== committedQuery) {
    setCommittedQuery(filters.q);
    setDraftQuery(filters.q);
  }

  const load = useCallback(
    async (nextOffset: number, mode: "replace" | "append", signal?: AbortSignal) => {
      if (mode === "replace") setLoading(true);
      else setAppending(true);
      try {
        const params = entriesQuery(filters, { limit: PAGE_SIZE, offset: nextOffset });
        const res = await fetch(api.memoryEntries(params), { signal });
        const payload = await readJson<MemoryEntriesResponse>(res);
        setTotal(payload.total);
        setOffset(nextOffset);
        setEntries((prev) => (mode === "append" ? [...prev, ...payload.entries] : payload.entries));
        setError("");
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setAppending(false);
      }
    },
    [filters]
  );

  // Deferred by a zero timer, matching the rest of this page: calling load
  // straight from the effect sets loading state during the commit.
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(0, "replace", controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  const projectNames = useMemo(
    () => new Map((stats?.byProject ?? []).map((p) => [p.projectId, p.name])),
    [stats]
  );
  const chips = activeChips(filters, {
    project: filters.projectId ? projectNames.get(filters.projectId) : undefined
  });
  const hasMore = entries.length < total;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Usage"
          width="w-52"
          value={filters.usage}
          options={MEMORY_USAGE_FILTERS.map((v) => ({ value: v, label: USAGE_LABEL[v] }))}
          onChange={(usage) => setFilters({ ...filters, usage: usage as never })}
        />
        <FilterSelect
          label="Scope"
          width="w-32"
          value={filters.scope}
          options={SCOPE_FILTERS.map((v) => ({ value: v, label: v === "all" ? "any scope" : v }))}
          onChange={(scope) => setFilters({ ...filters, scope: scope as never })}
        />
        <FilterSelect
          label="Kind"
          width="w-32"
          value={filters.kind}
          options={KIND_FILTERS.map((v) => ({ value: v, label: v === "all" ? "any kind" : v }))}
          onChange={(kind) => setFilters({ ...filters, kind: kind as never })}
        />
        <FilterSelect
          label="Status"
          width="w-28"
          value={filters.status}
          options={STATUS_FILTERS.map((v) => ({ value: v, label: v }))}
          onChange={(status) => setFilters({ ...filters, status: status as never })}
        />
        <FilterSelect
          label="Sort"
          width="w-40"
          value={filters.sort}
          options={MEMORY_ENTRY_SORTS.map((v) => ({ value: v, label: SORT_LABEL[v] }))}
          onChange={(sort) => setFilters({ ...filters, sort: sort as never })}
        />

        <form
          className="relative ml-auto flex items-center"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters({ ...filters, q: draftQuery });
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-chrome" aria-hidden />
          <input
            type="search"
            value={draftQuery}
            aria-label="Search memories"
            placeholder="Search content or cues…"
            className="h-8 w-56 rounded-md border border-border bg-background pl-8 pr-7 text-xs outline-none placeholder:text-chrome focus:border-ring [&::-webkit-search-cancel-button]:hidden"
            onChange={(event) => setDraftQuery(event.target.value)}
          />
          {draftQuery && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-2 text-chrome hover:text-foreground"
              onClick={() => {
                setDraftQuery("");
                setFilters({ ...filters, q: "" });
              }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </form>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-sel px-2 py-0.5 text-2xs text-foreground"
              onClick={() => setFilters(withoutFilter(filters, chip.key))}
            >
              {chip.label}
              <X className="h-3 w-3" aria-hidden />
            </button>
          ))}
          {hasActiveFilters(filters) && (
            <button
              type="button"
              className="text-2xs text-chrome underline underline-offset-2 hover:text-foreground"
              onClick={() => setFilters({ ...filters, ...clearedView })}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-chrome">
          {loading ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? "memory" : "memories"}`}
        </span>
        {entries.length > 0 && entries.length < total && (
          <span className="text-2xs text-chrome">showing {entries.length}</span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <EntryList
        entries={entries}
        loading={loading}
        usageFilter={filters.usage}
        resolveProject={(id) => projectNames.get(id)}
        onSelect={setSelected}
      />

      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={appending}
            onClick={() => void load(offset + PAGE_SIZE, "append")}
          >
            {appending ? "Loading…" : `Load ${Math.min(PAGE_SIZE, total - entries.length)} more`}
          </Button>
        </div>
      )}

      <MemoryDetailDialog
        entry={selected}
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  );
}

/**
 * One filter control. The shared trigger is `w-full`, which in a wrapping row
 * makes every select claim its own line; each gets a width sized to its longest
 * option instead.
 */
function FilterSelect({
  label,
  width,
  value,
  options,
  onChange
}: {
  label: string;
  width: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <SimpleSelect
      aria-label={label}
      className={cn("h-8 shrink-0 px-2 text-xs", width)}
      value={value}
      options={options}
      onValueChange={onChange}
    />
  );
}

/** Everything except the free-text term, which the search box owns. */
const clearedView: Partial<MemoryFilters> = {
  scope: "all",
  projectId: "",
  featureId: "",
  kind: "all",
  status: "available",
  usage: "all",
  sort: "recent"
};

function EntryList({
  entries,
  loading,
  usageFilter,
  resolveProject,
  onSelect
}: {
  entries: MemoryEntryDto[];
  loading: boolean;
  usageFilter: string;
  resolveProject: (projectId: string) => string | undefined;
  onSelect: (entry: MemoryEntryDto) => void;
}) {
  if (loading && entries.length === 0) {
    return <div className="py-12 text-center text-sm text-chrome">Loading memories…</div>;
  }
  if (entries.length === 0) {
    return (
      <div className="py-16 text-center">
        <Brain className="mx-auto h-8 w-8 text-chrome/50" aria-hidden />
        <p className="mt-3 text-sm text-muted-foreground">No memories match these filters.</p>
      </div>
    );
  }
  return (
    <div className="divide-y divide-border-soft overflow-hidden rounded-lg border border-border-soft">
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          usageFilter={usageFilter}
          resolveProject={resolveProject}
          onSelect={() => onSelect(entry)}
        />
      ))}
    </div>
  );
}

function EntryRow({
  entry,
  usageFilter,
  resolveProject,
  onSelect
}: {
  entry: MemoryEntryDto;
  usageFilter: string;
  resolveProject: (projectId: string) => string | undefined;
  onSelect: () => void;
}) {
  const reason = entryReason(entry);
  const usage = usageSummary(entry, usageFilter);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-sel"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* The kind badge carries the kind; the location carries where it came
            from. Printing "procedural · console / …" beside a PROCEDURAL badge
            said the same word twice on every row. */}
        <KindBadge kind={entry.kind} />
        <span className="min-w-0 truncate text-2xs text-chrome">
          {entryLocation(entry, resolveProject)}
        </span>
        {entry.status === "archived" && (
          <span className="shrink-0 text-2xs text-chrome line-through">archived</span>
        )}
        <span
          className="ml-auto shrink-0 text-2xs text-chrome"
          title={`recalled ${entry.recallCount}×, used ${entry.useCount}×`}
        >
          {usage ? (
            <>
              <span className={cn(usage.attention && "text-amber")}>{usage.text}</span>
              {" · "}
            </>
          ) : null}
          {formatRelativeTime(entry.createdAt)}
        </span>
      </div>
      <div className="line-clamp-2 break-words text-sm leading-relaxed text-foreground/90">
        {entry.content}
      </div>
      {reason && <div className="line-clamp-1 text-2xs italic text-chrome">{reason}</div>}
    </button>
  );
}
