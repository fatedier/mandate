import type { Database } from "bun:sqlite";
import type { AgentStore, AgentWakeReason } from "./agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { newId } from "../../platform/ids.js";
import { limitToolText } from "./tool-result-format.js";
import { parseDurationMs } from "./duration.js";
import { logError } from "../../platform/logger.js";
import { formatAgentTime, localTimeZone } from "../../platform/time/agent-time.js";

export interface AlarmRecord {
  id: string;
  threadId: string;
  fireAt: string;
  note: string;
  status: "pending" | "fired" | "canceled";
  createdAt: string;
  firedAt: string | null;
}

export interface RawAlarmRow {
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
  /** A turn holds the thread: a fired alarm's mail waits for it, taken in at
   *  the turn's next step or woken for at the thread's release. */
  isThreadBusy?: (threadId: string) => boolean;
  /** The zone its message writes times in, as the agent's messages do.
   *  Unset: the machine's. */
  timeZone?: string;
  /** A thread whose feature is archived: its due alarms are cancelled — all
   *  of that thread's pending ones — instead of fired. */
  isThreadRetired?: (threadId: string) => boolean;
  /** A thread's pending alarms changed: one was set, fired or cancelled. */
  onPendingChanged?: (threadId: string) => void;
  /** A fired alarm's wake was refused every time it was tried: nothing will
   *  wake the thread for it now. */
  onWakeAbandoned?: (threadId: string) => void;
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
/** An alarm the database would not let fire (an outside writer holding it
 *  past the busy timeout) is tried again after this long. */
const FIRE_RETRY_MS = 30_000;
const MAX_WAKE_RETRIES = 10;
/** Telling that a wake was given up (its waits judged again, which writes) is
 *  tried this many more times, FIRE_RETRY_MS apart, when refused. */
const MAX_ABANDON_RETRIES = 10;

/** Persistent alarms — an agent can schedule a future wake of its own thread
 *  with a note. Survives server restarts (timers reschedule from DB on init).
 *
 *  At fire_at the row is marked 'fired' and an `[Mandate alarm]` user-role
 *  message goes into the thread's mailbox, then wake(reason='alarm'). Mail,
 *  not a message: a busy thread's turn takes it in at its next step, or its
 *  release wakes for it, and a restart keeps it. */
export class AgentAlarmManager {
  private timers = new Map<string, AgentAlarmTimerHandle>();
  /** Wakes tried again (a busy thread, a refused row), and abandon notices
   *  tried again: cleared with the rest. */
  private readonly wakeRetries = new Set<AgentAlarmTimerHandle>();
  /** Fired alarms whose wake has not started yet, by alarm id: the thread
   *  still waits on them (listWaitedOn) until it does or is given up. */
  private readonly delivering = new Map<string, AlarmRecord>();
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
    if (!thread || thread.archivedAt) {
      throw new Error(`thread not found or archived: ${input.threadId}`);
    }
    if (this.deps.isThreadRetired?.(thread.id)) {
      // Refused here rather than accepted and silently cancelled when due, so
      // the agent can tell the person the alarm will not fire.
      throw new Error("this feature is archived, so an alarm here would never fire; restore the feature first");
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
    this.deps.onPendingChanged?.(input.threadId);

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
    this.deps.onPendingChanged?.(threadId);
    return {
      ...toRecord(row),
      status: "canceled"
    };
  }

  /** The threads that wait on an alarm (listWaitedOn). */
  threadIds(): string[] {
    const pending = (this.deps.db.prepare(
      `select distinct thread_id from agent_alarms where status = 'pending' order by thread_id`
    ).all() as Array<{ thread_id: string }>).map((row) => row.thread_id);
    return [...new Set([...pending, ...[...this.delivering.values()].map((alarm) => alarm.threadId)])].sort();
  }

  /** What a thread waits on of its alarms: the pending ones, and the fired
   *  ones whose wake has not started yet. */
  listWaitedOn(threadId: string): AlarmRecord[] {
    return [...this.list(threadId), ...[...this.delivering.values()].filter((alarm) => alarm.threadId === threadId)];
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
    // A fired one still being woken for goes too: its retries then stop.
    let delivering = 0;
    for (const [id, alarm] of this.delivering) {
      if (alarm.threadId !== threadId) continue;
      this.delivering.delete(id);
      delivering += 1;
    }
    if (rows.length + delivering > 0) this.deps.onPendingChanged?.(threadId);
    return rows.length;
  }

  /** Called by the server on shutdown — clears all timers. Pending DB rows
   *  remain and will be re-armed on next startup. */
  dispose(): void {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.wakeRetries) this.clock.clearTimeout(timer);
    this.wakeRetries.clear();
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
    if (!thread || thread.archivedAt) {
      this.deps.db.prepare(
        `update agent_alarms set status = 'canceled' where id = ?`
      ).run(id);
      this.deps.onPendingChanged?.(row.thread_id);
      return;
    }
    if (this.deps.isThreadRetired?.(thread.id)) {
      // No alarm message into an archived feature's conversation, no wake,
      // and nothing left queued behind this one to try again.
      this.cancelThread(thread.id);
      return;
    }

    // Fired and its mail written together: apart, mail the database refused
    // left the alarm fired with nothing written, never to fire again. Its
    // message reaches the thread (and the page) when a turn takes it in.
    try {
      this.deps.db.transaction(() => {
        const firedAt = new Date(this.clock.now()).toISOString();
        this.deps.db.prepare(
          `update agent_alarms set status = 'fired', fired_at = ? where id = ?`
        ).run(firedAt, id);
        this.deps.agentStore.enqueueMailboxMessage({
          threadId: row.thread_id,
          role: "user",
          source: "alarm",
          content: {
            type: "text",
            text: renderAlarmMessage(row, this.deps.timeZone ?? localTimeZone())
          }
        });
      }).immediate();
    } catch (err) {
      logError(`alarm ${id} could not fire`, err);
      this.armTimer(id, this.clock.now() + FIRE_RETRY_MS);
      return;
    }
    // Waited on until its wake starts: the thread never reads stopped in
    // between, a refused wake's retries included.
    this.delivering.set(id, { ...toRecord(row), status: "fired", firedAt: new Date(this.clock.now()).toISOString() });
    this.wakeWithRetry(id, row.thread_id, 0);
  }

  /** The alarm's wake started or was given up: the thread no longer waits on it. */
  private endDelivery(alarmId: string, threadId: string): void {
    if (this.delivering.delete(alarmId)) this.deps.onPendingChanged?.(threadId);
  }

  /** Says a wake was given up, tried again while that is refused. */
  private abandon(threadId: string, attempt: number): void {
    try {
      this.deps.onWakeAbandoned?.(threadId);
    } catch (err) {
      logError(`the end of alarm wakes for ${threadId} could not be told`, err);
      if (attempt >= MAX_ABANDON_RETRIES) return;
      const retry = this.clock.setTimeout(() => {
        this.wakeRetries.delete(retry);
        this.abandon(threadId, attempt + 1);
      }, FIRE_RETRY_MS);
      this.wakeRetries.add(retry);
    }
  }

  private wakeWithRetry(alarmId: string, threadId: string, attempt: number): void {
    // Cancelled with its thread meanwhile: nothing more to wake for.
    if (!this.delivering.has(alarmId)) return;
    let result: string | null | void;
    try {
      result = this.deps.onWake(threadId, "alarm", null);
    } catch (err) {
      // Its row refused (another writer held the database): its mail is
      // written, and nothing else wakes the thread for it now. Tried again.
      logError(`alarm wake for ${threadId} was refused`, err);
      result = null;
    }
    // Started; or a turn holds the thread, which takes the mail in at its
    // next step or is woken for it at its release.
    if (result !== null || this.deps.isThreadBusy?.(threadId)) {
      this.endDelivery(alarmId, threadId);
      return;
    }
    if (attempt >= MAX_WAKE_RETRIES) {
      this.endDelivery(alarmId, threadId);
      this.abandon(threadId, 0);
      return;
    }
    const retry = this.clock.setTimeout(() => {
      this.wakeRetries.delete(retry);
      this.wakeWithRetry(alarmId, threadId, attempt + 1);
    }, WAKE_RETRY_MS);
    this.wakeRetries.add(retry);
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

  const relativeMs = parseDurationMs(raw);
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

export function renderAlarmMessage(row: RawAlarmRow, timeZone: string): string {
  const time = (at: string) => formatAgentTime(at, timeZone) ?? at;
  const lines = [
    "[Mandate alarm fired]",
    `alarmId: ${row.id}`,
    `scheduled at: ${time(row.created_at)}`,
    `fired at: ${time(row.fire_at)}`
  ];
  const note = limitToolText(row.note, NOTE_MAX_CHARS);
  if (note.text) lines.push(`note: ${note.text}`);
  return lines.join("\n");
}
