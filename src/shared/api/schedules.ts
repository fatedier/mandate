/** A schedule's life: `active` from the start (or `paused` when made so),
 *  `paused` by the personal agent, the owner, a failing check or an archive. */
export type ScheduleStatus = "active" | "paused";

/** How far a duty thread may go with what its checks find. Deploying is
 *  part of neither. */
export type DutyLevel = "investigate" | "fix_for_review";

/** What one handled due time came to. */
export type ScheduleRunOutcome =
  | "quiet"
  | "woke"
  | "failed"
  | "skipped_overlap"
  | "skipped_floor"
  /** A first run: a new schedule's or a new check's, the starting point. */
  | "test"
  | "manual_quiet"
  | "manual_woke";

export interface ScheduleDto {
  id: string;
  threadId: string;
  name: string;
  cron: string;
  /** The cron in words where it has a common shape ("Daily 09:00"). */
  cronText: string;
  timezone: string;
  status: ScheduleStatus;
  pausedReason: string | null;
  nextDueAt: string | null;
  lastRunAt: string | null;
  lastOutcome: ScheduleRunOutcome | null;
  consecutiveFailures: number;
  /** Checks that ran so far (not its first runs, not skipped due times). */
  checksRun: number;
  /** A check of it is in flight now (scheduled or run by hand). */
  running: boolean;
  /** What it watches: its brief's first line, at most 120 characters. */
  briefLine: string;
}

/** Why the owner's pause, resume or run now was refused. */
/** `changed`: a check the owner ran was cut off by a change to its schedule. */
export type ScheduleActionCode = "running" | "paused" | "archived" | "off" | "missing" | "changed";

/** A refused pause, resume or run now: 404 for `missing`, 409 otherwise. */
export interface ScheduleActionError {
  error: string;
  code: ScheduleActionCode;
}

/** A pause, resume or finished run: the schedule as it is now; a check still
 *  running after the route's wait: `running` (the row follows over SSE). */
export type ScheduleActionResponse = { schedule: ScheduleDto } | { status: "running" };

export interface ScheduleRunDto {
  startedAt: string;
  outcome: ScheduleRunOutcome;
  line: string;
  /** Due times collapsed into this run after the server was down. */
  missed: number;
  durationMs: number;
}

export interface ScheduleRunsResponse {
  runs: ScheduleRunDto[];
}

/** What a manager thread's DTO carries when it owns schedules. */
export interface DutySummaryDto {
  level: DutyLevel;
  schedules: ScheduleDto[];
  /** The startup switch is on: no check runs. */
  schedulesOff: boolean;
  /** Seq of the newest reply it reported to the personal agent; null when none.
   *  Newer than the thread's seen seq, the owner has not read it. */
  reportedSeq: number | null;
  /** When the owner put it in the sidebar; null when it is not there. */
  sidebarAddedAt: string | null;
}

/** What became of a duty thread's reply: forwarded to the personal agent as its
 *  report, silent (`NO_REPORT`), told quietly (the owner's own round), or
 *  carried by the personal agent's own wait on the thread. */
export type DutyReportOutcome = "sent" | "no_report" | "owner_note" | "told_by_wait";
