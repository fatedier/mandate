import type { Database } from "bun:sqlite";
import { ANSWER_COLUMNS, metaSql } from "./window-calls.js";

/**
 * Where the Overview's kept slices live, and what tells a kept slice it is
 * out of date.
 *
 * A slice is one hour of UTC, named by the first 13 characters of a call's
 * `created_at` (`2026-03-04T05`): a trigger reads it with no date
 * arithmetic, and it sorts as time does.
 *
 * `activity_rollup_state.seq` counts every change to a stored call that the
 * answer reads; `activity_slice_changes` holds, per slice, the count at the
 * last change to one of its calls. A kept slice records the count it was
 * built at, and is trusted only while no change at or before it is newer
 * (slice-plan.ts). The triggers are the whole of it: whichever code writes a
 * call, now or later, the change is counted.
 */

/** The slice a call created at `createdAt` belongs to. */
export const sliceOf = (createdAt: string): string => createdAt.slice(0, 13);

/** The instant a slice starts. */
export function sliceStartMs(slice: string): number {
  return Date.parse(`${slice}:00:00.000Z`);
}

const TRIGGER_PREFIX = "activity_slice_";

/**
 * Counts one change, and writes the count to the slice `start` names (an SQL
 * expression). Deleted, then inserted: a statement on `llm_calls` with a
 * conflict clause of its own (`or ignore`, an upsert) imposes it on the
 * statements its triggers run, so a mark written with one (`insert or
 * replace`) was skipped or failed under them. Neither statement here can
 * conflict.
 */
const markAt = (start: string) => `
    update activity_rollup_state set seq = seq + 1 where id = 1;
    delete from activity_slice_changes where start = ${start};
    insert into activity_slice_changes (start, seq) values (${start}, (select seq from activity_rollup_state where id = 1));`;

/** The mark of the slice of `<row>.created_at`. */
const mark = (row: "new" | "old") => markAt(`substr(${row}.created_at, 1, 13)`);

/** The mark of the slice of the call stored under `id` (an SQL expression), there being one. */
const markCall = (id: string) => markAt(`(select substr(created_at, 1, 13) from llm_calls where id = ${id})`);

export function initializeActivitySliceSchema(db: Database): void {
  db.exec(`
    create table if not exists activity_slices (
      start text primary key,
      -- The change count of the snapshot the slice was worked out in.
      built_seq integer not null,
      -- What it was worked out with besides the calls: the layout of the kept
      -- facts, the price lists, the connections' price settings.
      inputs text not null,
      -- Spend and the calls that are spend: all a previous period reads.
      spend_micros integer not null,
      spend_calls integer not null,
      facts text not null,
      vals blob not null
    )
  `);
  db.exec("create table if not exists activity_slice_changes (start text primary key, seq integer not null) without rowid");
  // `checked`: the inputs and the build under which a month's answer from
  // the slices was last found to be the one from every call (checkedKey);
  // null while that check is owed.
  db.exec("create table if not exists activity_rollup_state (id integer primary key check (id = 1), seq integer not null, floor integer not null, checked text)");
  db.exec("insert or ignore into activity_rollup_state (id, seq, floor) values (1, 0, 0)");

  // Dropped and made again at every start: their text is always this
  // version's, whatever an older or newer one left.
  // In one write transaction: two processes starting on one data directory
  // at once each rebuild them whole, the second after the first (it waits on
  // the busy timeout), instead of dropping the first one's half-made set.
  db.transaction(() => {
    const old = db.prepare("select name from sqlite_master where type = 'trigger' and name like ? escape '\\'").all(`${TRIGGER_PREFIX.replace(/_/g, "\\_")}%`) as Array<{ name: string }>;
    for (const { name } of old) db.exec(`drop trigger "${name}"`);
    db.exec(`create trigger ${TRIGGER_PREFIX}call_insert after insert on llm_calls begin${mark("new")}
    end`);
    db.exec(`create trigger ${TRIGGER_PREFIX}call_delete after delete on llm_calls begin${mark("old")}
    end`);
    // A REPLACE removes the call it collides with without running the delete
    // trigger: the hour that call was in is counted before it goes. (An insert
    // ignored, or an upsert, counts it too, for nothing.)
    db.exec(`create trigger ${TRIGGER_PREFIX}call_replaced before insert on llm_calls
      when exists (select 1 from llm_calls where id = new.id) begin${markCall("new.id")}
    end`);
    // The same for an update that takes another call's id.
    db.exec(`create trigger ${TRIGGER_PREFIX}call_id_taken before update of id on llm_calls
      when new.id is not old.id and exists (select 1 from llm_calls where id = new.id) begin${markCall("new.id")}
    end`);
    // An update that names one of the columns the answer reads.
    db.exec(`create trigger ${TRIGGER_PREFIX}call_update after update of ${ANSWER_COLUMNS.join(", ")} on llm_calls begin${mark("new")}
    end`);
    // A call moved to another hour leaves the one it was in.
    db.exec(`create trigger ${TRIGGER_PREFIX}call_moved after update of created_at on llm_calls
      when substr(old.created_at, 1, 13) is not substr(new.created_at, 1, 13) begin${mark("old")}
    end`);
    // The metadata: only a change to a key the answer reads. Retention drops
    // the stream statistics from old calls by the thousand, and must not make
    // their slices look changed.
    db.exec(`create trigger ${TRIGGER_PREFIX}call_metadata after update of metadata_json on llm_calls
      when (${metaSql("old")}) is not (${metaSql("new")}) begin${mark("new")}
    end`);
  }).immediate();
}
