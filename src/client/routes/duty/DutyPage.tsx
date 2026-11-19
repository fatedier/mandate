import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Check, ChevronRight, CirclePlay, MoreHorizontal, Pause, Play } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { PaneHeaderTitle } from "@/shell/pane-header-slots";
import { ThreadStateMark } from "@/shell/ThreadStateMark";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useThreadDots } from "@/hooks/useThreadDots";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useNow } from "@/hooks/useNow";
import { useScheduleRuns } from "@/hooks/useScheduleRuns";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { threadHref } from "@/lib/worker-href";
import { cronInZone, DUTY_LEVEL_TEXT, dutyMark, dutyNeedsLook, dutyOrder, formatDue, pausedText, scheduleFailing, scheduleOutcomeText, scheduleRunText, soonestDue } from "@/lib/duty";
import { CauseRunList } from "@/routes/window/chat/CauseDetails";
import { cn } from "@/lib/utils";
import type { ManagerThreadDto } from "@shared/api/agents";
import type { DutySummaryDto, ScheduleDto } from "@shared/api/schedules";
import { scheduleAction, setInSidebar, type ScheduleAction } from "./duty-actions";

type DutyThread = ManagerThreadDto & { duty: DutySummaryDto };
type Filter = "all" | "look" | "paused";

/** Below this width the list has no room for its columns beside a title: the
 *  phone's rows. */
const COLUMNS_FROM_PX = 680;

const allPaused = (t: DutyThread) => t.duty.schedules.every((s) => s.status === "paused");

/** The schedule a row speaks for: the one, or of several the one running,
 *  then failing, then the one checked last. */
function rowSchedule(duty: DutySummaryDto): ScheduleDto {
  const by = [...duty.schedules];
  return by.find((s) => s.running)
    ?? by.find(scheduleFailing)
    ?? by.sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""))[0]!;
}

/** Every duty thread, in the order it was made, with its checks; the owner
 *  runs, pauses or resumes one here, and puts it in the sidebar. What changed
 *  comes back as the thread's row, so nothing here moves by itself. */
export function DutyPage() {
  const threads = useManagerThreadsStore((s) => s.threads);
  const dots = useThreadDots();
  const agent = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const narrowScreen = useIsMobile();
  // The list's own width decides: a narrow window beside the sidebar leaves
  // the columns no room either.
  const [listRef, listWidth] = useElementWidth<HTMLDivElement>();
  const phone = narrowScreen || (listWidth > 0 && listWidth < COLUMNS_FROM_PX);
  const now = useNow();
  const [chosen, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const all = useMemo(() => dutyOrder(threads.values()) as DutyThread[], [threads]);
  const look = all.filter(dutyNeedsLook);
  const paused = all.filter(allPaused);
  // A filter with none left is not shown: the page goes back to All, and
  // stays there when one comes again.
  const filter: Filter = (chosen === "look" && look.length === 0) || (chosen === "paused" && paused.length === 0) ? "all" : chosen;
  if (filter !== chosen) setFilter(filter);
  const shown = filter === "look" ? look : filter === "paused" ? paused : all;
  const off = all.some((t) => t.duty.schedulesOff);
  // With schedules off nothing is checked: no time is said for the next.
  const next = off ? null : all.map((t) => soonestDue(t.duty)).filter((d): d is string => d !== null).sort()[0] ?? null;
  const toggle = (id: string) => setOpen((prev) => {
    const nextOpen = new Set(prev);
    if (!nextOpen.delete(id)) nextOpen.add(id);
    return nextOpen;
  });
  const chip = (which: Filter, label: string, n: number, attention = false) => (
    <button
      type="button"
      data-slot="duty-chip"
      aria-pressed={filter === which}
      onClick={() => setFilter(which)}
      className={cn(
        "hit relative inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 text-xs font-medium transition-colors",
        filter === which ? "bg-sel text-foreground" : "text-chrome hover:bg-sel hover:text-foreground"
      )}
    >
      {label} <span className={cn("tabular-nums", attention ? "text-status-review" : filter === which ? "text-muted-foreground" : "text-faint")}>{n}</span>
    </button>
  );
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-3 px-4 pt-1 pb-6 md:px-8">
      <PaneHeaderTitle>
        <h1 className="flex min-w-0 items-baseline gap-2 text-sm">
          <span className="truncate font-semibold text-foreground">On duty</span>
          <span className="truncate text-xs text-faint">Duty threads and their checks</span>
        </h1>
      </PaneHeaderTitle>
      {off && <p data-slot="duty-off" className="text-xs text-faint">Schedules are off</p>}
      {all.length === 0 ? (
        <p data-slot="duty-empty" className="py-16 text-center text-sm text-muted-foreground">
          No duty threads yet. Ask {agent} to watch something on a schedule.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-0.5">
              {chip("all", "All", all.length)}
              {look.length > 0 && chip("look", "Needs a look", look.length, true)}
              {paused.length > 0 && chip("paused", "Paused", paused.length)}
            </div>
            <span className="flex-1" />
            {next && <span data-slot="duty-next" className="text-xs tabular-nums text-faint">Next check {formatDue(next, now)}</span>}
          </div>
          <div ref={listRef} data-slot="duty-list" className="overflow-hidden rounded-lg border border-border-soft bg-panel">
            {shown.map((t) => (
              <DutyRow key={t.id} thread={t} mark={dutyMark(t, dots.get(t.id) ?? "idle")} now={now} phone={phone} open={open.has(t.id)} onToggle={() => toggle(t.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface RowProps {
  thread: DutyThread;
  mark: ReturnType<typeof dutyMark>;
  now: number;
  phone: boolean;
  open: boolean;
  onToggle: () => void;
}

const scheduleText = (duty: DutySummaryDto) => (duty.schedules.length === 1 ? cronInZone(duty.schedules[0]!) : `${duty.schedules.length} schedules`);
/** When it checks next; nothing when all is paused (its last check says so)
 *  or schedules are off. */
const nextText = (t: DutyThread, now: number) => {
  if (allPaused(t) || t.duty.schedulesOff) return "";
  const due = soonestDue(t.duty);
  return due ? formatDue(due, now) : "";
};

/** A press on an action is the action's, not the row's. */
const own = (fn: () => void) => (event: MouseEvent) => { event.stopPropagation(); fn(); };

/**
 * One duty thread: its title (the way into the thread) and what it watches;
 * its last check and its next; its actions. Pressing the rest of the row
 * opens its checks below it, as its ▸ does from the keyboard. On a phone the
 * same row, its times on one line under what it watches.
 */
function DutyRow({ thread, mark, now, phone, open, onToggle }: RowProps) {
  const s = rowSchedule(thread.duty);
  const [menuOpen, setMenuOpen] = useState(false);
  const title = (
    <Link
      to={threadHref(thread.id)}
      data-slot="duty-title"
      onClick={(event) => event.stopPropagation()}
      className="min-w-0 truncate rounded-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {thread.title}
    </Link>
  );
  const brief = s.briefLine ? <div className="truncate text-xs text-muted-foreground">{s.briefLine}</div> : null;
  const fold = (
    <button
      type="button"
      aria-label="Checks"
      aria-expanded={open}
      onClick={own(onToggle)}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-faint transition-colors hover:bg-sel hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:hidden",
        open ? "opacity-100" : "opacity-0 group-hover/duty:opacity-100"
      )}
    >
      <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
    </button>
  );
  return (
    <div className="border-t border-border-soft first:border-t-0">
      <div
        data-slot="duty-row"
        data-thread-id={thread.id}
        onClick={onToggle}
        className={cn(
          "group/duty flex min-h-14 cursor-pointer gap-3 px-3.5 py-2.5 transition-colors hover:bg-sel/50",
          phone ? "items-start" : "items-center",
          (menuOpen || open) && "bg-sel/30"
        )}
      >
        <span className={cn("flex shrink-0", phone && "pt-1.5")}><ThreadStateMark dot={mark} /></span>
        {phone ? (
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {title}
            {brief}
            <div data-slot="duty-meta" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-faint">
              <Outcome schedule={s} />
              {s.lastRunAt && <span>{formatDue(s.lastRunAt, now)}</span>}
              {/* The dot only between the last check and the next. */}
              {nextText(thread, now) && <>{(scheduleOutcomeText(s) || s.lastRunAt) && <span>·</span>}<span>Next {nextText(thread, now)}</span></>}
            </div>
          </div>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">{title}{brief}</div>
            <div data-slot="duty-last" className="flex w-40 shrink-0 flex-col gap-0.5 text-xs">
              <Outcome schedule={s} />
              {s.lastRunAt && <span className="tabular-nums text-faint">{formatDue(s.lastRunAt, now)}</span>}
            </div>
            <div className="flex w-32 shrink-0 flex-col items-end gap-0.5 text-right text-xs tabular-nums">
              <span className="text-muted-foreground">{nextText(thread, now)}</span>
              <span className="truncate text-faint">{scheduleText(thread.duty)}</span>
            </div>
          </>
        )}
        <RowActions thread={thread} phone={phone} menuOpen={menuOpen} onMenuOpenChange={setMenuOpen} checksOpen={open} onChecks={onToggle} />
        {!phone && fold}
      </div>
      {open && (
        <div className="border-t border-border-soft bg-sel/20 px-3.5 py-3 pl-10">
          <DutyRuns thread={thread} now={now} />
        </div>
      )}
    </div>
  );
}

/** The last check's outcome as a word in its colour: red failing, green running. */
function Outcome({ schedule }: { schedule: ScheduleDto }) {
  const text = scheduleOutcomeText(schedule);
  if (!text) return null;
  const tone = schedule.running ? "text-live" : scheduleFailing(schedule) ? "text-destructive" : "text-muted-foreground";
  return <span data-slot="duty-outcome" className={cn("whitespace-nowrap", tone)}>{text}</span>;
}

/** Run now, Pause or Resume for one schedule, in its open row. */
function ScheduleButtons({ schedule, off }: { schedule: ScheduleDto; off: boolean }) {
  const act = (action: ScheduleAction) => own(() => { void scheduleAction(action, schedule.id); });
  return (
    <>
      <Button variant="outline" size="xs" disabled={off || schedule.status !== "active" || schedule.running} onClick={act("run")}>Run now</Button>
      {schedule.status === "paused"
        ? <Button variant="outline" size="xs" disabled={off} onClick={act("resume")}>Resume</Button>
        : <Button variant="outline" size="xs" disabled={off} onClick={act("pause")}>Pause</Button>}
    </>
  );
}

/** A row's icon button: its name said on hover and to a screen reader. */
function IconAction({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={own(onClick)}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-chrome transition-colors hover:bg-sel hover:text-foreground disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {children}
    </button>
  );
}

/** Run now and Pause / Resume (one schedule; several act in the open row),
 *  then ⋯: shown while the row is hovered, holds focus, or its menu is open;
 *  on a phone ⋯ alone, always, with Run now and Pause / Resume in it. */
function RowActions({ thread, phone, menuOpen, onMenuOpenChange, checksOpen, onChecks }: {
  thread: DutyThread; phone: boolean; menuOpen: boolean; onMenuOpenChange: (open: boolean) => void; checksOpen: boolean; onChecks: () => void;
}) {
  const one = thread.duty.schedules.length === 1 ? thread.duty.schedules[0]! : null;
  const off = thread.duty.schedulesOff;
  const inSidebar = thread.duty.sidebarAddedAt !== null;
  const navigate = useNavigate();
  const run = (action: ScheduleAction) => { if (one) void scheduleAction(action, one.id); };
  const canRun = one !== null && !off && one.status === "active" && !one.running;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0.5 transition-opacity",
        !phone && !menuOpen && "opacity-0 group-hover/duty:opacity-100 group-focus-within/duty:opacity-100"
      )}
    >
      {!phone && one && (
        <>
          <IconAction label="Run now" disabled={!canRun} onClick={() => run("run")}><Play aria-hidden className="size-3.5" /></IconAction>
          {one.status === "paused"
            ? <IconAction label="Resume" disabled={off} onClick={() => run("resume")}><CirclePlay aria-hidden className="size-3.5" /></IconAction>
            : <IconAction label="Pause" disabled={off} onClick={() => run("pause")}><Pause aria-hidden className="size-3.5" /></IconAction>}
        </>
      )}
      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More actions"
            title="More actions"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-chrome transition-colors hover:bg-sel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-11"
          >
            <MoreHorizontal aria-hidden className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
          {/* With no ▸ here, its checks open from the menu, the keyboard's way too. */}
          {phone && (
            <DropdownMenuItem data-slot="duty-checks-item" data-open={checksOpen} onSelect={onChecks}>
              Checks{checksOpen && <Check aria-hidden className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          )}
          {phone && one && (
            <>
              <DropdownMenuItem disabled={!canRun} onSelect={() => run("run")}>Run now</DropdownMenuItem>
              {one.status === "paused"
                ? <DropdownMenuItem disabled={off} onSelect={() => run("resume")}>Resume</DropdownMenuItem>
                : <DropdownMenuItem disabled={off} onSelect={() => run("pause")}>Pause</DropdownMenuItem>}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => { void setInSidebar(thread.id, !inSidebar); }}>
            {inSidebar ? "Remove from sidebar" : "Show in sidebar"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate(threadHref(thread.id))}>Open</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Each schedule of the thread, its own buttons when it has several, and its last checks. */
function DutyRuns({ thread, now }: { thread: DutyThread; now: number }) {
  const runs = useScheduleRuns(thread.duty.schedules);
  const several = thread.duty.schedules.length > 1;
  return (
    <div data-slot="duty-runs" className="flex flex-col gap-3" onClick={(event) => event.stopPropagation()}>
      <p className="text-xs text-muted-foreground">{DUTY_LEVEL_TEXT[thread.duty.level]}</p>
      {thread.duty.schedules.map((schedule) => {
        const rows = (runs.get(schedule.id) ?? []).map((run) => ({ at: formatDue(run.startedAt, now), ...scheduleRunText(run) }));
        return (
          <section key={schedule.id} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-foreground">{schedule.name}</span>
              <span className="text-muted-foreground">{cronInZone(schedule)}</span>
              {several && <Outcome schedule={schedule} />}
              {several && <span className="ml-auto flex gap-1"><ScheduleButtons schedule={schedule} off={thread.duty.schedulesOff} /></span>}
            </div>
            {schedule.status === "paused" && schedule.pausedReason && <p className="text-xs text-muted-foreground">{pausedText(schedule.pausedReason)}</p>}
            {rows.length > 0 && <CauseRunList label="Checks" rows={rows} earlier={0} />}
          </section>
        );
      })}
    </div>
  );
}
