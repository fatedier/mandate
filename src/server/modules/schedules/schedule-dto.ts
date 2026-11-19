import type { DutySummaryDto, ScheduleDto } from "../../../shared/api/schedules.js";
import { describeCron } from "./cron.js";
import type { ScheduleRow, ScheduleStore } from "./schedule-store.js";

const BRIEF_LINE_CHARS = 120;

/** A brief's first line with words, cut to what a row shows. */
function briefLineOf(brief: string): string {
  const line = brief.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const chars = [...line];
  return chars.length > BRIEF_LINE_CHARS ? `${chars.slice(0, BRIEF_LINE_CHARS - 1).join("")}…` : line;
}

/** A schedule as a client shows it: its check and state stay on the server. */
export function scheduleDto(row: ScheduleRow, running = false): ScheduleDto {
  return {
    id: row.id, threadId: row.threadId, name: row.name, cron: row.cron, cronText: describeCron(row.cron),
    timezone: row.timezone, status: row.status, pausedReason: row.pausedReason, nextDueAt: row.nextDueAt,
    lastRunAt: row.lastRunAt, lastOutcome: row.lastOutcome, consecutiveFailures: row.consecutiveFailures,
    checksRun: row.checksRun, running, briefLine: briefLineOf(row.brief)
  };
}

/** A thread's duty as its row shows it; null for a thread with no schedule. */
export function dutySummary(
  store: Pick<ScheduleStore, "byThread" | "dutyThread" | "reportedSeq" | "sidebarAddedAt">,
  schedulesOff: boolean,
  threadId: string,
  isRunning: (scheduleId: string) => boolean = () => false
): DutySummaryDto | null {
  const rows = store.byThread(threadId);
  if (rows.length === 0) return null;
  const duty = store.dutyThread(threadId);
  if (!duty) return null;
  return {
    level: duty.level, schedules: rows.map((row) => scheduleDto(row, isRunning(row.id))), schedulesOff,
    reportedSeq: store.reportedSeq(threadId), sidebarAddedAt: store.sidebarAddedAt(threadId)
  };
}
