import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, Search, X } from "lucide-react";
import type { MemoryEntriesResponse, MemoryEntryDto, MemoryStatsResponse } from "@shared/api-contracts";
import { MEMORY_ENTRY_SORTS } from "@shared/api-contracts";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/MarkdownView";
import { SimpleSelect } from "@/components/ui/select";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import { formatRelativeTime } from "@/lib/format";
import { useScrollEdges } from "@/hooks/useScrollEdges";
import { cn } from "@/lib/utils";
import { EntryLine, MemoryDetailDialog } from "./MemoryEntryDetail";
import { entryReason, projectNameResolver, SOURCE_LABEL } from "./memory-entry";
import {
  SOURCE_FILTERS,
  TYPE_FILTERS,
  SORT_LABEL,
  activeChips,
  entriesQuery,
  scopeOptions,
  hasActiveFilters,
  withoutFilter,
  type MemoryFilters
} from "./memory-filters";
import { errorText } from "@shared/error-text";
import { InlineError, LoadingLine } from "@/components/ViewState";

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
  // The last read that failed, and which: the list itself, or its next page.
  const [failure, setFailure] = useState<{ message: string; mode: "replace" | "append" } | null>(null);
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

  // Only the newest read may change the list, its failure or the loading
  // flags: a Retry or a next page carries no abort signal, and one still on
  // its way when the filters change answers for filters no longer shown.
  const readSeq = useRef(0);
  const load = useCallback(
    async (nextOffset: number, mode: "replace" | "append", signal?: AbortSignal) => {
      const seq = ++readSeq.current;
      if (mode === "replace") setLoading(true);
      else setAppending(true);
      setFailure(null);
      try {
        const params = entriesQuery(filters, { limit: PAGE_SIZE, offset: nextOffset });
        const res = await fetch(api.memoryEntries(params), { signal });
        const payload = await readJson<MemoryEntriesResponse>(res);
        if (seq !== readSeq.current) return;
        setTotal(payload.total);
        setOffset(nextOffset);
        setEntries((prev) => (mode === "append" ? [...prev, ...payload.entries] : payload.entries));
        setFailure(null);
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || seq !== readSeq.current) return;
        setFailure({ message: errorText(err), mode });
        // The rows on screen were read under other filters: none of them is
        // an answer to this one.
        if (mode === "replace") {
          setEntries([]);
          setTotal(0);
        }
      } finally {
        if (seq === readSeq.current) {
          setLoading(false);
          setAppending(false);
        }
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

  // The one lookup every memory view uses: it also names projects whose
  // memories are all archived, which byProject (live counts) does not list.
  const resolveProject = useMemo(() => projectNameResolver(stats), [stats]);
  const chips = activeChips(filters, {
    project: filters.projectId ? resolveProject(filters.projectId) : undefined
  });
  const hasMore = entries.length < total;
  const { ref: filterRowRef, more: filterRowMore, onFocus: revealFilter } = useScrollEdges<HTMLDivElement>();

  return (
    <div className="flex flex-col gap-3">
      {/* Wrapped rows of selects sit 16px apart on a touch screen, so their
          44px touch areas do not overlap. Narrow, the search takes a row of
          its own under the selects; one column, not wrapped: a wrapped
          column stretches its items to the widest one's full length, the
          selects' row, rather than to the screen. */}
      <div className="flex flex-wrap items-center gap-2 pointer-coarse:gap-y-4 @max-[34rem]:flex-col @max-[34rem]:flex-nowrap @max-[34rem]:items-stretch">
        {/* Narrow, the four selects keep to one row that scrolls sideways
            and fades on the side with more, rather than wrapping into three.
            It reaches 4px past each side for the focus rings and 8px above
            and below for the touch areas, which its overflow would clip; a
            select reached by keyboard scrolls clear of the fades. Wider, the
            row is no box at all (contents): the selects and the search wrap
            as one line of items, as they always did. */}
        <div
          ref={filterRowRef}
          data-slot="memory-filters"
          data-more={filterRowMore === "none" ? undefined : filterRowMore}
          onFocus={revealFilter}
          className="fade-x-edges contents @max-[34rem]:relative @max-[34rem]:-mx-1 @max-[34rem]:-my-2 @max-[34rem]:flex @max-[34rem]:flex-nowrap @max-[34rem]:items-center @max-[34rem]:gap-2 @max-[34rem]:overflow-x-auto @max-[34rem]:overscroll-x-contain @max-[34rem]:px-1 @max-[34rem]:py-2 @max-[34rem]:[scrollbar-width:none] @max-[34rem]:[&::-webkit-scrollbar]:hidden"
        >
          {/* Where: the user's memories, any project, or one project. */}
          <FilterSelect
            label="Scope"
            width="w-36"
            value={filters.projectId ? `project:${filters.projectId}` : filters.scope}
            options={scopeOptions(stats, filters.projectId)}
            onChange={(value) => setFilters(
              value.startsWith("project:")
                ? { ...filters, scope: "all", projectId: value.slice("project:".length) }
                : { ...filters, scope: value as never, projectId: "" }
            )}
          />
          <FilterSelect
            label="Type"
            width="w-32"
            value={filters.type}
            options={TYPE_FILTERS.map((v) => ({ value: v, label: TYPE_OPTION[v] }))}
            onChange={(type) => setFilters({ ...filters, type: type as never })}
          />
          <FilterSelect
            label="Source"
            width="w-36"
            value={filters.source}
            options={SOURCE_FILTERS.map((v) => ({ value: v, label: SOURCE_OPTION[v] }))}
            onChange={(source) => setFilters({ ...filters, source: source as never })}
          />
          <FilterSelect
            label="Sort"
            width="w-40"
            value={filters.sort}
            options={MEMORY_ENTRY_SORTS.map((v) => ({ value: v, label: SORT_LABEL[v] }))}
            onChange={(sort) => setFilters({ ...filters, sort: sort as never })}
          />
        </div>

        <form
          className="relative ml-auto flex items-center @max-[34rem]:ml-0"
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
            placeholder="Search memories…"
            className="h-8 w-56 @max-[34rem]:w-full rounded-md border border-border bg-background pl-8 pr-7 text-xs outline-none placeholder:text-chrome focus:border-ring [&::-webkit-search-cancel-button]:hidden"
            onChange={(event) => setDraftQuery(event.target.value)}
          />
          {draftQuery && (
            <button
              type="button"
              aria-label="Clear search"
              className="hit absolute right-2 text-chrome hover:text-foreground"
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
        // On a touch screen 28px between wrapped rows, and 20px below the
        // filters: a 22px chip's touch area reaches 11px past it, Clear
        // all's 14px, the search field's clear 6px below the field.
        <div className="flex flex-wrap items-center gap-2 pointer-coarse:mt-2 pointer-coarse:gap-y-7">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="hit relative inline-flex items-center gap-1 rounded-md border border-border bg-sel px-2 py-0.5 text-2xs text-foreground"
              onClick={() => setFilters(withoutFilter(filters, chip.key))}
            >
              {chip.label}
              <X className="h-3 w-3" aria-hidden />
            </button>
          ))}
          {hasActiveFilters(filters) && (
            <button
              type="button"
              className="hit relative text-2xs text-chrome underline underline-offset-2 hover:text-foreground"
              onClick={() => setFilters({ ...filters, ...clearedView })}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {failure?.mode === "replace" ? (
        // Said alone: a count or "No memories match" beside it would claim
        // the list was read.
        <InlineError detail={failure.message} onRetry={() => void load(0, "replace")}>
          Couldn't load memories.
        </InlineError>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-chrome">
              {loading ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? "memory" : "memories"}`}
            </span>
            {entries.length > 0 && entries.length < total && (
              <span className="text-2xs text-chrome">showing {entries.length}</span>
            )}
          </div>

          <EntryList
            entries={entries}
            loading={loading}
            resolveProject={resolveProject}
            onSelect={setSelected}
          />
        </>
      )}

      {hasMore && failure?.mode === "append" && (
        <InlineError detail={failure.message} onRetry={() => void load(offset + PAGE_SIZE, "append")}>
          Couldn't load more memories.
        </InlineError>
      )}
      {hasMore && failure?.mode !== "append" && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            // Not while the list itself is being read: a page past rows
            // about to be replaced would supersede the read that replaces them.
            disabled={appending || loading}
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
        resolveProject={resolveProject}
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
  type: "all",
  source: "all",
  sort: "recent"
};

const TYPE_OPTION: Record<(typeof TYPE_FILTERS)[number], string> = {
  all: "Any type",
  preference: "Preferences",
  knowledge: "Knowledge"
};

const SOURCE_OPTION: Record<(typeof SOURCE_FILTERS)[number], string> = {
  all: "Any source",
  user: "Said by you",
  agent: "Agent",
  extraction: "Extracted"
};

function EntryList({
  entries,
  loading,
  resolveProject,
  onSelect
}: {
  entries: MemoryEntryDto[];
  loading: boolean;
  resolveProject: (projectId: string) => string | undefined;
  onSelect: (entry: MemoryEntryDto) => void;
}) {
  if (loading && entries.length === 0) return <LoadingLine />;
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
          resolveProject={resolveProject}
          onSelect={() => onSelect(entry)}
        />
      ))}
    </div>
  );
}

function EntryRow({
  entry,
  resolveProject,
  onSelect
}: {
  entry: MemoryEntryDto;
  resolveProject: (projectId: string) => string | undefined;
  onSelect: () => void;
}) {
  const reason = entryReason(entry);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-sel"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <EntryLine entry={entry} resolveProject={resolveProject} />
        <span className="ml-auto shrink-0 text-2xs text-chrome">
          {SOURCE_LABEL[entry.source]}
          {" · "}
          {formatRelativeTime(entry.createdAt)}
        </span>
      </div>
      <div className="line-clamp-2 break-words text-sm leading-relaxed text-foreground/90">
        <MarkdownView text={entry.content} inline />
      </div>
      {reason && <div className="line-clamp-1 text-2xs italic text-chrome">{reason}</div>}
    </button>
  );
}
