import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import type { DutyLevel, DutyReportOutcome, ScheduleRunOutcome, ScheduleStatus } from "../../../shared/api/schedules.js";

const REPORT_LOOKUP_SLICE = 500;
/** What counts as a check of the schedule's: not a first run, not a skipped due time. */
const CHECKS_THAT_RAN: ReadonlySet<ScheduleRunOutcome> = new Set(["quiet", "woke", "failed", "manual_quiet", "manual_woke"]);

export interface ScheduleRow {
  id: string;
  threadId: string;
  name: string;
  cron: string;
  timezone: string;
  checkScript: string;
  checkTimeoutMs: number;
  brief: string;
  status: ScheduleStatus;
  pausedReason: string | null;
  nextDueAt: string | null;
  lastRunAt: string | null;
  lastOutcome: ScheduleRunOutcome | null;
  consecutiveFailures: number;
  checkStateJson: string;
  seenItemsJson: string;
  /** The outbox: a wake written with its run's state, not yet delivered. */
  pendingWakeJson: string | null;
  /** The message a busy thread's pending wake was already appended as. */
  pendingMessageId: string | null;
  /** Kept for the check (JSON): a check update gave that has not run yet, or
   *  what an older version kept for a check it was still testing at a stop. */
  pendingCheckJson: string | null;
  /** The due time of a check in flight: run again after a restart cuts it off. */
  runningDueAt: string | null;
  /** Its next run is a first run, whose findings are the starting point (a
   *  new schedule's, or the next after a reset): since when. Kept until that
   *  run ends, so a restart that cuts it off runs it again. */
  firstRunPendingSince: string | null;
  /** Checks that ran, by schedule or asked for now: kept apart from the
   *  run rows, which go after a week. */
  checksRun: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type NewSchedule = Pick<ScheduleRow, "threadId" | "name" | "cron" | "timezone" | "checkScript" | "checkTimeoutMs" | "brief" | "status" | "nextDueAt">
  & Partial<Pick<ScheduleRow, "checkStateJson" | "seenItemsJson" | "pausedReason" | "firstRunPendingSince">>;

type Writable = Omit<ScheduleRow, "id" | "threadId" | "checksRun" | "createdAt" | "updatedAt" | "revision">;

export interface NewScheduleRun {
  scheduleId: string;
  threadId: string;
  dueAt: string;
  startedAt: string;
  finishedAt: string;
  outcome: ScheduleRunOutcome;
  exitCode: number | null;
  durationMs: number;
  line: string;
  missed: number;
}

export interface ScheduleRunRow extends NewScheduleRun {
  id: number;
}

export interface DutyThreadRow {
  threadId: string;
  level: DutyLevel;
  notesDir: string;
  lastToldSeq: number;
  createdAt: string;
}

/** Runs kept per schedule beyond the last week; the oldest go as new ones come. */
export const SCHEDULE_RUNS_KEPT = 200;
/** Every run of the last week is kept: the week's counts read them all. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const COLUMN: Record<keyof Writable, string> = {
  name: "name",
  cron: "cron",
  timezone: "timezone",
  checkScript: "check_script",
  checkTimeoutMs: "check_timeout_ms",
  brief: "brief",
  status: "status",
  pausedReason: "paused_reason",
  nextDueAt: "next_due_at",
  lastRunAt: "last_run_at",
  lastOutcome: "last_outcome",
  consecutiveFailures: "consecutive_failures",
  checkStateJson: "check_state_json",
  seenItemsJson: "seen_items_json",
  pendingWakeJson: "pending_wake_json",
  pendingMessageId: "pending_message_id",
  pendingCheckJson: "pending_check_json",
  runningDueAt: "running_due_at",
  // Named when a first check was a test that had to pass.
  firstRunPendingSince: "test_started_at"
};

interface Raw {
  id: string; thread_id: string; name: string; cron: string; timezone: string; check_script: string;
  check_timeout_ms: number; brief: string; status: string; paused_reason: string | null;
  next_due_at: string | null; last_run_at: string | null; last_outcome: string | null; consecutive_failures: number;
  check_state_json: string; seen_items_json: string; pending_wake_json: string | null;
  pending_message_id: string | null; pending_check_json: string | null; running_due_at: string | null; test_started_at: string | null;
  checks_run: number; created_at: string; updated_at: string; revision: number;
}

function rowOf(raw: Raw): ScheduleRow {
  return {
    id: raw.id,
    threadId: raw.thread_id,
    name: raw.name,
    cron: raw.cron,
    timezone: raw.timezone,
    checkScript: raw.check_script,
    checkTimeoutMs: raw.check_timeout_ms,
    brief: raw.brief,
    status: raw.status as ScheduleStatus,
    pausedReason: raw.paused_reason,
    nextDueAt: raw.next_due_at,
    lastRunAt: raw.last_run_at,
    lastOutcome: raw.last_outcome as ScheduleRunOutcome | null,
    consecutiveFailures: raw.consecutive_failures,
    checkStateJson: raw.check_state_json,
    seenItemsJson: raw.seen_items_json,
    pendingWakeJson: raw.pending_wake_json,
    pendingMessageId: raw.pending_message_id,
    pendingCheckJson: raw.pending_check_json,
    runningDueAt: raw.running_due_at,
    firstRunPendingSince: raw.test_started_at,
    checksRun: raw.checks_run,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    revision: raw.revision
  };
}

/** The schedules tables. Times are ISO strings the caller passes in: the
 *  store reads no clock. */
export class ScheduleStore {
  constructor(private readonly db: Database) {}

  insert(input: NewSchedule, at: string): ScheduleRow {
    const id = newId("sch");
    this.db.prepare(
      `insert into agent_schedules (id, thread_id, name, cron, timezone, check_script, check_timeout_ms, brief, status,
         paused_reason, next_due_at, check_state_json, seen_items_json, test_started_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.threadId, input.name, input.cron, input.timezone, input.checkScript, input.checkTimeoutMs, input.brief,
      input.status, input.pausedReason ?? null, input.nextDueAt, input.checkStateJson ?? "{}", input.seenItemsJson ?? "[]",
      input.firstRunPendingSince ?? null, at, at
    );
    return this.get(id)!;
  }

  get(id: string): ScheduleRow | null {
    const raw = this.db.prepare("select * from agent_schedules where id = ?").get(id) as Raw | null;
    return raw ? rowOf(raw) : null;
  }

  all(): ScheduleRow[] {
    return (this.db.prepare("select * from agent_schedules order by created_at, id").all() as Raw[]).map(rowOf);
  }

  byThread(threadId: string): ScheduleRow[] {
    return (this.db.prepare("select * from agent_schedules where thread_id = ? order by created_at, id").all(threadId) as Raw[]).map(rowOf);
  }

  /** Active schedules due at or before `nowIso`, the longest overdue first. */
  due(nowIso: string): ScheduleRow[] {
    return (this.db.prepare(
      "select * from agent_schedules where status = 'active' and next_due_at is not null and next_due_at <= ? order by next_due_at, id"
    ).all(nowIso) as Raw[]).map(rowOf);
  }

  /** Writes `patch` and bumps the revision; false when the row is gone or,
   *  with `expectRevision`, was changed since it was read. */
  update(id: string, patch: Partial<Writable>, opts: { at: string; expectRevision?: number }): boolean {
    const keys = Object.keys(patch) as Array<keyof Writable>;
    const sets = [...keys.map((key) => `${COLUMN[key]} = ?`), "updated_at = ?", "revision = revision + 1"];
    const values = [...keys.map((key) => patch[key] ?? null), opts.at];
    const where = opts.expectRevision === undefined ? "id = ?" : "id = ? and revision = ?";
    const args = opts.expectRevision === undefined ? [id] : [id, opts.expectRevision];
    return this.db.prepare(`update agent_schedules set ${sets.join(", ")} where ${where}`).run(...values, ...args).changes > 0;
  }

  /** The thread a schedule wakes: set at the start for a new schedule an
   *  older version was still testing (it had none yet). */
  setThread(id: string, threadId: string, at: string): void {
    this.db.prepare("update agent_schedules set thread_id = ?, updated_at = ?, revision = revision + 1 where id = ?").run(threadId, at, id);
  }

  /** Runs `fn` in one immediate transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  /** The schedule and its runs. */
  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("delete from agent_schedule_runs where schedule_id = ?").run(id);
      this.db.prepare("delete from agent_schedules where id = ?").run(id);
    }).immediate();
  }

  recordRun(run: NewScheduleRun): void {
    this.db.transaction(() => {
      this.db.prepare(
        `insert into agent_schedule_runs (schedule_id, thread_id, due_at, started_at, finished_at, outcome, exit_code, duration_ms, line, missed)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(run.scheduleId, run.threadId, run.dueAt, run.startedAt, run.finishedAt, run.outcome, run.exitCode, run.durationMs, run.line, run.missed);
      if (CHECKS_THAT_RAN.has(run.outcome)) this.db.prepare("update agent_schedules set checks_run = checks_run + 1 where id = ?").run(run.scheduleId);
      const weekAgo = new Date(Date.parse(run.startedAt) - WEEK_MS).toISOString();
      this.db.prepare(
        `delete from agent_schedule_runs where schedule_id = ? and started_at < ? and id not in
           (select id from agent_schedule_runs where schedule_id = ? order by id desc limit ?)`
      ).run(run.scheduleId, weekAgo, run.scheduleId, SCHEDULE_RUNS_KEPT);
    }).immediate();
  }

  /** The newest runs first. */
  runs(scheduleId: string, limit: number): ScheduleRunRow[] {
    const rows = this.db.prepare(
      "select * from agent_schedule_runs where schedule_id = ? order by id desc limit ?"
    ).all(scheduleId, limit) as Array<{
      id: number; schedule_id: string; thread_id: string; due_at: string; started_at: string; finished_at: string;
      outcome: string; exit_code: number | null; duration_ms: number; line: string; missed: number;
    }>;
    return rows.map((r) => ({
      id: r.id, scheduleId: r.schedule_id, threadId: r.thread_id, dueAt: r.due_at, startedAt: r.started_at,
      finishedAt: r.finished_at, outcome: r.outcome as ScheduleRunOutcome, exitCode: r.exit_code,
      durationMs: r.duration_ms, line: r.line, missed: r.missed
    }));
  }

  /** Runs and wakes of a schedule since `sinceIso`. */
  runCountsSince(scheduleId: string, sinceIso: string): { runs: number; wakes: number } {
    const row = this.db.prepare(
      `select count(*) as runs, sum(case when outcome in ('woke', 'manual_woke') then 1 else 0 end) as wakes
       from agent_schedule_runs where schedule_id = ? and started_at >= ?`
    ).get(scheduleId, sinceIso) as { runs: number; wakes: number | null };
    return { runs: row.runs, wakes: row.wakes ?? 0 };
  }

  /** Seq of the thread's newest reply reported to the personal agent; null when none. */
  reportedSeq(threadId: string): number | null {
    const row = this.db.prepare(
      `select max(m.seq) as seq from agent_duty_reports r join agent_messages m on m.id = r.message_id
        where r.thread_id = ? and r.outcome = 'sent'`
    ).get(threadId) as { seq: number | null } | null;
    return row?.seq ?? null;
  }

  sidebarAddedAt(threadId: string): string | null {
    const row = this.db.prepare("select added_at from agent_duty_sidebar where thread_id = ?").get(threadId) as { added_at: string } | null;
    return row?.added_at ?? null;
  }

  /** Puts a thread in the sidebar; one already there keeps its place. */
  addToSidebar(threadId: string, at: string): void {
    this.db.prepare("insert or ignore into agent_duty_sidebar (thread_id, added_at) values (?, ?)").run(threadId, at);
  }

  removeFromSidebar(threadId: string): boolean {
    return this.db.prepare("delete from agent_duty_sidebar where thread_id = ?").run(threadId).changes > 0;
  }

  /** A manager thread is a duty thread while it has a schedule, paused or not. */
  isDutyThread(threadId: string): boolean {
    return this.db.prepare("select 1 from agent_schedules where thread_id = ? limit 1").get(threadId) !== null;
  }

  dutyThread(threadId: string): DutyThreadRow | null {
    const raw = this.db.prepare("select * from agent_duty_threads where thread_id = ?").get(threadId) as
      | { thread_id: string; level: string; notes_dir: string; last_told_seq: number; created_at: string }
      | null;
    return raw
      ? { threadId: raw.thread_id, level: raw.level as DutyLevel, notesDir: raw.notes_dir, lastToldSeq: raw.last_told_seq, createdAt: raw.created_at }
      : null;
  }

  /** The duty thread's row, made the first time; an existing row keeps its level. */
  ensureDutyThread(threadId: string, level: DutyLevel, notesDir: string, at: string): DutyThreadRow {
    this.db.prepare(
      "insert or ignore into agent_duty_threads (thread_id, level, notes_dir, created_at) values (?, ?, ?, ?)"
    ).run(threadId, level, notesDir, at);
    return this.dutyThread(threadId)!;
  }

  setLevel(threadId: string, level: DutyLevel): void {
    this.db.prepare("update agent_duty_threads set level = ? where thread_id = ?").run(level, threadId);
  }

  setLastToldSeq(threadId: string, seq: number): void {
    this.db.prepare("update agent_duty_threads set last_told_seq = ? where thread_id = ?").run(seq, threadId);
  }

  recordReport(messageId: string, threadId: string, outcome: DutyReportOutcome, at: string): void {
    this.db.prepare(
      "insert or replace into agent_duty_reports (message_id, thread_id, outcome, at) values (?, ?, ?, ?)"
    ).run(messageId, threadId, outcome, at);
  }

  reportsFor(messageIds: readonly string[]): Map<string, DutyReportOutcome> {
    const found = new Map<string, DutyReportOutcome>();
    // A read of a thread from its start can be long: asked in slices, well
    // under SQLite's limit on bound values.
    for (let i = 0; i < messageIds.length; i += REPORT_LOOKUP_SLICE) {
      const slice = messageIds.slice(i, i + REPORT_LOOKUP_SLICE);
      const rows = this.db.prepare(
        `select message_id, outcome from agent_duty_reports where message_id in (${slice.map(() => "?").join(", ")})`
      ).all(...slice) as Array<{ message_id: string; outcome: string }>;
      const bySlice = new Map(rows.map((r) => [r.message_id, r.outcome as DutyReportOutcome]));
      for (const id of slice) {
        const outcome = bySlice.get(id);
        if (outcome) found.set(id, outcome);
      }
    }
    return found;
  }
}
