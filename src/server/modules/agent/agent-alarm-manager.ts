import type { Database } from "bun:sqlite";
import type { AgentStore, AgentWakeReason } from "./agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { newId } from "../../platform/ids.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { limitToolText } from "./tool-result-format.js";

export interface AlarmRecord {
  id: string;
  threadId: string;
  fireAt: string;
  note: string;
  status: "pending" | "fired" | "canceled";
  createdAt: string;
  firedAt: string | null;
}

interface RawAlarmRow {
  id: string;
  thread_id: string;
  fire_at: string;
  note: string;
  status: AlarmRecord["status"];
  created_at: string;
  fired_at: string | null;
}

interface AgentAlarmManagerDeps {
  db: Database;
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  onWake: (threadId: string, reason: AgentWakeReason, triggerMessageId: string | null) => string | null | void;
  timers?: AgentAlarmTimers;
}

export type AgentAlarmTimerHandle = unknown;

export interface AgentAlarmTimers {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => AgentAlarmTimerHandle;
  clearTimeout: (timer: AgentAlarmTimerHandle) => void;
}

const MIN_DELAY_MS = 1000;                  // 1 second
const MAX_DELAY_MS = 30 * 24 * 3600 * 1000;  // 30 days
const MAX_PENDING_PER_THREAD = 20;
const NOTE_MAX_CHARS = 600;
const WAKE_RETRY_MS = 1000;
const MAX_WAKE_RETRIES = 10;

/** Persistent alarms — an agent can schedule a future wake of its own thread
 *  with a note. Survives server restarts (timers reschedule from DB on init).
 *
 *  Triggers an `[Mandate alarm]` user-role message + wake(reason='alarm') at
 *  fire_at time, marks the row 'fired'. */
export class AgentAlarmManager {
  private timers = new Map<string, AgentAlarmTimerHandle>();
  private readonly clock: AgentAlarmTimers;

  constructor(private deps: AgentAlarmManagerDeps) {
    this.clock = deps.timers ?? DEFAULT_ALARM_TIMERS;
    this.rescheduleAllPending();
  }

  schedule(input: {
    threadId: string;
    when: string;
    note: string;
  }): AlarmRecord {
    const thread = this.deps.agentStore.getThreadById(input.threadId);
    if (!thread || thread.archivedAt || thread.closedAt) {
      throw new Error(`thread not found or archived: ${input.threadId}`);
    }

    const now = this.clock.now();
    const fireAtMs = resolveFireAtMs(now, input.when);
    const note = (input.note ?? "").trim();
    if (!note) throw new Error("note is required");

    const pendingCount = this.deps.db.prepare(
      `select count(*) as n from agent_alarms where thread_id = ? and status = 'pending'`
    ).get(input.threadId) as { n: number };
    if (pendingCount.n >= MAX_PENDING_PER_THREAD) {
      throw new Error(
        `too many pending alarms on this thread (${pendingCount.n} / ${MAX_PENDING_PER_THREAD}); cancel one before scheduling another`
      );
    }

    const id = newId("alm");
    const createdAt = new Date(now).toISOString();
    const fireAt = new Date(fireAtMs).toISOString();
    const truncatedNote = note.slice(0, NOTE_MAX_CHARS);
    this.deps.db.prepare(
      `insert into agent_alarms (id, thread_id, fire_at, note, status, created_at)
       values (?, ?, ?, ?, 'pending', ?)`
    ).run(id, input.threadId, fireAt, truncatedNote, createdAt);

    this.armTimer(id, fireAtMs);

    return {
      id,
      threadId: input.threadId,
      fireAt,
      note: truncatedNote,
      status: "pending",
      createdAt,
      firedAt: null
    };
  }

  list(threadId: string, opts: { includeFired?: boolean } = {}): AlarmRecord[] {
    const rows = opts.includeFired
      ? this.deps.db.prepare(
          `select * from agent_alarms where thread_id = ? order by fire_at desc`
        ).all(threadId) as RawAlarmRow[]
      : this.deps.db.prepare(
          `select * from agent_alarms where thread_id = ? and status = 'pending' order by fire_at asc`
        ).all(threadId) as RawAlarmRow[];
    return rows.map(toRecord);
  }

  cancel(alarmId: string, threadId: string): AlarmRecord | null {
    const row = this.deps.db.prepare(
      `select * from agent_alarms where id = ? and thread_id = ?`
    ).get(alarmId, threadId) as RawAlarmRow | undefined;
    if (!row) return null;
    if (row.status !== "pending") return toRecord(row);
    this.deps.db.prepare(
      `update agent_alarms set status = 'canceled' where id = ?`
    ).run(alarmId);
    const timer = this.timers.get(alarmId);
    if (timer) {
      this.clock.clearTimeout(timer);
      this.timers.delete(alarmId);
    }
    return {
      ...toRecord(row),
      status: "canceled"
    };
  }

  cancelThread(threadId: string): number {
    const rows = this.deps.db.prepare(
      `select id from agent_alarms where thread_id = ? and status = 'pending'`
    ).all(threadId) as Array<{ id: string }>;
    this.deps.db.prepare(
      `update agent_alarms set status = 'canceled' where thread_id = ? and status = 'pending'`
    ).run(threadId);
    for (const row of rows) {
      const timer = this.timers.get(row.id);
      if (!timer) continue;
      this.clock.clearTimeout(timer);
      this.timers.delete(row.id);
    }
    return rows.length;
  }

  /** Called by the server on shutdown — clears all timers. Pending DB rows
   *  remain and will be re-armed on next startup. */
  dispose(): void {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
  }

  private rescheduleAllPending(): void {
    const rows = this.deps.db.prepare(
      `select id, fire_at from agent_alarms where status = 'pending'`
    ).all() as Array<{ id: string; fire_at: string }>;
    for (const row of rows) {
      const fireAtMs = Date.parse(row.fire_at);
      if (!Number.isFinite(fireAtMs)) continue;
      this.armTimer(row.id, fireAtMs);
    }
  }

  private armTimer(id: string, fireAtMs: number): void {
    const delay = Math.max(0, fireAtMs - this.clock.now());
    // setTimeout caps internally at ~24.8 days; for longer delays (we allow
    // up to 30) chain timers. Reschedule when the inner timer fires.
    const ONE_DAY = 24 * 3600 * 1000;
    if (delay > ONE_DAY) {
      const timer = this.clock.setTimeout(() => this.armTimer(id, fireAtMs), ONE_DAY);
      this.timers.set(id, timer);
      return;
    }
    const timer = this.clock.setTimeout(() => this.fire(id), delay);
    this.timers.set(id, timer);
  }

  private fire(id: string): void {
    this.timers.delete(id);
    const row = this.deps.db.prepare(
      `select * from agent_alarms where id = ?`
    ).get(id) as RawAlarmRow | undefined;
    if (!row || row.status !== "pending") return;

    const thread = this.deps.agentStore.getThreadById(row.thread_id);
    if (!thread || thread.archivedAt || thread.closedAt) {
      this.deps.db.prepare(
        `update agent_alarms set status = 'canceled' where id = ?`
      ).run(id);
      return;
    }

    const firedAt = new Date(this.clock.now()).toISOString();
    this.deps.db.prepare(
      `update agent_alarms set status = 'fired', fired_at = ? where id = ?`
    ).run(firedAt, id);

    const message = this.deps.agentStore.appendMessage({
      threadId: row.thread_id,
      role: "user",
      source: "alarm",
      content: {
        type: "text",
        text: renderAlarmMessage(row)
      }
    });
    this.deps.sse.emit(SSE_EVENTS.agentMessageAppended, {
      threadId: row.thread_id,
      message
    });
    this.wakeWithRetry(row.thread_id, message.id, 0);
  }

  private wakeWithRetry(threadId: string, messageId: string, attempt: number): void {
    const result = this.deps.onWake(threadId, "alarm", messageId);
    if (result !== null) return;
    if (attempt >= MAX_WAKE_RETRIES) return;
    this.clock.setTimeout(() => this.wakeWithRetry(threadId, messageId, attempt + 1), WAKE_RETRY_MS);
  }
}

const DEFAULT_ALARM_TIMERS: AgentAlarmTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

function resolveFireAtMs(nowMs: number, when: string): number {
  const raw = (when ?? "").trim();
  if (!raw) throw new Error("when is required");

  const relativeMs = parseRelativeDurationMs(raw);
  const fireAtMs = relativeMs !== null
    ? nowMs + relativeMs
    : Date.parse(raw);
  if (!Number.isFinite(fireAtMs)) {
    throw new Error("when must be a relative duration like '30m' or an ISO time with timezone");
  }

  const delayMs = Math.floor(fireAtMs - nowMs);
  if (delayMs < MIN_DELAY_MS) throw new Error(`when must be at least ${MIN_DELAY_MS}ms in the future`);
  if (delayMs > MAX_DELAY_MS) throw new Error(`when cannot exceed ${MAX_DELAY_MS}ms (30 days)`);
  return fireAtMs;
}

function parseRelativeDurationMs(raw: string): number | null {
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|msec|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2]!.toLowerCase();
  const multiplier =
    unit === "ms" || unit === "msec" || unit.startsWith("millisecond") ? 1
      : unit === "s" || unit === "sec" || unit === "secs" || unit.startsWith("second") ? 1000
        : unit === "m" || unit === "min" || unit === "mins" || unit.startsWith("minute") ? 60_000
          : unit === "h" || unit === "hr" || unit === "hrs" || unit.startsWith("hour") ? 3_600_000
            : unit === "d" || unit.startsWith("day") ? 86_400_000
              : 0;
  return multiplier > 0 ? Math.floor(value * multiplier) : null;
}

function toRecord(row: RawAlarmRow): AlarmRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    fireAt: row.fire_at,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    firedAt: row.fired_at
  };
}

function renderAlarmMessage(row: RawAlarmRow): string {
  const lines = [
    "[Mandate alarm fired]",
    `alarmId: ${row.id}`,
    `scheduled at: ${row.created_at}`,
    `fired at: ${row.fire_at}`
  ];
  const note = limitToolText(row.note, NOTE_MAX_CHARS);
  if (note.text) lines.push(`note: ${note.text}`);
  return lines.join("\n");
}
