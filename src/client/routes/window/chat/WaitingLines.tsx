import { useId, useState, type ReactNode } from "react";
import { Fold } from "@/components/Fold";
import { AlarmClock, ChevronRight, Eye, Hourglass, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { CauseDetails } from "./CauseDetails";
import { foldWaitingLines, type WaitingLine } from "./waiting-lines";

const ICON = { pane: Eye, command: Repeat, alarm: AlarmClock } as const;

/** What the agent is still waiting on, where the working line stands during a
 *  turn. One wait is one line, its note under it. Two or more are one line
 *  that leads with one of them and opens to a row each (foldWaitingLines).
 *  Waiting is not working, so nothing moves. */
export function WaitingLines({ lines }: { lines: readonly WaitingLine[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const fold = foldWaitingLines(lines);
  if (!fold) return null;
  if (fold.more === 0) {
    return (
      <div data-slot="waiting" className="flex flex-col gap-2">
        <OneWait line={fold.lead} />
      </div>
    );
  }
  const { lead } = fold;
  const LeadIcon = ICON[lead.kind];
  return (
    <div data-slot="waiting" className="flex min-w-0 flex-col gap-0.5">
      <button
        type="button"
        data-slot="waiting-fold"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        className="-ml-1.5 flex max-w-full items-start gap-2 self-start rounded-sm px-1.5 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-sel hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:items-center"
      >
        {open ? (
          <>
            <Hourglass aria-hidden className="mt-[3px] size-3.5 shrink-0 text-chrome pointer-coarse:mt-0" />
            <span className="font-medium text-foreground">Waiting on {fold.rows.length}</span>
          </>
        ) : (
          <>
            <LeadIcon aria-hidden className="mt-[3px] size-3.5 shrink-0 text-chrome pointer-coarse:mt-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-medium text-foreground">
                {lead.lead} <span className={cn(lead.mono && "font-mono")}>{lead.label}</span>
              </span>
              {` · ${fold.more} more`}
              {fold.nextWake && ` · next wake ${fold.nextWake}`}
            </span>
          </>
        )}
        <ChevronRight aria-hidden className={cn("mt-[3px] size-3.5 shrink-0 text-faint transition-transform pointer-coarse:mt-0", open && "rotate-90")} />
      </button>
      {!open && lead.note && (
        <div data-slot="waiting-fold-note" className="truncate pl-[22px] text-2xs text-faint" title={lead.note}>{lead.note}</div>
      )}
      <Fold open={open} id={listId} className="flex flex-col gap-1 pt-0.5">
        {fold.rows.map((line) => <WaitRow key={line.id} line={line} />)}
      </Fold>
    </div>
  );
}

/** A line that opens a card is a tap target on a touch screen, however its
 *  text wraps. */
const TAP = "pointer-coarse:h-auto pointer-coarse:min-h-11";

/** A command monitor's line opens its card (CauseDetails): the
 *  same card a cause line opens, titled by what it monitors. */
function WithCard({ line, className, children }: { line: WaitingLine; className: string; children: ReactNode }) {
  if (!line.details) return <div className={className}>{children}</div>;
  return (
    <CauseDetails provenance={{ icon: ICON[line.kind], subject: { text: line.label, code: line.mono }, label: "" }} facts={line.details} triggerClassName={className}>
      {children}
    </CauseDetails>
  );
}

/** The one wait: what it waits on, what wakes the agent and until when, its note under it. */
function OneWait({ line }: { line: WaitingLine }) {
  const Icon = ICON[line.kind];
  return (
    <div data-slot="waiting-line" className="flex min-w-0 flex-col gap-0.5">
      <WithCard line={line} className={cn("flex min-w-0 items-start gap-2 text-xs text-muted-foreground", line.details && TAP)}>
        <Icon aria-hidden className="mt-[3px] size-3.5 shrink-0 text-chrome" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className={cn("font-medium text-foreground", line.details && "group-hover/cause:underline")}>
            {line.lead} <span className={cn(line.mono && "font-mono")}>{line.label}</span>
          </span>
          {line.detail && <>{" · "}{line.detail}</>}
        </span>
      </WithCard>
      {line.note && (
        <div className="truncate pl-[22px] text-2xs text-faint" title={line.note}>{line.note}</div>
      )}
    </div>
  );
}

/** A row of the opened list: what it waits on (an alarm: its time), its note,
 *  and, for a watch or a monitor, when it wakes the agent. In a narrow pane
 *  the name gives way to when it wakes, and the note takes the line under
 *  them, whole. */
function WaitRow({ line }: { line: WaitingLine }) {
  const Icon = ICON[line.kind];
  return (
    <div data-slot="waiting-row" className="flex min-w-0">
      <WithCard
        line={line}
        className={cn("flex min-w-0 flex-1 items-center gap-x-2 gap-y-0.5 pl-[22px] text-2xs @max-[34rem]:grid @max-[34rem]:grid-cols-[auto_minmax(0,1fr)_auto]", line.details && TAP)}
      >
        <Icon aria-hidden className="size-3 shrink-0 text-chrome" />
        <span
          data-part="name"
          className={cn("min-w-0 max-w-[45%] shrink-0 truncate font-medium tabular-nums text-foreground @max-[34rem]:max-w-none", line.mono && "font-mono", line.details && "group-hover/cause:underline")}
          title={line.label}
        >
          {line.label}
        </span>
        {line.note && (
          <span
            data-part="note"
            className="min-w-0 flex-1 truncate text-faint @max-[34rem]:col-span-2 @max-[34rem]:col-start-2 @max-[34rem]:row-start-2 @max-[34rem]:whitespace-normal @max-[34rem]:[overflow-wrap:anywhere]"
            title={line.note}
          >
            {line.note}
          </span>
        )}
        {line.brief && (
          <span data-part="brief" className="ml-auto shrink-0 tabular-nums text-faint">{line.brief}</span>
        )}
      </WithCard>
    </div>
  );
}
