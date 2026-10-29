import { useState, type ReactNode } from "react";
import { Fold } from "@/components/Fold";
import { Check, Circle, CircleDot, Pause } from "lucide-react";
import type { PlanStepDto } from "@shared/api/plans";
import { cn } from "@/lib/utils";
import { formatCalendarDate, formatClockMinutes, formatDateTime } from "@/lib/format";
import { RelativeTime } from "@/components/RelativeTime";
import type { NoteLinkContext } from "./note-links";
import { PlanNote } from "./PlanNote";

const ICON = {
  done: <Check className="size-4 text-phase-done" aria-hidden />,
  blocked: <Pause className="size-4 text-amber" aria-hidden />,
  in_progress: <CircleDot className="size-4 text-phase-working" aria-hidden />,
  pending: <Circle className="size-4 text-faint" aria-hidden />
} as const;

function shortDay(iso: string | null): string {
  return iso ? formatCalendarDate(iso) : "";
}

/** What the step's time says at a glance: when it was done, since when it is
 *  blocked, how long it has been running (on the shared clock, so the age
 *  keeps counting while nothing else renders). */
function meta(step: PlanStepDto): ReactNode {
  if (step.status === "done") return shortDay(step.completedAt);
  if (step.status === "blocked") return step.blockedAt ? `since ${shortDay(step.blockedAt)}` : "";
  if (step.status === "in_progress") return step.startedAt ? <>started <RelativeTime value={step.startedAt} /></> : "";
  return "";
}

/** The opened step's times, each a piece that never breaks. A day every time
 *  falls on is written once, first ("Oct 9", "Added 04:29", "Done 04:47");
 *  times on different days each carry theirs. One line of "Added Oct 9 ·
 *  04:29 · Started Oct 9 · …" said the day three times, used one dot for
 *  two jobs, and broke on a phone between "Done Oct" and "9". */
function times(step: PlanStepDto): string[] {
  const all = ([
    ["Added", step.createdAt],
    ["Started", step.startedAt],
    ["Blocked", step.blockedAt],
    ["Done", step.completedAt]
  ] satisfies Array<[string, string | null]>).filter((time): time is [string, string] => Boolean(time[1]));
  const days = new Set(all.map(([, at]) => formatCalendarDate(at)));
  if (days.size === 1) return [...days, ...all.map(([label, at]) => `${label} ${formatClockMinutes(at)}`)];
  return all.map(([label, at]) => `${label} ${formatDateTime(at)}`);
}

/** One step: its status, id, title and time. A done or pending step is one
 *  row until opened (a done one's title cut to a line); the step being worked
 *  on, or blocked, shows its note under it, up to four lines. Opened, any step
 *  shows its note whole and every time (with many steps, five done
 *  steps' two-line notes filled the first screen and the step being worked on
 *  sat below them). The note sits outside the button so its links are real
 *  links. */
export function PlanStepRow({ step, ctx }: { step: PlanStepDto; ctx: NoteLinkContext }) {
  const [open, setOpen] = useState(false);
  const when = meta(step);
  const current = step.status === "in_progress" || step.status === "blocked";
  const noteShown = Boolean(step.note) && (open || current);
  return (
    <li data-slot="plan-step" data-step-id={step.id} className={cn("list-none rounded-sm", open && "bg-sel")}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        // On a touch screen the 44px comes from even padding (16 + a 20px
        // line + 8), not a minimum height: a minimum left a one-line title
        // 12px of empty row above its note and a two-line one none.
        // `hit` is no way out: it reaches into the next step's
        // area and over the note's links.
        // Without a note under it, the row keeps the note's bottom gap itself.
        className={cn(
          "grid w-full grid-cols-[16px_minmax(0,1fr)] gap-2.5 rounded-sm px-2 pt-2 text-left transition-colors hover:bg-sel pointer-coarse:min-h-11 pointer-coarse:pt-4 pointer-coarse:pb-2",
          noteShown ? "pb-1" : "pb-2"
        )}>
        <span className="pt-0.5">{ICON[step.status]}</span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="num shrink-0 font-mono text-2xs text-faint">#{step.id}</span>
          <span className={cn(
            "min-w-0 flex-1 text-sm",
            current ? "font-medium" : "text-muted-foreground",
            step.status === "done" && !open && "truncate"
          )}>{step.title}</span>
          {when && <span data-slot="plan-step-meta" className="num shrink-0 text-2xs text-faint">{when}</span>}
        </span>
      </button>
      <Fold open={noteShown && Boolean(step.note)} className="pb-2 pl-[34px] pr-2">
        {step.note && <PlanNote note={step.note} ctx={ctx} clamp={!open} />}
      </Fold>
      <Fold open={open}>
        <div data-slot="plan-step-times" className="num flex flex-wrap gap-x-3 gap-y-0.5 pb-2 pl-[34px] pr-2 text-2xs text-faint">
          {times(step).map((time) => <span key={time} className="whitespace-nowrap">{time}</span>)}
        </div>
      </Fold>
    </li>
  );
}
