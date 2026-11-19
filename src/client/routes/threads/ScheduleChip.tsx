import { useRef, useState, type ReactNode } from "react";
import { CalendarClock } from "lucide-react";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useNow } from "@/hooks/useNow";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { useScheduleRuns } from "@/hooks/useScheduleRuns";
import { cronInZone, DUTY_LEVEL_TEXT, formatDue, pausedText, scheduleChipText, scheduleRunText } from "@/lib/duty";
import { CauseRunList } from "@/routes/window/chat/CauseDetails";
import { cn } from "@/lib/utils";
import type { DutySummaryDto, ScheduleDto } from "@shared/api/schedules";

/**
 * A duty thread's schedules, in its header: when it is checked next, and
 * pressed, a card of what each schedule is and its last checks (a box at the
 * chip; on a phone, the sheet). Read only: a schedule changes when the user
 * asks the personal agent, which the card says.
 */
export function ScheduleChip({ duty, className }: { duty: DutySummaryDto; className?: string }) {
  const [open, setOpen] = useState(false);
  const phone = useIsMobile();
  const agentName = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const now = useNow();
  // The sheet's own trigger is not the chip: focus is handed back to it.
  const chipRef = useRef<HTMLButtonElement>(null);
  const chip = (
    <button
      ref={chipRef}
      type="button"
      data-slot="schedule-chip"
      aria-haspopup="dialog"
      onClick={phone ? () => setOpen(true) : undefined}
      className={cn(
        "flex h-6 min-w-0 shrink items-center gap-1.5 rounded-sm px-1.5 text-2xs text-chrome hover:bg-sel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-9",
        className
      )}
    >
      <CalendarClock aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate tabular-nums">{scheduleChipText(duty, now)}</span>
    </button>
  );

  if (phone) {
    return (
      <>
        {chip}
        <BottomSheet
          open={open}
          onOpenChange={setOpen}
          returnFocus={() => chipRef.current}
          slot="schedule-sheet"
          header={(
            <div className="border-b border-border-soft px-4 pt-1 pb-3">
              <BottomSheetTitle className="text-sm font-semibold text-foreground">Schedule</BottomSheetTitle>
            </div>
          )}
          bodyClassName="px-4 pt-3 pb-6"
        >
          {open && <ScheduleCard duty={duty} agentName={agentName} />}
        </BottomSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{chip}</PopoverTrigger>
      {/* As tall as the window leaves it, as the cause card is. */}
      <PopoverContent
        data-slot="schedule-popover"
        aria-label="Schedule"
        align="start"
        collisionPadding={12}
        className="flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[26rem] max-w-[calc(100vw-2rem)] flex-col p-0"
      >
        <div className="border-b border-border-soft px-3.5 py-2.5 text-sm font-semibold text-foreground">Schedule</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
          <ScheduleCard duty={duty} agentName={agentName} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ScheduleCard({ duty, agentName }: { duty: DutySummaryDto; agentName: string }) {
  const runs = useScheduleRuns(duty.schedules);
  const now = useNow();
  return (
    // Focusable, so a keyboard reaches what a half-raised sheet hides (focus
    // in its body raises it), as the cause card's body is.
    <div data-slot="schedule-card" tabIndex={0} className="flex flex-col gap-4 rounded-xs text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <Fact term="Level">{DUTY_LEVEL_TEXT[duty.level]}</Fact>
        <Fact term="Managed by">{agentName}</Fact>
      </dl>
      {duty.schedules.map((schedule) => {
        const rows = (runs.get(schedule.id) ?? []).map((run) => ({ at: formatDue(run.startedAt, now), ...scheduleRunText(run) }));
        return (
          <section key={schedule.id} data-slot="schedule-card-schedule" className="flex flex-col gap-2">
            <h3 className="font-semibold text-foreground">{schedule.name}</h3>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <Fact term="When">{whenText(schedule, now)}</Fact>
            </dl>
            {schedule.status === "paused" && (
              <p data-slot="schedule-card-paused" className="text-xs text-muted-foreground">
                {schedule.pausedReason ? pausedText(schedule.pausedReason) : "Paused"}
              </p>
            )}
            {rows.length > 0 && <CauseRunList label="Checks" rows={rows} earlier={0} />}
          </section>
        );
      })}
      <p data-slot="schedule-card-ask" className="text-xs text-muted-foreground">To change the schedule, ask {agentName}.</p>
    </div>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs text-faint">{term}</dt>
      <dd className="min-w-0 break-words text-xs text-foreground">{children}</dd>
    </>
  );
}

/** "Daily 09:00 · next Nov 7 09:00": the cron as the schedule's zone reads
 *  it, which is named when it is not the reader's. */
function whenText(schedule: ScheduleDto, now: number): string {
  const next = schedule.status === "active" && schedule.nextDueAt ? ` · next ${formatDue(schedule.nextDueAt, now)}` : "";
  return `${cronInZone(schedule)}${next}`;
}
