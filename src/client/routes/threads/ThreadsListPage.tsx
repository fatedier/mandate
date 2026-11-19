import { useMemo, useRef, useState, useLayoutEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { MoreHorizontal, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { LabelField } from "@/components/LabelField";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useKnownLabels } from "@/lib/known-labels";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PillTabs } from "@/components/PillTabs";
import { InlineError } from "@/components/ViewState";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useNow } from "@/hooks/useNow";
import { useThreadDots } from "@/hooks/useThreadDots";
import { formatCalendarDate, formatRelativeTime } from "@/lib/format";
import { threadHref } from "@/lib/worker-href";
import { cn } from "@/lib/utils";
import { PaneHeaderActions, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadsListStore } from "@/store/threads-list";
import type { ArchivedThreadDto, ThreadLabelDto } from "@shared/api/agents";
import type { ThreadDot } from "@shared/thread-dot";
import { ArchiveThreadDialog } from "./ArchiveThreadDialog";
import { DeleteArchivedThreadsDialog, DeleteThreadDialog } from "./DeleteThreadDialogs";
import { ClearThreadFilters, ThreadFilterBar, ThreadFilterPhone } from "./ThreadFilters";
import { ThreadLabelChips } from "./ThreadLabels";
import { useProjectFilterFromAddress } from "./thread-filter-address";
import { fitCount, listedThreads, matchesFilters, matchesQuery, type ListedThread, type ThreadsTab } from "./thread-list";

/** How many of a thread's projects a desktop row names at most, before it counts the rest. */
const PROJECTS_SHOWN = 2;
/** The room a row keeps for "+N" after what it names. */
const MORE_WIDTH = 24;

/** The columns of a desktop row: its checkbox, then the thread, which takes
 *  what the others leave. A pane of 600px gives it about 200px. */
const COLUMNS = "grid grid-cols-[0.875rem_minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_4.5rem] items-center gap-3";
const CHECKBOX = "relative z-10 size-3.5 shrink-0 accent-primary";
// `hit`: on a touch screen its 36px reach 44 to touch.
const BAR_BUTTON = "hit relative h-7 shrink-0 rounded-md border border-border-soft bg-background px-2 text-xs text-foreground hover:bg-sel disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-9 pointer-coarse:px-3";

/**
 * Every manager thread: the open ones on Active, by last activity, and the
 * archived ones on Archived, by when they were archived. The search reads
 * titles, the Label and Project filters narrow the tab shown; a row opens
 * its thread. Rows can be selected, to label several threads or delete
 * several archived ones together. The sidebar lists only the open ones and
 * leads here.
 */
export function ThreadsListPage() {
  useProjectFilterFromAddress();
  const phone = useIsMobile();
  const threads = useManagerThreadsStore((s) => s.threads);
  const archived = useManagerThreadsStore((s) => s.archived);
  // Whether each list has arrived: the open threads come with the stream,
  // the archived ones are read. Until then nothing is said to be empty.
  const openRead = useManagerThreadsStore((s) => s.loaded);
  const archivedRead = useManagerThreadsStore((s) => s.archivedLoaded);
  const archivedUnread = useManagerThreadsStore((s) => s.archivedReadFailed);
  const tab = useThreadsListStore((s) => s.tab);
  const filters = useThreadsListStore((s) => s.filters);
  const [query, setQuery] = useState("");
  const [deletingAll, setDeletingAll] = useState(false);
  // The rows ticked, and on a phone whether there is anything to tick: its
  // checkboxes show only after Select.
  const [selected, setSelected] = useState<ReadonlySet<string>>(NONE);
  const [selecting, setSelecting] = useState(false);
  // A dialog of the selection's gives focus back to the bar's button, which
  // has gone with the rows it acted on: focus then goes to the search, not
  // to the page. Not on a touch screen, where a focused field brings up the
  // keyboard for nothing.
  const searchRef = useRef<HTMLInputElement>(null);
  const keepFocus = () => requestAnimationFrame(() => {
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) searchRef.current?.focus();
  });
  // The threads a dialog was opened for, as they were when it was asked: as
  // they go, their rows leave the list and the selection with them, and the
  // dialog stays the one it was until it is done.
  const [deleting, setDeleting] = useState<ArchivedThreadDto[] | null>(null);
  const [archiving, setArchiving] = useState<readonly string[] | null>(null);
  const dots = useThreadDots();
  const now = useNow();
  const all = useMemo(() => listedThreads(threads.values(), archived, tab), [threads, archived, tab]);
  const shown = useMemo(() => all.filter((thread) => matchesQuery(thread, query) && matchesFilters(thread, filters)), [all, query, filters]);
  const tabs = [
    { id: "active" as const, label: "Active", ...(openRead ? { count: threads.size } : {}) },
    { id: "archived" as const, label: "Archived", ...(archivedRead ? { count: archived.length } : {}) }
  ];
  const read = tab === "active" ? openRead : archivedRead;
  const when = (thread: ListedThread) => (thread.archived ? formatCalendarDate(thread.at, now) : formatRelativeTime(thread.at, now));
  // The selection is of rows shown: one narrowed away, archived or deleted
  // elsewhere, or left behind by a change of tab is dropped, for good.
  const chosen = shown.filter((thread) => selected.has(thread.id));
  if (chosen.length !== selected.size) setSelected(new Set(chosen.map((thread) => thread.id)));
  const selectable = !phone || selecting;
  const toggle = (id: string) => setSelected((held) => {
    const next = new Set(held);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  // The head's box: every row shown, or none once any is ticked.
  const toggleAll = () => setSelected(chosen.length > 0 ? NONE : new Set(shown.map((thread) => thread.id)));
  const rowProps = (thread: ListedThread) => ({
    thread, dot: dots.get(thread.id) ?? ("idle" as ThreadDot), when: when(thread),
    ...(selectable ? { selected: selected.has(thread.id), onToggle: () => toggle(thread.id) } : {})
  });
  const allBox = (
    <input
      type="checkbox"
      data-slot="threads-select-all"
      aria-label="Select all"
      className={CHECKBOX}
      checked={chosen.length > 0 && chosen.length === shown.length}
      ref={(box) => { if (box) box.indeterminate = chosen.length > 0 && chosen.length < shown.length; }}
      onChange={toggleAll}
    />
  );
  const selectionBar = (
    <div data-slot="threads-selection-bar" className="flex h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border-soft px-2 text-xs pointer-coarse:h-auto pointer-coarse:py-1.5">
      {!phone && allBox}
      <span data-slot="threads-selected-count" className="mr-1 tabular-nums text-muted-foreground">{chosen.length} selected</span>
      <BulkLabel disabled={chosen.length === 0} threadIds={chosen.map((thread) => thread.id)} />
      {tab === "active"
        ? <button type="button" className={BAR_BUTTON} disabled={chosen.length === 0} onClick={() => setArchiving(chosen.map((thread) => thread.id))}>Archive…</button>
        : <button type="button" className={BAR_BUTTON} disabled={chosen.length === 0} onClick={() => setDeleting(archived.filter((thread) => selected.has(thread.id)))}>Delete…</button>}
      {phone && <button type="button" className={cn(BAR_BUTTON, "ml-auto")} onClick={() => { setSelecting(false); setSelected(NONE); }}>Done</button>}
    </div>
  );

  let body;
  if (!read) {
    // Not known yet: no row, and no sentence that there are none.
    body = null;
  } else if (all.length === 0) {
    body = <p data-slot="threads-empty" className="px-6 py-16 text-center text-sm text-muted-foreground">{tab === "active" ? "No active threads." : "No archived threads."}</p>;
  } else if (shown.length === 0) {
    body = (
      <div data-slot="threads-empty" className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
        <p>No threads match.</p>
        {(filters.labels.length > 0 || filters.projects.length > 0) && <ClearThreadFilters />}
      </div>
    );
  } else if (phone) {
    body = (
      <div data-slot="threads-list" className="flex flex-col">
        {shown.map((thread) => <PhoneRow key={thread.id} {...rowProps(thread)} />)}
      </div>
    );
  } else {
    body = (
      <div data-slot="threads-list" className="flex flex-col">
        {/* With rows selected, what can be done with them stands where the
            column heads were. */}
        {chosen.length > 0 ? selectionBar : (
          <div data-slot="threads-head" className={cn(COLUMNS, "h-9 shrink-0 border-b border-border-soft px-2 text-2xs text-faint")}>
            {allBox}
            {["Thread", "Labels", "Project", tab === "active" ? "Last activity" : "Archived"].map((head, index) => (
              <span key={head} data-slot="threads-head-cell" className={cn("truncate", index === 0 && "pl-5", index === 3 && "text-right")}>{head}</span>
            ))}
          </div>
        )}
        {shown.map((thread) => <DesktopRow key={thread.id} {...rowProps(thread)} />)}
      </div>
    );
  }

  return (
    <div data-slot="threads-page" className="flex min-h-0 w-full flex-1 flex-col">
      <PaneHeaderTitle>
        <h1 className="truncate text-sm font-semibold text-foreground">Threads</h1>
      </PaneHeaderTitle>
      {tab === "archived" && archived.length > 0 && (
        <PaneHeaderActions>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Archived thread actions" className="text-chrome">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={() => setDeletingAll(true)}>
                <Trash2 className="h-4 w-4" />
                Delete all archived threads…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </PaneHeaderActions>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-1 pb-3 md:px-6">
        <PillTabs aria-label="Threads" items={tabs} value={tab} onChange={(next: ThreadsTab) => useThreadsListStore.getState().setTab(next)} />
        <span className="flex-1" />
        {phone ? <ThreadFilterPhone threads={all} /> : <ThreadFilterBar threads={all} />}
        {phone && !selecting && all.length > 0 && <button type="button" className={BAR_BUTTON} onClick={() => setSelecting(true)}>Select</button>}
        {/* On a phone the search has the row under the tabs to itself. */}
        <label className="flex h-7 w-48 items-center gap-1.5 rounded-md border border-border-soft bg-background px-2 text-xs focus-within:border-ring max-md:order-last max-md:h-9 max-md:w-full max-md:basis-full">
          <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
          <input
            type="search"
            ref={searchRef}
            aria-label="Search threads"
            placeholder="Search threads"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-faint"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 md:px-4">
        {/* A phone's bar stands over whatever the list shows, an empty one
            too: Done is the way out of selecting. */}
        {phone && selecting && selectionBar}
        {/* The latest read of the archived threads failed: what is listed
            may be missing some, or nothing was read at all. */}
        {tab === "archived" && archivedUnread && (
          <InlineError className="px-2 pb-3" onRetry={() => { void useManagerThreadsStore.getState().loadArchived(); }}>Couldn't load the archived threads.</InlineError>
        )}
        {body}
      </div>
      {archiving && <ArchiveThreadDialog threadIds={archiving} onDone={() => { setArchiving(null); keepFocus(); }} />}
      {deletingAll && <DeleteArchivedThreadsDialog threads={archived} all onDone={() => { setDeletingAll(false); keepFocus(); }} />}
      {/* One thread selected is deleted as from its own page, the page staying. */}
      {deleting?.length === 1 && <DeleteThreadDialog thread={deleting[0]!} stay onDone={() => { setDeleting(null); keepFocus(); }} />}
      {deleting && deleting.length > 1 && <DeleteArchivedThreadsDialog threads={deleting} all={false} onDone={() => { setDeleting(null); keepFocus(); }} />}
    </div>
  );
}

const NONE: ReadonlySet<string> = new Set();
const NO_LABELS: readonly ThreadLabelDto[] = [];

/** Add label, for the selected threads: the label field with nothing on it
 *  yet. What is chosen goes on each thread, one request after another; the
 *  first refusal is said, once. */
function BulkLabel({ threadIds, disabled }: { threadIds: readonly string[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const known = useKnownLabels();
  const agentName = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const add = async (name: string) => {
    setOpen(false);
    let refusal: string | null = null;
    for (const threadId of threadIds) {
      const result = await useManagerThreadsStore.getState().addLabel(threadId, name);
      if ("error" in result) refusal ??= result.error;
    }
    if (refusal !== null) toast.error(refusal);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={BAR_BUTTON} disabled={disabled}>Add label</button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 px-2 py-1">
        <LabelField slot="bulk" labels={NO_LABELS} known={known} agentName={agentName} autoFocus onAdd={(name) => { void add(name); }} onRemove={() => {}} />
      </PopoverContent>
    </Popover>
  );
}

/** What a row has when it can be selected: on a desktop always, on a phone
 *  after Select. */
interface RowProps {
  thread: ListedThread;
  dot: ThreadDot;
  when: string;
  selected?: boolean;
  onToggle?: () => void;
}

/** A row's checkbox, named for its thread. */
function RowBox({ thread, selected, onToggle }: { thread: ListedThread; selected: boolean; onToggle: () => void }) {
  return <input type="checkbox" data-slot="thread-row-select" aria-label={`Select ${thread.title}`} className={CHECKBOX} checked={selected} onChange={onToggle} />;
}

/** The thread's state, and its title as the link the whole row answers to
 *  (the link's box is stretched over the row); a duty thread says so. */
function TitleCell({ thread, dot, plain = false }: { thread: ListedThread; dot: ThreadDot; plain?: boolean }) {
  const title: ReactNode = <span className="min-w-0 truncate">{thread.title}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {/* An archived thread has no state: the slot keeps the titles in line. */}
      {thread.archived ? <span aria-hidden className="size-2.5 shrink-0" /> : <ThreadStateMark dot={dot} />}
      {/* The title is cut in a box of its own: the link's must not clip,
          or it would clip the area it stretches over the row. */}
      {plain ? <span data-slot="thread-row-title" className="flex min-w-0 text-[13px] text-foreground">{title}</span> : (
        <Link
          to={threadHref(thread.id)}
          data-slot="thread-row-title"
          // Over the row from where its checkbox ends: the two never share a
          // spot. Above the row's other cells (they are positioned, to be
          // measured), so a click on a label or a project opens the thread too.
          className="flex min-w-0 text-[13px] text-foreground after:absolute after:inset-y-0 after:right-0 after:left-[var(--row-link-from,0px)] after:z-10 focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:ring-1 focus-visible:after:ring-ring"
        >
          {title}
        </Link>
      )}
      {thread.duty && <span data-slot="thread-row-duty" className="shrink-0 rounded-full bg-sel px-2 text-2xs text-muted-foreground">On duty</span>}
    </span>
  );
}

function DesktopRow({ thread, dot, when, selected = false, onToggle }: RowProps) {
  return (
    <div
      data-slot="thread-row"
      data-thread-id={thread.id}
      // The link's area starts past the checkbox's column (its width, the gap and the row's padding).
      // `isolate`: the link's area is stacked above the cells of this row only.
      className={cn(COLUMNS, "relative isolate h-9 shrink-0 rounded-sm px-2 transition-colors [--row-link-from:1.75rem] hover:bg-sel pointer-coarse:h-11", selected && "bg-sel")}
    >
      <span aria-hidden />
      {/* The box takes every point left of the title's area, the row's full
          height: on a touch screen a 14px box is no target. */}
      {onToggle && (
        <label data-slot="thread-row-select-area" className="absolute inset-y-0 left-0 z-10 flex w-(--row-link-from) items-center pl-2">
          <RowBox thread={thread} selected={selected} onToggle={onToggle} />
        </label>
      )}
      <TitleCell thread={thread} dot={dot} />
      <FitLine
        slot="thread-row-labels"
        moreSlot="thread-label-more"
        items={thread.labels}
        gap={4}
        className="gap-1"
        render={(labels, ruler) => <ThreadLabelChips labels={labels} chipSlot={ruler ? "thread-label-ruler" : "thread-label"} chipClassName={ruler ? undefined : "min-w-0 shrink"} />}
      />
      <FitLine
        slot="thread-row-projects"
        moreSlot="thread-row-project-more"
        items={thread.projects}
        limit={PROJECTS_SHOWN}
        gap={6}
        className="gap-1.5 text-2xs text-faint"
        render={(projects, ruler) => projects.map((project) => (
          <span key={project} data-slot={ruler ? undefined : "thread-row-project"} className={ruler ? "shrink-0 whitespace-nowrap" : "min-w-0 truncate"}>{project}</span>
        ))}
      />
      <span data-slot="thread-row-time" className="truncate text-right text-2xs tabular-nums text-faint">{when}</span>
    </div>
  );
}

/**
 * One line of a row's cell: as many of its items as fit, then how many
 * more, right after them. The items are drawn a second time, unseen, at
 * their own widths; those widths and the cell's say how many to show
 * (fitCount), again whenever the cell's width moves. `limit` names at most
 * that many however much room there is.
 */
function FitLine<T>({ items, limit, gap, slot, moreSlot, className, render }: {
  items: readonly T[];
  limit?: number;
  /** The space between two items, in px: the cell's own gap. */
  gap: number;
  slot: string;
  moreSlot: string;
  className?: string;
  /** Draws these items: `ruler` for the unseen copy that is measured. */
  render(items: readonly T[], ruler: boolean): ReactNode;
}) {
  const cell = useRef<HTMLSpanElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<number | null>(null);
  const named = limit === undefined ? items.length : Math.min(items.length, limit);
  const counted = items.length > named;
  useLayoutEffect(() => {
    const box = cell.current;
    const rule = ruler.current;
    if (!box || !rule) return;
    // Told once as it starts to watch, then whenever the cell's width moves.
    const watch = new ResizeObserver(() => {
      const widths = [...rule.children].map((item) => (item as HTMLElement).offsetWidth);
      setFit(fitCount(widths, box.clientWidth, { gap, more: MORE_WIDTH, counted }));
    });
    watch.observe(box);
    return () => watch.disconnect();
  }, [items, gap, counted]);
  const shown = Math.min(named, fit ?? named);
  const more = items.length - shown;
  return (
    <span ref={cell} data-slot={slot} className={cn("relative flex min-w-0 items-center overflow-hidden", className)}>
      <span ref={ruler} aria-hidden className={cn("pointer-events-none invisible absolute top-0 left-0 flex", className)}>{render(items.slice(0, named), true)}</span>
      {render(items.slice(0, shown), false)}
      {more > 0 && <span data-slot={moreSlot} className="shrink-0 text-2xs text-faint">+{more}</span>}
    </span>
  );
}

/** A phone's row: the title and the time, then every label and project,
 *  wrapping. */
function PhoneRow({ thread, dot, when, selected = false, onToggle }: RowProps) {
  // While selecting, the whole row is its checkbox's: touching it ticks, it
  // does not open the thread.
  const Row = onToggle ? "label" : "div";
  return (
    // 44px to touch inside its bottom line: the link's area stops at the border.
    <Row data-slot="thread-row" data-thread-id={thread.id} className={cn("relative flex min-h-[calc(2.75rem+1px)] shrink-0 flex-col justify-center gap-1.5 border-b border-border-soft px-2 py-2.5", selected && "bg-sel")}>
      <div className="flex min-w-0 items-center gap-2.5">
        {onToggle && <RowBox thread={thread} selected={selected} onToggle={onToggle} />}
        <span className="min-w-0 flex-1"><TitleCell thread={thread} dot={dot} plain={Boolean(onToggle)} /></span>
        <span data-slot="thread-row-time" className="shrink-0 text-2xs tabular-nums text-faint">{when}</span>
      </div>
      {(thread.labels.length > 0 || thread.projects.length > 0) && (
        <div data-slot="thread-row-meta" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 pl-5">
          <ThreadLabelChips labels={thread.labels} />
          {thread.projects.map((project) => <span key={project} data-slot="thread-row-project" className="text-2xs text-faint">{project}</span>)}
        </div>
      )}
    </Row>
  );
}
