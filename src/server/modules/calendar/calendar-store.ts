import type { Database } from "bun:sqlite";
import type { CalendarActor, CalendarOutcome } from "../../../shared/api/calendar.js";

export interface CalendarEntryRow {
  id: string;
  title: string;
  note: string;
  /** Once: when; null for a repeat. */
  atMs: number | null;
  /** A repeat: its 5-field cron; null for once. */
  cron: string | null;
  timezone: string;
  untilDay: string | null;
  pausedAt: number | null;
  pausedBy: CalendarActor | null;
  /** Due times of the repeat that are not delivered. */
  skips: number[];
  /** The next time to look at it: due, skipped or paused; null when it has none. */
  nextDueMs: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  deletedBy: CalendarActor | null;
}

export interface CalendarTimeRow {
  entryId: string;
  dueMs: number;
  outcome: Exclude<CalendarOutcome, "due">;
  deliveredMs: number | null;
  recordedAt: number;
}

export type CalendarChangeKind = "pause" | "resume" | "skip" | "delete";

export interface CalendarChangeRow {
  entryId: string;
  kind: CalendarChangeKind;
  by: CalendarActor;
  at: number;
  dueMs: number | null;
}

const COLUMNS: Record<Exclude<keyof CalendarEntryRow, "skips">, string> = {
  id: "id", title: "title", note: "note", atMs: "at_ms", cron: "cron", timezone: "timezone", untilDay: "until_day",
  pausedAt: "paused_at", pausedBy: "paused_by", nextDueMs: "next_due_ms", createdAt: "created_at", updatedAt: "updated_at",
  deletedAt: "deleted_at", deletedBy: "deleted_by"
};

const SELECT = `select ${Object.entries(COLUMNS).map(([key, column]) => `${column} as ${key}`).join(", ")}, skips_json as skipsJson from calendar_entries`;

type RawEntry = Omit<CalendarEntryRow, "skips"> & { skipsJson: string };

function fromRaw(raw: RawEntry): CalendarEntryRow {
  const { skipsJson, ...rest } = raw;
  const parsed: unknown = JSON.parse(skipsJson);
  return { ...rest, skips: Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [] };
}

/** Moves rows: no rules, no events (the service has both). */
export class CalendarStore {
  constructor(readonly db: Database) {}

  insert(row: CalendarEntryRow): void {
    const keys = Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>;
    this.db.prepare(
      `insert into calendar_entries (${keys.map((key) => COLUMNS[key]).join(", ")}, skips_json) values (${keys.map(() => "?").join(", ")}, ?)`
    ).run(...keys.map((key) => row[key]), JSON.stringify(row.skips));
  }

  update(id: string, patch: Partial<Omit<CalendarEntryRow, "id">>): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch) as Array<[keyof CalendarEntryRow, unknown]>) {
      if (key === "skips") {
        sets.push("skips_json = ?");
        values.push(JSON.stringify(value));
      } else if (key !== "id") {
        sets.push(`${COLUMNS[key]} = ?`);
        values.push(value as string | number | null);
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`update calendar_entries set ${sets.join(", ")} where id = ?`).run(...values, id);
  }

  get(id: string): CalendarEntryRow | null {
    const raw = this.db.prepare(`${SELECT} where id = ?`).get(id) as RawEntry | null;
    return raw ? fromRaw(raw) : null;
  }

  /** Not deleted, oldest first. */
  live(): CalendarEntryRow[] {
    return (this.db.prepare(`${SELECT} where deleted_at is null order by created_at, rowid`).all() as RawEntry[]).map(fromRaw);
  }

  soonestDue(): number | null {
    const row = this.db.prepare("select min(next_due_ms) as soonest from calendar_entries where deleted_at is null and next_due_ms is not null").get() as { soonest: number | null };
    return row.soonest;
  }

  /** Live entries whose next time is at or before `ms`. */
  dueBy(ms: number): CalendarEntryRow[] {
    return (this.db.prepare(`${SELECT} where deleted_at is null and next_due_ms is not null and next_due_ms <= ? order by next_due_ms, rowid`).all(ms) as RawEntry[]).map(fromRaw);
  }

  addTime(row: CalendarTimeRow): void {
    this.db.prepare("insert into calendar_times (entry_id, due_ms, outcome, delivered_ms, recorded_at) values (?, ?, ?, ?, ?)")
      .run(row.entryId, row.dueMs, row.outcome, row.deliveredMs, row.recordedAt);
  }

  /** The due times of the entry already recorded from `fromMs` on. */
  recordedFrom(entryId: string, fromMs: number): Set<number> {
    const rows = this.db.prepare("select due_ms as dueMs from calendar_times where entry_id = ? and due_ms >= ?").all(entryId, fromMs) as Array<{ dueMs: number }>;
    return new Set(rows.map((row) => row.dueMs));
  }

  hasTime(entryId: string, dueMs: number): boolean {
    return this.db.prepare("select 1 from calendar_times where entry_id = ? and due_ms = ?").get(entryId, dueMs) !== null;
  }

  /** Recorded times of live entries from `fromMs` (inclusive) to `toMs` (exclusive), in time order. */
  timesBetween(fromMs: number, toMs: number): Array<CalendarTimeRow & { title: string; repeating: boolean }> {
    return (this.db.prepare(
      `select t.entry_id as entryId, t.due_ms as dueMs, t.outcome as outcome, t.delivered_ms as deliveredMs, t.recorded_at as recordedAt,
              e.title as title, e.cron is not null as repeating
         from calendar_times t join calendar_entries e on e.id = t.entry_id
        where e.deleted_at is null and t.due_ms >= ? and t.due_ms < ?
        order by t.due_ms, t.id`
    ).all(fromMs, toMs) as Array<CalendarTimeRow & { title: string; repeating: number }>).map((row) => ({ ...row, repeating: Boolean(row.repeating) }));
  }

  /** An entry's last recorded times, newest first. */
  recentTimes(entryId: string, limit: number): CalendarTimeRow[] {
    return this.db.prepare(
      `select entry_id as entryId, due_ms as dueMs, outcome, delivered_ms as deliveredMs, recorded_at as recordedAt
         from calendar_times where entry_id = ? order by due_ms desc, id desc limit ?`
    ).all(entryId, limit) as CalendarTimeRow[];
  }

  /** How many of an entry's times were recorded missed with the one recorded
   *  at `recordedAt`: the earlier times a late delivery stood for. */
  missedWith(entryId: string, recordedAt: number): number {
    return (this.db.prepare("select count(*) as n from calendar_times where entry_id = ? and recorded_at = ? and outcome = 'missed'")
      .get(entryId, recordedAt) as { n: number }).n;
  }

  addChange(row: CalendarChangeRow): void {
    this.db.prepare("insert into calendar_changes (entry_id, kind, by, at, due_ms) values (?, ?, ?, ?, ?)")
      .run(row.entryId, row.kind, row.by, row.at, row.dueMs);
  }

  /** What the user changed since `ms`, newest first, with the entry's title. */
  userChangesSince(ms: number): Array<CalendarChangeRow & { title: string }> {
    return this.db.prepare(
      `select c.entry_id as entryId, c.kind as kind, c.by as by, c.at as at, c.due_ms as dueMs, e.title as title
         from calendar_changes c join calendar_entries e on e.id = c.entry_id
        where c.by = 'user' and c.at >= ? order by c.at desc, c.id desc`
    ).all(ms) as Array<CalendarChangeRow & { title: string }>;
  }
}
