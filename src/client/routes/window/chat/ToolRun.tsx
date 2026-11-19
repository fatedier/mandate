import { memo, useState } from "react";
import {
  AlarmClock,
  Bell,
  BookOpen,
  Brain,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleDashed,
  CircleDot,
  CircleQuestionMark,
  ExternalLink,
  FilePlus,
  FileText,
  FolderKanban,
  Image,
  ListChecks,
  Loader2,
  MessageSquareText,
  Pencil,
  Presentation,
  Radar,
  Search,
  SquareTerminal,
  StickyNote,
  Terminal,
  Wrench,
  X,
  type LucideIcon
} from "lucide-react";
import { BottomSheet, BottomSheetClose, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { Fold } from "@/components/Fold";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSecondClock } from "@/hooks/useSecondClock";
import { formatDateTimeTitle, formatDurationAttribute, formatElapsedClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ToolCallDetails } from "./ToolCallDetails";
import { imageSources, toolImageOf } from "./attachments";
import { ImageTiles } from "./ImageTiles";
import { LineCounts } from "./tool-details/blocks";
import { useNameLookup } from "./tool-details/names-context";
import { toolKind, type ToolKind } from "./tool-kind";
import { TaskChip } from "@/routes/task-board/TaskChip";
import {
  bashExitNote,
  callNote,
  describeCall,
  lineChanges,
  describeRun,
  rowElapsedMs,
  rowStatus,
  runFailedKey,
  runFromKey,
  runOpenKey,
  slowDuration,
  type CallPhrase,
  type RunSummary,
  type RunTally,
  type ToolRunRow
} from "./tool-run-summary";

/** The calls an agent made between two things it said, as one line of
 *  furniture: "Edited 2 files, ran 3 commands ›". The calls are the record,
 *  not the conversation, so they stay a tap away — inline on a desktop, where
 *  the chat is a pane beside the work, and in a sheet on a phone, where
 *  expanding in place would push the conversation off a small screen.
 *
 *  Failures stay on the line in red: a call that failed is the one thing in
 *  the run a reader may need to act on. */

const KIND_ICON: Record<ToolKind, LucideIcon> = {
  terminal: Terminal,
  file: FileText,
  edit: Pencil,
  write: FilePlus,
  image: Image,
  pane: SquareTerminal,
  memory: Brain,
  skill: BookOpen,
  plan: ListChecks,
  canvas: Presentation,
  worker: FolderKanban,
  alarm: AlarmClock,
  monitor: Radar,
  search: Search,
  history: MessageSquareText,
  link: ExternalLink,
  question: CircleQuestionMark,
  // As the On duty page, the notice cards and a subagent's line draw them.
  schedule: CalendarClock,
  notify: Bell,
  task: CircleDot,
  note: StickyNote,
  // As the sidebar's Calendar row draws it.
  calendar: CalendarDays,
  tool: Wrench
};

/** A call's mark in a list of calls: the kind of
 *  work, faint, when it succeeded (the usual case, so it carries no colour);
 *  red when it failed; a spinner while it runs. */
function CallMark({ row, className }: { row: ToolRunRow; className?: string }) {
  const status = rowStatus(row);
  const kind = toolKind(row.call.toolName, row.call.args);
  const size = cn("size-3.5 shrink-0", className);
  const Kind = KIND_ICON[kind];
  return (
    <span data-slot="call-status" data-status={status} data-kind={kind} className="flex shrink-0">
      {status === "running" ? (
        <Loader2 aria-label="Running" className={cn(size, "animate-spin text-muted-foreground")} />
      ) : status === "error" ? (
        <CircleAlert aria-label="Failed" className={cn(size, "text-destructive")} />
      ) : status === "ok" ? (
        <Kind aria-label="Completed" className={cn(size, "text-faint")} />
      ) : (
        <CircleDashed aria-label="No result" className={cn(size, "text-faint")} />
      )}
    </span>
  );
}

/** The thin line from a call's mark down to the next call's. It is drawn
 *  against the row's wrapper, not the button, so it runs on past the call's
 *  details when they are open. */
function CallConnector({ className }: { className: string }) {
  return <span data-slot="call-connector" aria-hidden className={cn("pointer-events-none absolute w-px bg-faint/40", className)} />;
}

/** The verb and what it acted on, a word-space apart whatever gap the row
 *  puts between its own parts. In a list of calls the verb leads in the
 *  foreground and the target falls back. */
function Phrase({ phrase, failed = false, inList = false }: { phrase: CallPhrase; failed?: boolean; inList?: boolean }) {
  return (
    <span data-slot="tool-phrase" className="flex min-w-0 items-baseline gap-1">
      {phrase.lead && (
        <span
          data-slot="tool-lead"
          className={cn(
            "whitespace-nowrap",
            // Alone, the verb is the whole phrase and gives way in a narrow
            // pane; beside a detail, it keeps its width and the detail
            // truncates instead.
            phrase.detail ? "shrink-0" : "min-w-0 truncate",
            phrase.leadIsToolName && "font-mono text-2xs",
            // A failed call's verb turns red too, so it is found in a list by
            // more than the size of its icon.
            failed ? "text-destructive" : inList && "text-foreground"
          )}
        >
          {phrase.lead}
        </span>
      )}
      {phrase.detail && (
        <span
          data-slot="tool-detail"
          className={cn(
            "min-w-0 truncate",
            phrase.detailIsCode && "font-mono text-2xs",
            inList ? "text-faint" : phrase.detailIsCode && "text-foreground"
          )}
        >
          {phrase.detail}
        </span>
      )}
      {/* In a listed call's button the chip is drawn only; the run's own line
          has a live one beside its button. */}
      {inList && phrase.taskId && <TaskChip id={phrase.taskId} inert className="self-center" />}
    </span>
  );
}

/** How many clauses of a tally a narrow pane (a phone, a pane under 34rem)
 *  has room for. Past them, the line counts the run's calls instead. */
const NARROW_CLAUSES = 2;

/** A finished run's clauses. The tally is the whole phrase, so it is what
 *  gives way: in a narrow pane by dropping whole clauses from the end, and
 *  then, if the first two still do not fit, by being cut. */
function TallyClauses({ tally }: { tally: RunTally }) {
  return (
    <span data-slot="tool-run-tally" className="min-w-0 truncate whitespace-nowrap">
      {tally.clauses.map((clause, index) => (
        <span key={index} data-slot="tool-run-clause" className={cn(index >= NARROW_CLAUSES && "@max-[34rem]:hidden")}>
          {index === 0 ? clause : `, ${clause}`}
        </span>
      ))}
    </span>
  );
}

/** Whether the line counts a run's calls: under way or live, how many it has
 *  made so far; finished, when its tally leaves calls out, at every width, or
 *  when a narrow pane leaves clauses out, there only. */
function runCount(summary: RunSummary, single: boolean, live: boolean): "always" | "narrow" | null {
  if (summary.running || live) return single ? null : "always";
  if (!summary.tally) return null;
  if (summary.tally.unnamed > 0) return "always";
  return summary.tally.clauses.length > NARROW_CLAUSES ? "narrow" : null;
}

/** How long a call under way has been running, counting up; nothing when its
 *  start is unknown (a result before it never came back). */
function RunningFor({ since, slot, className }: { since: string; slot: string; className: string }) {
  const now = useSecondClock();
  const start = Date.parse(since);
  if (!Number.isFinite(start)) return null;
  return (
    <span data-slot={slot} className={className}>
      {formatElapsedClock(now - start)}
    </span>
  );
}

/** What a call came back with, when its row says it ("· 2 results"). */
function CallNote({ row }: { row: ToolRunRow }) {
  const note = callNote(row);
  if (!note) return null;
  return <span data-slot="tool-call-note" className="shrink-0 whitespace-nowrap tabular-nums text-faint">· {note}</span>;
}

/** How long one call took, only when that is both known and worth the width. */
function CallDuration({ row }: { row: ToolRunRow }) {
  if (row.isRunning) {
    return row.startedAt
      ? <RunningFor since={row.startedAt} slot="tool-duration" className="shrink-0 text-2xs tabular-nums text-faint" />
      : null;
  }
  const elapsed = slowDuration(rowElapsedMs(row));
  if (!elapsed) return null;
  const completedAt = row.result?.createdAt ? formatDateTimeTitle(row.result.createdAt) : "";
  return (
    <time
      data-slot="tool-duration"
      className="shrink-0 text-2xs tabular-nums text-faint"
      dateTime={formatDurationAttribute(elapsed.ms)}
      title={completedAt ? `Completed ${completedAt}` : undefined}
    >
      {elapsed.label}
    </time>
  );
}

/** A finished run's line says no time: its calls' time added up read as the
 *  turn's, which the Worked-for footer says. Each call keeps its own — on its
 *  row, and for a run of one call on the line, which is that call's row. */
function runMeta(summary: RunSummary): { failed: string } {
  return { failed: summary.failed > 0 ? `${summary.failed} failed` : "" };
}

/** A long run opens on its latest calls, in the order they ran, so what the
 *  agent did last sits next to what came after it; the earlier ones are a
 *  press away, this many more at a time. */
const LATEST_SHOWN = 8;
const EARLIER_STEP = 50;

/** The call to mark a run open at, from `index` on: one with its answer, so
 *  it stays in the run (a call still on its way can turn out to have started
 *  a background task and leave the run for a line of its own, which would
 *  close the run under the reader); else the latest answered before it. */
function markableFrom(rows: readonly ToolRunRow[], index: number): ToolRunRow {
  const answered = rows.slice(index).find((row) => row.result) ?? rows.slice(0, index).findLast((row) => row.result);
  return answered ?? rows[index]!;
}

/** Where an open run's list starts, from the call it was opened at (which
 *  stays where it is as calls come in, so what was shown stays shown): never
 *  later than its latest calls. Null when no call is the anchor. */
function shownFrom(rows: readonly ToolRunRow[], isAnchor: (row: ToolRunRow) => boolean): number | null {
  const anchored = rows.findIndex(isAnchor);
  return anchored === -1 ? null : Math.min(anchored, Math.max(0, rows.length - LATEST_SHOWN));
}

/** The row over a long run's list: how many calls came before the ones
 *  shown, and how many of those failed; pressed, 50 more. */
function EarlierCalls({ rows, onPress, className }: { rows: readonly ToolRunRow[]; onPress: () => void; className?: string }) {
  const failed = rows.filter((row) => rowStatus(row) === "error").length;
  return (
    <button
      type="button"
      data-slot="tool-run-earlier"
      onClick={onPress}
      className={cn("flex w-fit max-w-full items-center gap-2 self-start rounded-sm bg-sel px-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground", className)}
    >
      <ChevronUp aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        <span className="text-foreground">{rows.length} earlier {rows.length === 1 ? "call" : "calls"}</span>
        {failed > 0 && <span className="text-destructive">{` · ${failed} failed`}</span>}
      </span>
    </button>
  );
}

interface ToolRunProps {
  rows: ToolRunRow[];
  /** The running turn is on this run (liveRunRow). Its line names the call
   *  under way, else the latest one, with that call's mark, until the turn
   *  writes or ends; then the tally. A quick call ran for a frame, so a line
   *  naming only a running call said nothing of what the turn did. */
  live?: boolean;
  /** Which runs and calls are open, when the list keeps that (it pauses
   *  follow-the-bottom while anything is open). Local otherwise. */
  expandedIds?: Set<string>;
  onExpandedChange?: (id: string, expanded: boolean) => void;
}

function ToolRunImpl({ rows, live = false, expandedIds, onExpandedChange }: ToolRunProps) {
  const isMobile = useIsMobile();
  const names = useNameLookup();
  const [localExpanded, setLocalExpanded] = useState<Set<string>>(() => new Set());
  const [sheetOpen, setSheetOpen] = useState(false);
  // The phone's sheet, opened by the red count: only the failed calls. (In
  // place, the marks say it: runFailedKey.)
  const [sheetFailedOnly, setSheetFailedOnly] = useState(false);
  // Where the phone's sheet lists from, by position: a call still on its way
  // there can leave the run (a background task), and the list keeps its
  // place, as new calls come in under it.
  const [sheetFrom, setSheetFrom] = useState(0);
  const open = expandedIds ?? localExpanded;
  const setOpen = (id: string, next: boolean) => {
    if (!expandedIds) {
      setLocalExpanded((current) => {
        const copy = new Set(current);
        if (next) copy.add(id);
        else copy.delete(id);
        return copy;
      });
    }
    onExpandedChange?.(id, next);
  };
  if (rows.length === 0) return null;
  const summary = describeRun(rows, names);
  const meta = runMeta(summary);
  // The call a live line names: the one under way, else the latest.
  const current = rows.find((row) => row.isRunning) ?? rows[rows.length - 1]!;
  const expanded = !isMobile && rows.some((row) => open.has(runOpenKey(row.call.toolCallId)));
  const single = rows.length === 1;
  // The task the line's call acted on (a live line's current call, or a lone
  // call): a chip beside the line, a link of its own.
  const lineTask = live ? describeCall(current, names).taskId : single ? describeCall(rows[0]!, names).taskId : undefined;
  // Its red count is a control of its own when there is a list to pick from.
  const failedControl = !single && summary.failed > 0;
  const failedRows = rows.filter((row) => rowStatus(row) === "error");
  const listingFailed = failedControl && rows.some((row) => open.has(runFailedKey(row.call.toolCallId)));
  // Where the list starts: its own mark, else the call it is held open at;
  // and never past a call whose details are open (a run that lost calls on
  // the way, background tasks, then grew would move its start past it).
  const marked = shownFrom(rows, (row) => open.has(runFromKey(row.call.toolCallId)))
    ?? shownFrom(rows, (row) => open.has(runOpenKey(row.call.toolCallId)))
    ?? Math.max(0, rows.length - LATEST_SHOWN);
  const firstOpenCall = rows.findIndex((row) => open.has(row.call.toolCallId));
  const from = firstOpenCall === -1 ? marked : Math.min(marked, firstOpenCall);
  const latestId = rows[Math.max(0, rows.length - LATEST_SHOWN)]!.call.toolCallId;
  const ownTime = single && !summary.running ? slowDuration(rowElapsedMs(rows[0]!)) : null;
  const count = runCount(summary, single, live);
  // What the run looked at stays in sight, folded or not: a strip of
  // thumbnails, each opening its original.
  const viewed = rows.flatMap((row) => {
    const image = row.result && !row.result.isError ? toolImageOf(row.result.result)?.image : null;
    return image ? [{ id: image.id, alt: image.displayPath || image.name || "Viewed image", ...imageSources(image) }] : [];
  });
  // Closing takes every mark the run holds, its calls' included, so
  // reopening it starts from the list of calls again.
  const closeRun = () => {
    for (const row of rows) {
      const id = row.call.toolCallId;
      for (const key of [runOpenKey(id), runFailedKey(id), runFromKey(id), id]) if (open.has(key)) setOpen(key, false);
    }
  };
  // Opened with its list starting at `firstId`: held open at that call when
  // it has its answer, else at the nearest one that has (markableFrom), with
  // where the list starts marked apart; listing the failures, the mode goes
  // with the open mark. The marks elsewhere in the run let go.
  const markAt = (firstId: string, failed: boolean) => {
    const first = rows.findIndex((row) => row.call.toolCallId === firstId);
    const held = markableFrom(rows, Math.max(0, first)).call.toolCallId;
    const wanted = new Set([runOpenKey(held), ...(failed ? [runFailedKey(held)] : []), ...(held !== firstId ? [runFromKey(firstId)] : [])]);
    for (const key of wanted) setOpen(key, true);
    for (const row of rows) {
      const id = row.call.toolCallId;
      for (const key of [runOpenKey(id), runFailedKey(id), runFromKey(id)]) if (!wanted.has(key) && open.has(key)) setOpen(key, false);
    }
  };
  // Opened at its latest calls (the mark of the first one shown), or by its
  // red count at its failed ones; each control closes what it opened and
  // switches what the other opened.
  const openAs = (failed: boolean) => {
    if (isMobile) {
      setSheetFailedOnly(failed);
      setSheetFrom(Math.max(0, rows.length - LATEST_SHOWN));
      setSheetOpen(true);
      return;
    }
    if (expanded && listingFailed === failed) {
      closeRun();
      return;
    }
    // Listing the failures, marked on the first one (it stays in the run).
    markAt(failed ? failedRows[0]!.call.toolCallId : latestId, failed);
  };
  const toggleRun = () => openAs(false);
  // 50 more: the run is marked open at the first one shown now.
  const showEarlier = () => markAt(rows[Math.max(0, from - EARLIER_STEP)]!.call.toolCallId, false);

  const failedText = meta.failed && `· ${meta.failed}`;
  const chevron = <ChevronRight className={cn("size-3 shrink-0 text-faint transition-transform", expanded && "rotate-90")} />;
  const lineBody = (
    <>
      {live ? (
        <>
          <CallMark row={current} />
          <Phrase phrase={describeCall(current, names)} failed={rowStatus(current) === "error"} />
          <CallNote row={current} />
        </>
      ) : (
        <>
          {summary.running && <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />}
          {summary.tally ? <TallyClauses tally={summary.tally} /> : summary.phrase && <Phrase phrase={summary.phrase} />}
          {single && <CallNote row={rows[0]!} />}
        </>
      )}
      {/* What the run changed, once it has: a count that grows under the
          reader while calls land would read as the step's own. Beside a
          failure a narrow pane has no room for it: the second clause was
          cut mid-word ("ran 2 comm…"), so the counts wait on the calls. */}
      {!summary.running && !live && <LineCounts changes={summary.lines} className={cn(meta.failed && "@max-[34rem]:hidden")} />}
      {count && (
        <span
          data-slot="tool-run-count"
          className={cn("shrink-0 whitespace-nowrap tabular-nums text-faint", count === "narrow" && "hidden @max-[34rem]:inline")}
        >
          · {summary.count} calls
        </span>
      )}
    </>
  );

  return (
    <div data-slot="tool-run" className="flex min-w-0 flex-col gap-0.5">
      {/* One line, the same element whatever it holds, so a control with
          focus is never drawn anew under it (a run's first failure, its
          second call). Its red count is a control of its own when there is
          a list to pick the failures from; the arrow is the run's, for a
          pointer. */}
      <div data-slot="tool-run-head" className="-ml-1.5 flex min-h-7 max-w-full min-w-0 items-center self-start rounded-sm text-xs text-muted-foreground transition-colors hover:bg-sel">
        <button
          type="button"
          data-slot="tool-run-line"
          aria-expanded={isMobile ? undefined : expanded && !listingFailed}
          aria-haspopup={isMobile ? "dialog" : undefined}
          onClick={toggleRun}
          className="flex min-h-7 min-w-0 items-center gap-1.5 rounded-sm py-0.5 pl-1.5 text-left transition-colors hover:text-foreground"
        >
          {lineBody}
          {meta.failed && !failedControl && (
            <span data-slot="tool-run-failed" className="shrink-0 whitespace-nowrap text-destructive">{failedText}</span>
          )}
          {ownTime && (
            <time
              data-slot="tool-run-duration"
              dateTime={formatDurationAttribute(ownTime.ms)}
              className="shrink-0 whitespace-nowrap tabular-nums text-faint"
            >
              · {ownTime.label}
            </time>
          )}
        </button>
        {lineTask && <TaskChip id={lineTask} className="ml-1 self-center" />}
        {failedControl && (
          <button
            type="button"
            data-slot="tool-run-failed"
            aria-expanded={isMobile ? undefined : expanded && listingFailed}
            aria-haspopup={isMobile ? "dialog" : undefined}
            onClick={() => openAs(true)}
            className="flex min-h-7 shrink-0 items-center whitespace-nowrap rounded-sm py-0.5 pl-1.5 text-destructive transition-colors hover:underline"
          >
            {failedText}
          </button>
        )}
        <span aria-hidden onClick={toggleRun} className="flex min-h-7 cursor-pointer items-center py-0.5 pl-1.5 pr-1.5">{chevron}</span>
      </div>
      {viewed.length > 0 && <ImageTiles images={viewed} limit={4} className="mb-1 mt-0.5" />}
      <Fold open={expanded}>
        {single ? (
          <ToolCallDetails row={rows[0]!} className="pb-1 pl-5 pt-1" />
        ) : listingFailed ? (
          <ToolCallRows rows={failedRows} open={open} onToggle={setOpen} />
        ) : (
          <div className="flex flex-col gap-0.5">
            {from > 0 && <EarlierCalls rows={rows.slice(0, from)} onPress={showEarlier} className="ml-2.5 min-h-[30px]" />}
            <ToolCallRows rows={from > 0 ? rows.slice(from) : rows} open={open} onToggle={setOpen} />
          </div>
        )}
      </Fold>
      {isMobile && (
        <ToolRunSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          rows={rows}
          summary={summary}
          failedOnly={failedControl && sheetFailedOnly}
          from={sheetFrom}
          onFrom={setSheetFrom}
        />
      )}
    </div>
  );
}

/** Calls one under another, each opening its details in place: a run's body
 *  on a desktop, and a subagent's steps (TaskSteps). */
export function ToolCallRows({ rows, open, onToggle }: {
  rows: readonly ToolRunRow[];
  /** The calls whose details are open, by call id. */
  open: ReadonlySet<string>;
  onToggle: (toolCallId: string, open: boolean) => void;
}) {
  const names = useNameLookup();
  return (
    <div data-slot="tool-run-calls" className="ml-2.5 flex flex-col">
      {rows.map((row, index) => {
        const id = row.call.toolCallId;
        const callOpen = open.has(id);
        return (
          <div key={id} className="relative flex flex-col">
            <button
              type="button"
              data-slot="tool-call"
              aria-expanded={callOpen}
              onClick={() => onToggle(id, !callOpen)}
              className={cn(
                "flex min-h-[30px] w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-sel",
                callOpen && "bg-sel"
              )}
            >
              <CallMark row={row} />
              {/* From 3px under this mark (centred 15px down a 30px row) to
                  3px above the next one's. */}
              {index < rows.length - 1 && <CallConnector className="-bottom-[5px] left-[15px] top-[25px]" />}
              <Phrase phrase={describeCall(row, names)} failed={rowStatus(row) === "error"} inList />
              <CallNote row={row} />
              <span className="flex-1" />
              <LineCounts changes={lineChanges(row)} variant="pill" />
              <CallDuration row={row} />
              <ChevronRight className={cn("size-3 shrink-0 text-faint transition-transform", callOpen && "rotate-90")} />
            </button>
            <Fold open={callOpen}><ToolCallDetails row={row} className="pb-2 pl-7 pr-2 pt-1.5" /></Fold>
          </div>
        );
      })}
    </div>
  );
}

/** Calls as a phone lists them, each opening its details: a run's sheet, and
 *  a subagent's steps in theirs. */
export function ToolCallSheetRows({ rows, onSelect }: {
  rows: readonly ToolRunRow[];
  onSelect: (toolCallId: string) => void;
}) {
  const names = useNameLookup();
  return (
    <>
      {rows.map((row, index) => (
        <div key={row.call.toolCallId} className="relative">
          <button
            type="button"
            data-slot="tool-call"
            onClick={() => onSelect(row.call.toolCallId)}
            className="flex min-h-[52px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sel"
          >
            <CallMark row={row} className="size-4" />
            {/* From 3px under this mark (centred 26px down a 52px row) to
                3px above the next one's. */}
            {index < rows.length - 1 && <CallConnector className="-bottom-[15px] left-[18px] top-[37px]" />}
            <Phrase phrase={describeCall(row, names)} failed={rowStatus(row) === "error"} inList />
            <CallNote row={row} />
            <span className="flex-1" />
            <LineCounts changes={lineChanges(row)} variant="pill" />
            <CallDuration row={row} />
            <ChevronRight className="size-3.5 shrink-0 text-faint" />
          </button>
        </div>
      ))}
    </>
  );
}

/** A run's calls in its sheet, as its list in place: the latest ones under
 *  the row of earlier ones, or only the failed ones. */
function SheetList({ rows, failedOnly, from: asked, onFrom, onSelect }: {
  rows: ToolRunRow[];
  failedOnly: boolean;
  from: number;
  onFrom: (index: number) => void;
  onSelect: (toolCallId: string) => void;
}) {
  if (failedOnly) return <ToolCallSheetRows rows={rows.filter((row) => rowStatus(row) === "error")} onSelect={onSelect} />;
  const from = Math.min(asked, Math.max(0, rows.length - LATEST_SHOWN));
  return (
    <>
      {from > 0 && (
        <EarlierCalls
          rows={rows.slice(0, from)}
          onPress={() => onFrom(Math.max(0, from - EARLIER_STEP))}
          className="mx-1 mb-1 min-h-11 px-2.5 text-sm"
        />
      )}
      <ToolCallSheetRows rows={rows.slice(from)} onSelect={onSelect} />
    </>
  );
}

const STATUS_WORD = { running: "Running", error: "Failed", ok: "Completed", pending: "No result" } as const;

function ToolRunSheet({ open, onOpenChange, rows, summary, failedOnly, from, onFrom }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ToolRunRow[];
  summary: RunSummary;
  /** Opened by the run's red count: its failed calls only. */
  failedOnly: boolean;
  /** Where its list starts, by position, never later than its latest 8;
   *  50 more moves it. */
  from: number;
  onFrom: (index: number) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const single = rows.length === 1;
  const selected = single ? rows[0]! : (rows.find((row) => row.call.toolCallId === selectedId) ?? null);
  const status = selected ? rowStatus(selected) : null;
  const meta = runMeta(summary);
  const sub = selected
    ? [STATUS_WORD[status!], bashExitNote(selected), callNote(selected), slowDuration(rowElapsedMs(selected))?.label].filter(Boolean).join(" · ")
    // The count is the title's; running and failures are what is left to say.
    : [summary.running ? "Running" : "", meta.failed].filter(Boolean).join(" · ");
  const iconButton = "flex size-11 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-sel";

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelectedId(null);
        onOpenChange(next);
      }}
      slot="tool-sheet"
      bodyClassName="px-2 pb-4"
      // Esc and the phone's Back step back as ‹ does: from a call's details
      // to the list, and only then out of the sheet.
      onEscapeKeyDown={(event) => {
        if (!selected || single) return;
        event.preventDefault();
        setSelectedId(null);
      }}
      header={
        <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
          {/* Close keeps the right end at every level, as every sheet's and
              dialog's; the left is ‹ back to the list, in a call's details. */}
          {selected && !single ? (
            <button type="button" aria-label="All calls in this run" onClick={() => setSelectedId(null)} className={iconButton}>
              <ChevronLeft className="size-5" />
            </button>
          ) : (
            <span aria-hidden className="size-11 shrink-0" />
          )}
          <div className="flex min-w-0 flex-1 flex-col items-center">
            <BottomSheetTitle className="flex max-w-full items-baseline gap-1.5 text-sm">
              {/* A count, not the run's sentence: "Read 1 file, ran 2
                  commands, edited…" was cut on a phone, and the list under
                  it says what each call did. */}
              {selected
                ? <span className="font-mono">{selected.call.toolName}</span>
                : <span>{summary.count} tool {summary.count === 1 ? "call" : "calls"}</span>}
              {selected ? <LineCounts changes={lineChanges(selected)} /> : !summary.running && <LineCounts changes={summary.lines} />}
            </BottomSheetTitle>
            <div data-slot="tool-sheet-status" className={cn("text-2xs", status === "error" ? "text-destructive" : "text-faint")}>
              {sub}
            </div>
          </div>
          <BottomSheetClose aria-label="Close" className={iconButton}>
            <X className="size-5" />
          </BottomSheetClose>
        </div>
      }
    >
      {selected ? (
        <ToolCallDetails row={selected} className="px-2 pb-2" layout="sheet" />
      ) : (
        <SheetList rows={rows} failedOnly={failedOnly} from={from} onFrom={onFrom} onSelect={setSelectedId} />
      )}
    </BottomSheet>
  );
}

// Memoised: the transcript re-renders on every streaming delta.
export const ToolRun = memo(ToolRunImpl);
