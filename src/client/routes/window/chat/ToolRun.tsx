import { memo, useState } from "react";
import {
  AlarmClock,
  BookOpen,
  Brain,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDashed,
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
import {
  bashExitNote,
  callNote,
  describeCall,
  lineChanges,
  describeRun,
  rowElapsedMs,
  rowStatus,
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
  feature: FolderKanban,
  alarm: AlarmClock,
  monitor: Radar,
  search: Search,
  history: MessageSquareText,
  link: ExternalLink,
  question: CircleQuestionMark,
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
        <CircleAlert aria-label="Failed" className={cn(size, "text-red")} />
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
            failed ? "text-red" : inList && "text-foreground"
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
  const ownTime = single && !summary.running ? slowDuration(rowElapsedMs(rows[0]!)) : null;
  const count = runCount(summary, single, live);
  // What the run looked at stays in sight, folded or not: a strip of
  // thumbnails, each opening its original.
  const viewed = rows.flatMap((row) => {
    const image = row.result && !row.result.isError ? toolImageOf(row.result.result)?.image : null;
    return image ? [{ id: image.id, alt: image.displayPath || image.name || "Viewed image", ...imageSources(image) }] : [];
  });
  const toggleRun = () => {
    if (!expanded) {
      if (rows[0]) setOpen(runOpenKey(rows[0].call.toolCallId), true);
      return;
    }
    // Closing takes every mark the run holds, its calls' included, so
    // reopening it starts from the list of calls again.
    for (const row of rows) {
      const id = row.call.toolCallId;
      if (open.has(runOpenKey(id))) setOpen(runOpenKey(id), false);
      if (open.has(id)) setOpen(id, false);
    }
  };

  return (
    <div data-slot="tool-run" className="flex min-w-0 flex-col gap-0.5">
      <button
        type="button"
        data-slot="tool-run-line"
        aria-expanded={isMobile ? undefined : expanded}
        aria-haspopup={isMobile ? "dialog" : undefined}
        onClick={() => (isMobile ? setSheetOpen(true) : toggleRun())}
        className="-ml-1.5 flex min-h-7 max-w-full items-center gap-1.5 self-start rounded-sm px-1.5 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-sel hover:text-foreground"
      >
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
        {meta.failed && (
          <span data-slot="tool-run-failed" className="shrink-0 whitespace-nowrap text-red">· {meta.failed}</span>
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
        <ChevronRight className={cn("size-3 shrink-0 text-faint transition-transform", expanded && "rotate-90")} />
      </button>
      {viewed.length > 0 && <ImageTiles images={viewed} limit={4} className="mb-1 mt-0.5" />}
      <Fold open={expanded}>
        {single ? (
          <ToolCallDetails row={rows[0]!} className="pb-1 pl-5 pt-1" />
        ) : (
          <ToolCallRows rows={rows} open={open} onToggle={setOpen} />
        )}
      </Fold>
      {isMobile && (
        <ToolRunSheet open={sheetOpen} onOpenChange={setSheetOpen} rows={rows} summary={summary} />
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

const STATUS_WORD = { running: "Running", error: "Failed", ok: "Completed", pending: "No result" } as const;

function ToolRunSheet({ open, onOpenChange, rows, summary }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: ToolRunRow[];
  summary: RunSummary;
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
            <div data-slot="tool-sheet-status" className={cn("text-2xs", status === "error" ? "text-red" : "text-faint")}>
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
        <ToolCallSheetRows rows={rows} onSelect={setSelectedId} />
      )}
    </BottomSheet>
  );
}

// Memoised: the transcript re-renders on every streaming delta.
export const ToolRun = memo(ToolRunImpl);
