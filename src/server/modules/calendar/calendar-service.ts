import { CALENDAR_LIMITS, type CalendarActor, type CalendarDto, type CalendarEntryDto, type CalendarTimeDto } from "../../../shared/api/calendar.js";
import { SSE_EVENTS } from "../../../shared/api/sse.js";
import { parseDurationMs } from "../../../shared/duration-short.js";
import { newId } from "../../platform/ids.js";
import { logError } from "../../platform/logger.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { AgentAlarmTimers } from "../agent/agent-alarm-manager.js";
import { ScheduleRefusal } from "../schedules/cron.js";
import { CalendarRefusal, checkRepeat, dayStart, dueTimesAfterMs, dueTimesBetween, isDay, nextDay, repeatWords, type CalendarRule } from "./calendar-rules.js";
import type { CalendarEntryRow, CalendarStore, CalendarTimeRow } from "./calendar-store.js";
import { renderCalendarDue } from "./calendar-text.js";

export interface CalendarServiceDeps {
  store: CalendarStore;
  sse: Pick<AgentSseEmitter, "emit">;
  /** The agent's zone: what it reads times in, and a repeat's zone by default. */
  timeZone: string;
  /** Posts the message for a due time inside the caller's transaction; the
   *  wake it returns runs after the commit. */
  deliver: (text: string, entryId: string) => () => void;
  now?: () => number;
  timers?: AgentAlarmTimers;
}

export interface CalendarAddInput {
  title?: string;
  note?: string;
  at?: string;
  repeat?: string;
  timezone?: string;
  until?: string;
}

export interface CalendarChange extends CalendarAddInput {
  paused?: boolean;
  skip?: string;
}

const DAY_MS = 86_400_000;
/** Times walked at once when a long gap is caught up. */
const PAGE = 3000;
/** An absolute time with its offset: 2026-05-22T10:30[:00[.000]](Z|+08:00). */
const ISO_WITH_OFFSET = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** A write refused (the database held by another writer): looked at again. */
const RETRY_MS = 30_000;
/** Rules' ranges kept worked out: the page's few views, of a few entries. */
const EXPANDED_KEPT = 64;

const REAL_TIMERS: AgentAlarmTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

const ENTRY_NEEDS = "An entry needs a title, a note, and at or repeat.";

function given(text: string | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** A title as one line: the agent's context and the wake's first line hold it. */
function oneLine(text: string | undefined): string | null {
  return given(text?.replace(/\s+/g, " "));
}

function ruleOf(row: Pick<CalendarEntryRow, "atMs" | "cron" | "timezone" | "untilDay">): CalendarRule {
  return { atMs: row.atMs, cron: row.cron, timezone: row.timezone, untilDay: row.untilDay };
}

/** The personal agent's calendar: entries once or on a repeat, each due time
 *  recorded as delivered, missed, skipped or paused, and the agent woken with
 *  the entry's note for the ones delivered. One timer, to the soonest time. */
/** A recorded time as `read` tells it. */
export type CalendarRecentTime = CalendarTimeDto & { missedBefore: number };

export class CalendarService {
  private readonly store: CalendarStore;
  private readonly clock: AgentAlarmTimers;
  private timer: unknown = null;
  private disposed = false;
  /** Rule and range → its times (see timesOf). */
  private readonly expanded = new Map<string, readonly number[]>();

  constructor(private readonly deps: CalendarServiceDeps) {
    this.store = deps.store;
    this.clock = deps.timers ?? { ...REAL_TIMERS, ...(deps.now ? { now: deps.now } : {}) };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : this.clock.now();
  }

  // ---------- the agent's and the user's writes ----------

  add(input: CalendarAddInput): CalendarEntryDto {
    this.settle();
    const now = this.now();
    const title = oneLine(input.title);
    const note = given(input.note);
    const atText = given(input.at);
    const repeat = given(input.repeat);
    if (title === null || note === null || (atText === null && repeat === null)) throw new CalendarRefusal(ENTRY_NEEDS);
    if (atText !== null && repeat !== null) throw new CalendarRefusal("Give at or repeat, not both.");
    this.checkLengths(title, note);
    const timezone = given(input.timezone) ?? this.deps.timeZone;
    const base = { title, note, timezone, pausedAt: null, pausedBy: null, skips: [], createdAt: now, updatedAt: now, deletedAt: null, deletedBy: null };
    const row: CalendarEntryRow = atText !== null
      ? { ...base, id: newId("cal"), atMs: this.resolveAt(atText, now), cron: null, untilDay: null, nextDueMs: null }
      : { ...base, id: newId("cal"), atMs: null, ...this.repeatRule(repeat!, timezone, given(input.until), now), nextDueMs: null };
    row.nextDueMs = this.firstAfter(row, now);
    this.write([row.id], () => this.store.insert(row));
    return this.dto(this.store.get(row.id)!);
  }

  update(id: string, change: CalendarChange): CalendarEntryDto {
    this.settle();
    const now = this.now();
    const row = this.live(id);
    const patch: Partial<CalendarEntryRow> = { updatedAt: now };
    if (change.title !== undefined || change.note !== undefined) {
      const title = change.title === undefined ? row.title : oneLine(change.title);
      const note = change.note === undefined ? row.note : given(change.note);
      if (title === null || note === null) throw new CalendarRefusal(ENTRY_NEEDS);
      this.checkLengths(title, note);
      Object.assign(patch, { title, note });
    }
    const atText = given(change.at);
    const repeat = given(change.repeat);
    if (atText !== null && repeat !== null) throw new CalendarRefusal("Give at or repeat, not both.");
    let timing = false;
    if (atText !== null) {
      Object.assign(patch, { atMs: this.resolveAt(atText, now), cron: null, untilDay: null, skips: [], pausedAt: null, pausedBy: null });
      timing = true;
    } else if (repeat !== null || (row.cron !== null && (given(change.timezone) !== null || given(change.until) !== null))) {
      // A zone or an end given for a one-off says nothing, as add takes them:
      // a model fills the fields it does not mean.
      const cron = repeat ?? row.cron!;
      const timezone = given(change.timezone) ?? row.timezone;
      // A blank until is not given, as every blank: the end stays.
      const until = given(change.until) ?? row.untilDay;
      Object.assign(patch, { atMs: null, ...this.repeatRule(cron, timezone, until, now), ...(row.cron === null ? { skips: [] } : {}) });
      timing = true;
    }
    const merged: CalendarEntryRow = { ...row, ...patch };
    // A one-off "not paused" is so already; pausing or skipping one is refused.
    if (change.paused === true || change.skip !== undefined || (change.paused === false && merged.cron !== null)) {
      if (merged.cron === null) throw new CalendarRefusal("paused and skip are for a repeat.");
      if (change.skip !== undefined) patch.skips = merged.skips = this.addSkips(merged, this.dayTimes(merged, change.skip));
      if (change.paused !== undefined && change.paused !== (row.pausedAt !== null)) {
        Object.assign(patch, change.paused ? { pausedAt: now, pausedBy: "agent" } : { pausedAt: null, pausedBy: null });
      }
    }
    if (timing) patch.nextDueMs = this.firstAfter({ ...row, ...patch }, now);
    this.write([id], () => {
      this.store.update(id, patch);
      if (change.paused !== undefined && change.paused !== (row.pausedAt !== null)) this.store.addChange({ entryId: id, kind: change.paused ? "pause" : "resume", by: "agent", at: now, dueMs: null });
      if (change.skip !== undefined) this.store.addChange({ entryId: id, kind: "skip", by: "agent", at: now, dueMs: null });
    });
    return this.dto(this.store.get(id)!);
  }

  remove(id: string, by: CalendarActor): CalendarEntryDto {
    this.settle();
    const now = this.now();
    const row = this.live(id);
    this.write([id], () => {
      this.store.update(id, { deletedAt: now, deletedBy: by, nextDueMs: null, updatedAt: now });
      this.store.addChange({ entryId: id, kind: "delete", by, at: now, dueMs: null });
    });
    return this.dto({ ...row, deletedAt: now, deletedBy: by, nextDueMs: null });
  }

  pause(id: string, by: CalendarActor): CalendarEntryDto {
    return this.setPaused(id, true, by);
  }

  resume(id: string, by: CalendarActor): CalendarEntryDto {
    return this.setPaused(id, false, by);
  }

  /** The page's "Only this one": one due time of a repeat is not delivered. */
  skipTime(id: string, dueMs: number, by: CalendarActor): CalendarEntryDto {
    this.settle();
    const now = this.now();
    const row = this.live(id);
    if (row.cron === null) throw new CalendarRefusal("paused and skip are for a repeat.");
    if (!dueTimesBetween(ruleOf(row), dueMs, dueMs + 1).includes(dueMs)) throw new CalendarRefusal("That day is not one of its due days.");
    // Delivered (or recorded) meanwhile: the page's confirmation was open as it came.
    if (dueMs <= now || this.store.hasTime(id, dueMs)) throw new CalendarRefusal("That time has passed.");
    this.write([id], () => {
      this.store.update(id, { skips: this.addSkips(row, [dueMs]), updatedAt: now });
      this.store.addChange({ entryId: id, kind: "skip", by, at: now, dueMs });
    });
    return this.dto(this.store.get(id)!);
  }

  // ---------- reads ----------

  entries(): CalendarEntryDto[] {
    return this.store.live().map((row) => this.dto(row));
  }

  entry(id: string): CalendarEntryDto {
    return this.dto(this.live(id));
  }

  /** The recorded times and those still ahead, from `fromMs` to `toMs`. */
  range(fromMs: number, toMs: number): CalendarDto {
    const live = this.store.live();
    const recorded = this.store.timesBetween(fromMs, toMs);
    const seen = new Set(recorded.map((t) => `${t.entryId}@${t.dueMs}`));
    const times: CalendarTimeDto[] = recorded.map((t) => ({
      entryId: t.entryId, title: t.title, at: t.dueMs, outcome: t.outcome, deliveredAt: t.deliveredMs, repeating: t.repeating
    }));
    for (const row of live) {
      if (row.nextDueMs === null) continue;
      const skips = new Set(row.skips);
      for (const due of this.timesOf(row, fromMs, toMs)) {
        if (due < row.nextDueMs || seen.has(`${row.id}@${due}`)) continue;
        const outcome = skips.has(due) ? "skipped" : row.pausedAt !== null ? "paused" : "due";
        times.push({ entryId: row.id, title: row.title, at: due, outcome, deliveredAt: null, repeating: row.cron !== null });
      }
    }
    times.sort((a, b) => a.at - b.at);
    return { entries: live.map((row) => this.dto(row)), times, from: fromMs, to: toMs };
  }

  /** A repeat's times in a range, worked out once for its rule: an hourly
   *  repeat's month is a thousand croner steps (~75 ms), and the page asks
   *  again on every change. What became of each time is not kept here. */
  private timesOf(row: CalendarEntryRow, fromMs: number, toMs: number): readonly number[] {
    if (row.cron === null) return dueTimesBetween(ruleOf(row), fromMs, toMs);
    const key = `${row.cron}|${row.timezone}|${row.untilDay ?? ""}|${fromMs}|${toMs}`;
    let times = this.expanded.get(key);
    if (!times) {
      times = dueTimesBetween(ruleOf(row), fromMs, toMs);
      if (this.expanded.size >= EXPANDED_KEPT) this.expanded.delete(this.expanded.keys().next().value!);
      this.expanded.set(key, times);
    }
    return times;
  }

  /** The repeat's skipped times still ahead. */
  skipsAhead(id: string): number[] {
    const now = this.now();
    return this.live(id).skips.filter((t) => t > now);
  }

  /** Its last recorded times, newest first; a delivered one with how many
   *  earlier times, missed in the same pass, it stood for. */
  recentTimes(id: string): CalendarRecentTime[] {
    const row = this.live(id);
    return this.store.recentTimes(id, CALENDAR_LIMITS.recentTimes).map((t) => ({
      ...this.timeDto(row, t),
      missedBefore: t.outcome === "delivered" ? this.store.missedWith(id, t.recordedAt) : 0
    }));
  }

  userChangesSince(ms: number) {
    return this.store.userChangesSince(ms);
  }

  // ---------- the timer ----------

  /** Due times passed while Mandate was not running, then the timer. */
  start(): void {
    this.disposed = false;
    this.settle();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /** Every live entry whose next time has come: its passed times recorded,
   *  the last one delivered when it may be; then the timer to the next. */
  settle(): void {
    const now = this.now();
    const changed: string[] = [];
    const wakes: Array<() => void> = [];
    let refused = false;
    for (const due of this.store.dueBy(now)) {
      try {
        this.store.db.transaction(() => {
          const row = this.store.get(due.id);
          if (!row || row.deletedAt !== null || row.nextDueMs === null || row.nextDueMs > now) return;
          const wake = this.processPassed(row, now);
          if (wake) wakes.push(wake);
          changed.push(row.id);
        }).immediate();
      } catch (err) {
        logError(`calendar entry ${due.id} could not be settled`, err);
        refused = true;
      }
    }
    for (const wake of wakes) {
      try {
        wake();
      } catch (err) {
        logError("calendar wake was refused", err);
      }
    }
    if (changed.length > 0) this.deps.sse.emit(SSE_EVENTS.calendarChanged, { ids: changed });
    this.arm(refused ? now + RETRY_MS : null);
  }

  private processPassed(row: CalendarEntryRow, now: number): (() => void) | null {
    // Walked a page at a time: a long gap (an hourly repeat off for months) is recorded whole.
    const recorded = this.store.recordedFrom(row.id, row.nextDueMs!);
    const passed: number[] = [];
    for (let cursor = row.nextDueMs!; ;) {
      const page = dueTimesBetween(ruleOf(row), cursor, now + 1, PAGE);
      passed.push(...page.filter((t) => !recorded.has(t)));
      if (page.length < PAGE) break;
      cursor = page.at(-1)! + 1;
    }
    // Only the latest passed time is delivered, and only when it may be: a
    // skipped or paused latest time leaves the earlier ones missed.
    const last = passed.at(-1);
    let missedBefore = 0;
    let wake: (() => void) | null = null;
    for (const t of passed) {
      const base = { entryId: row.id, dueMs: t, recordedAt: now };
      if (row.skips.includes(t)) this.store.addTime({ ...base, outcome: "skipped", deliveredMs: null });
      else if (row.pausedAt !== null) this.store.addTime({ ...base, outcome: "paused", deliveredMs: null });
      else if (t === last) {
        this.store.addTime({ ...base, outcome: "delivered", deliveredMs: now });
        const late = now - t > CALENDAR_LIMITS.lateMs;
        wake = this.deps.deliver(renderCalendarDue(row, t, now, missedBefore, late, this.deps.timeZone), row.id);
      } else {
        this.store.addTime({ ...base, outcome: "missed", deliveredMs: null });
        missedBefore++;
      }
    }
    this.store.update(row.id, { nextDueMs: this.firstAfter(row, now) });
    return wake;
  }

  private arm(retryAt: number | null): void {
    this.clearTimer();
    if (this.disposed) return;
    const soonest = this.store.soonestDue();
    // A refused write is looked at again no sooner than the retry.
    const at = soonest === null ? null : retryAt === null ? soonest : Math.max(soonest, retryAt);
    if (at === null) return;
    const delay = Math.max(0, at - this.now());
    // setTimeout caps near 24.8 days: a farther time is reached a day at a time.
    if (delay > DAY_MS) {
      this.timer = this.clock.setTimeout(() => { this.timer = null; this.arm(null); }, DAY_MS);
      return;
    }
    this.timer = this.clock.setTimeout(() => { this.timer = null; this.settle(); }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------- helpers ----------

  private write(ids: string[], run: () => void): void {
    this.store.db.transaction(run).immediate();
    this.deps.sse.emit(SSE_EVENTS.calendarChanged, { ids });
    this.arm(null);
  }

  private setPaused(id: string, paused: boolean, by: CalendarActor): CalendarEntryDto {
    this.settle();
    const now = this.now();
    const row = this.live(id);
    if (row.cron === null) throw new CalendarRefusal("paused and skip are for a repeat.");
    if ((row.pausedAt !== null) === paused) return this.dto(row);
    this.write([id], () => {
      this.store.update(id, paused ? { pausedAt: now, pausedBy: by, updatedAt: now } : { pausedAt: null, pausedBy: null, updatedAt: now });
      this.store.addChange({ entryId: id, kind: paused ? "pause" : "resume", by, at: now, dueMs: null });
    });
    return this.dto(this.store.get(id)!);
  }

  private live(id: string): CalendarEntryRow {
    const row = this.store.get(id);
    if (!row || row.deletedAt !== null) throw new CalendarRefusal("No calendar entry with that id.", 404);
    return row;
  }

  private checkLengths(title: string, note: string): void {
    if (title.length > CALENDAR_LIMITS.title || note.length > CALENDAR_LIMITS.note) {
      throw new CalendarRefusal("A title is at most 120 characters and a note at most 2000.");
    }
  }

  private resolveAt(text: string, now: number): number {
    const relative = parseDurationMs(text);
    const iso = relative === null ? ISO_WITH_OFFSET.exec(text) : null;
    const ms = relative !== null ? now + relative : iso && isDay(iso[1]!) ? Date.parse(text) : Number.NaN;
    if (!Number.isFinite(ms)) throw new CalendarRefusal("at must be a relative duration like '30m' or an ISO time with timezone.");
    if (ms - now < CALENDAR_LIMITS.onceMinMs || ms - now > CALENDAR_LIMITS.onceMaxMs) throw new CalendarRefusal("at must be from 1 minute to 1 year from now.");
    return ms;
  }

  private repeatRule(cron: string, timezone: string, until: string | null, now: number): Pick<CalendarEntryRow, "cron" | "timezone" | "untilDay"> {
    try {
      checkRepeat(cron, timezone, now);
    } catch (err) {
      if (err instanceof ScheduleRefusal) throw new CalendarRefusal(err.message);
      throw err;
    }
    if (until !== null) {
      if (!isDay(until)) throw new CalendarRefusal("Give days as YYYY-MM-DD.");
      if (dueTimesBetween({ atMs: null, cron, timezone, untilDay: until }, now + 1, dayStart(nextDay(until), timezone)).length === 0) {
        throw new CalendarRefusal("That repeat is never due by its until day.");
      }
    }
    return { cron: cron.trim(), timezone, untilDay: until };
  }

  /** The first time of the rule after `ms`: due, skipped or paused alike. */
  private firstAfter(row: Pick<CalendarEntryRow, "atMs" | "cron" | "timezone" | "untilDay">, ms: number): number | null {
    if (row.cron === null) return row.atMs !== null && row.atMs > ms ? row.atMs : null;
    return dueTimesAfterMs(ruleOf(row), ms, 1)[0] ?? null;
  }

  private dayTimes(row: CalendarEntryRow, day: string): number[] {
    if (!isDay(day)) throw new CalendarRefusal("Give days as YYYY-MM-DD.");
    // Only times still ahead: one passed was delivered, missed or recorded already.
    const now = this.now();
    const times = dueTimesBetween(ruleOf(row), dayStart(day, row.timezone), dayStart(nextDay(day), row.timezone)).filter((t) => t > now);
    if (times.length === 0) throw new CalendarRefusal("That day is not one of its due days.");
    return times;
  }

  private addSkips(row: CalendarEntryRow, times: number[]): number[] {
    return [...new Set([...row.skips, ...times])].sort((a, b) => a - b);
  }

  /** The next time it will be delivered: skipped times passed over; none while paused. */
  private nextDelivery(row: CalendarEntryRow): number | null {
    if (row.pausedAt !== null || row.nextDueMs === null) return null;
    if (row.cron === null) return row.nextDueMs;
    // One more time than there are skips ahead finds the next; the skips
    // behind it, kept for good, are not looked at.
    const from = row.nextDueMs;
    const ahead = new Set(row.skips.filter((t) => t >= from));
    return dueTimesAfterMs(ruleOf(row), from - 1, ahead.size + 1).find((t) => !ahead.has(t)) ?? null;
  }

  private dto(row: CalendarEntryRow): CalendarEntryDto {
    return {
      id: row.id,
      title: row.title,
      note: row.note,
      once: row.cron === null && row.atMs !== null ? { at: row.atMs } : null,
      repeat: row.cron !== null ? { cron: row.cron, timezone: row.timezone, until: row.untilDay, words: repeatWords(row.cron) } : null,
      paused: row.pausedAt !== null ? { by: row.pausedBy ?? "user", at: row.pausedAt } : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      next: this.nextDelivery(row),
      ahead: row.nextDueMs !== null
    };
  }

  private timeDto(row: CalendarEntryRow, t: CalendarTimeRow): CalendarTimeDto {
    return { entryId: row.id, title: row.title, at: t.dueMs, outcome: t.outcome, deliveredAt: t.deliveredMs, repeating: row.cron !== null };
  }
}
