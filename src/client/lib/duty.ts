import type { DutyLevel, DutySummaryDto, ScheduleDto, ScheduleRunDto } from "@shared/api/schedules";
import type { ManagerThreadDto } from "@shared/api/agents";
import type { ThreadDot } from "@shared/thread-dot";
import { formatCalendarDate, formatClockMinutes } from "./format";

/** How a duty thread's level reads. */
export const DUTY_LEVEL_TEXT: Record<DutyLevel, string> = {
  investigate: "Investigate and recommend",
  fix_for_review: "Fix for review"
};

/** The soonest next check among the schedules that run; null when none does. */
export function soonestDue(duty: DutySummaryDto): string | null {
  const due = duty.schedules.flatMap((s) => (s.status === "active" && s.nextDueAt ? [s.nextDueAt] : []));
  return due.length === 0 ? null : due.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

/** A due time in the reader's clock: its time today; another day its date,
 *  with the time unless `short` (the sidebar's room). */
export function formatDue(iso: string, now: number, { short = false }: { short?: boolean } = {}): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (new Date(ms).toDateString() === new Date(now).toDateString()) return formatClockMinutes(ms);
  return short ? formatCalendarDate(ms, now) : `${formatCalendarDate(ms, now)} ${formatClockMinutes(ms)}`;
}

/** Where the thread's schedules stand: the next check, all paused, or every
 *  check switched off at the start. */
type DutyStanding = { kind: "due"; at: string } | { kind: "paused" } | { kind: "off" };

const OFF = "Schedules are off";

function standing(duty: DutySummaryDto): DutyStanding {
  if (duty.schedulesOff) return { kind: "off" };
  const at = soonestDue(duty);
  return at ? { kind: "due", at } : { kind: "paused" };
}

/** A schedule's cron as its own zone reads it, the zone named when it is not
 *  the reader's (the times beside it are the reader's). */
export function cronInZone(schedule: Pick<ScheduleDto, "cronText" | "timezone">): string {
  return schedule.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? `${schedule.cronText} (${schedule.timezone})` : schedule.cronText;
}

/** The thread header's chip: "Daily 09:00 · next Nov 7 09:00", "3 schedules · next 12:00", "Paused". */
export function scheduleChipText(duty: DutySummaryDto, now: number): string {
  const s = standing(duty);
  if (s.kind === "paused") return "Paused";
  if (s.kind === "off") return OFF;
  const what = duty.schedules.length === 1 ? cronInZone(duty.schedules[0]!) : `${duty.schedules.length} schedules`;
  return `${what} · next ${formatDue(s.at, now)}`;
}

/** A sidebar row's end: the next check, or Paused; nothing while schedules
 *  are off (the group says so). */
export function dutyRowEnd(duty: DutySummaryDto, now: number): string | null {
  if (duty.schedules.every((x) => x.status === "paused")) return "Paused";
  const s = standing(duty);
  if (s.kind !== "due") return null;
  return formatDue(s.at, now, { short: true });
}

/** Home's line under a duty thread: "Next check 09:00 · 15 checks so far", or Paused. */
export function dutyHomeLine(duty: DutySummaryDto, now: number): string {
  const s = standing(duty);
  if (s.kind === "paused") return "Paused";
  if (s.kind === "off") return OFF;
  const checks = duty.schedules.reduce((sum, x) => sum + x.checksRun, 0);
  return `Next check ${formatDue(s.at, now)} · ${checks} ${checks === 1 ? "check" : "checks"} so far`;
}

const RUN_OUTCOME: Record<ScheduleRunDto["outcome"], string> = {
  quiet: "Nothing new",
  woke: "Woke the thread",
  skipped_overlap: "Skipped: still running",
  skipped_floor: "Skipped: too soon",
  failed: "Failed",
  test: "First run",
  manual_quiet: "Run now · nothing new",
  manual_woke: "Run now · woke the thread"
};

/** One check as the schedule card lists it (the cause card's run rows): what
 *  came of it, its tone, and its line (a failure's error; due times missed
 *  while the server was down, folded into it). */
export function scheduleRunText(run: ScheduleRunDto): { outcome: string; tone: "ok" | "same" | "fail"; line: string } {
  const tone = run.outcome === "failed" ? "fail" : run.outcome === "woke" || run.outcome === "manual_woke" ? "ok" : "same";
  const missed = run.missed > 0 ? `${run.missed} missed, ran once` : "";
  return { outcome: RUN_OUTCOME[run.outcome] ?? run.outcome, tone, line: [missed, run.line].filter(Boolean).join(" · ") };
}

/** A schedule that is checked and keeps failing; a paused one is not (Resume
 *  zeroes it). The one rule behind every red: the page's rows, its nav entry,
 *  a duty row's mark. */
export function scheduleFailing(schedule: Pick<ScheduleDto, "status" | "consecutiveFailures">): boolean {
  return schedule.status === "active" && schedule.consecutiveFailures > 0;
}

/** A schedule of it is failing. */
export function dutyFailing(duty: DutySummaryDto): boolean {
  return duty.schedules.some(scheduleFailing);
}

/** Why a schedule is paused, said once: a reason that says Paused itself
 *  ("Paused by the user on the On duty page") stands alone. */
export function pausedText(reason: string): string {
  return /^paused\b/i.test(reason) ? reason : `Paused: ${reason}`;
}

/** It reported to the personal agent after the owner last read the thread. */
function reportUnread(thread: Pick<ManagerThreadDto, "seenSeq">, duty: DutySummaryDto): boolean {
  return duty.reportedSeq !== null && duty.reportedSeq > thread.seenSeq;
}

/** A duty thread waits on the owner: a report not read yet, or a check
 *  failing. The one rule behind the page's count, Home and every duty row's
 *  mark; the nav entry counts only the failing (OnDutyNavRow). */
export function dutyNeedsLook(thread: Pick<ManagerThreadDto, "seenSeq" | "duty">): boolean {
  return thread.duty != null && (reportUnread(thread, thread.duty) || dutyFailing(thread.duty));
}

/** A duty thread's mark, in the sidebar's own marks: a check (or a turn)
 *  running, failing, a report to read; else the thread's own (a question to
 *  the owner, a decision, a wait on a monitor). A result to read comes only
 *  from a report sent: a quiet round never lights. Quiet or paused: none. */
export function dutyMark(thread: Pick<ManagerThreadDto, "seenSeq" | "duty">, dot: ThreadDot): ThreadDot {
  const duty = thread.duty;
  if (!duty) return dot;
  if (dot === "working" || duty.schedules.some((x) => x.running)) return "working";
  if (dot === "failed" || dutyFailing(duty)) return "failed";
  if (reportUnread(thread, duty)) return "result";
  return dot === "needs_you" || dot === "decision" || dot === "watching" ? dot : "idle";
}

/** A schedule's state and last check, in the schedule card's words. */
export function scheduleOutcomeText(schedule: ScheduleDto): string {
  if (schedule.running) return "Running…";
  if (schedule.status === "paused") return "Paused";
  if (!schedule.lastOutcome) return "";
  if (schedule.lastOutcome === "failed" && schedule.consecutiveFailures > 1) return `Failed ×${schedule.consecutiveFailures}`;
  return RUN_OUTCOME[schedule.lastOutcome] ?? schedule.lastOutcome;
}

/** The duty threads in the order they were made: a state that changes
 *  never moves a row. */
export function dutyOrder<T extends Pick<ManagerThreadDto, "id" | "createdAt" | "duty">>(threads: Iterable<T>): T[] {
  return [...threads].filter((t) => t.duty != null).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
