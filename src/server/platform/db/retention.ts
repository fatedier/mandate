import type { Database } from "bun:sqlite";
import type { RetentionConfig } from "../../config/types.js";
import { TRUNCATION_MARKER_PREFIX, truncateToolResultContent } from "./tool-result-truncate.js";
import { NOT_IDLE_SUMMARY } from "./activity-sql.js";
import { directChanges } from "./direct-changes.js";
import { MODEL_ONLY_SOURCES_SQL } from "../../../shared/agent-message-types.js";

/** Rows one pass may touch, per unit of work. bun:sqlite is synchronous, so every
 *  row a pass writes is time the event loop is blocked, and both units of work here
 *  face an unbounded backlog: the runtime-context delete starts with every superseded
 *  row outstanding, and the llm_calls rewrite accumulates behind a 90-day window that has
 *  not opened yet. One constant for both; the delete is the expensive side and sets
 *  the number.
 *
 *  What the cap buys is smaller than it looks, and it is not the working pass that
 *  costs. A pass with nothing left to delete still runs the `select distinct
 *  thread_id` and the per-thread marker probes that all come back with nothing to do.
 *  The FIRST pass, with a whole
 *  backlog outstanding, costs less, because the 200-row cap breaks the loop after one
 *  or two threads; the working passes then get slower as the backlog drains, since
 *  more threads have to be walked before the cap fills.
 *
 *  So the working pass is the cheap one and the idle pass is the expensive one -- and
 *  the idle pass is the one that runs every hour forever, once the backlog drains on
 *  day one. Size anything here against the idle work per hour, not against a figure
 *  extrapolated from a per-row delete cost: that describes a pass that only ever runs
 *  a handful of times. The point is not that the idle pass is dramatically dearer, it
 *  is that the idle pass is the one that keeps running.
 *
 *  A short-circuit that skips the thread walk when the previous pass deleted nothing
 *  is deliberately not taken yet: it needs an invalidation rule of its own -- new
 *  runtime-context rows arrive between passes -- and a few hundred ms an hour buys
 *  time to get that right. */
const RETENTION_MAX_ROWS_PER_TICK = 200;

/** How long a call's raw request payload, and the parts of its metadata no reader
 *  consumes, are kept. Everything else about the call -- model, token counts,
 *  latency, status, errors -- is kept forever, so historical analysis is
 *  unaffected. */
const LLM_PAYLOAD_RETENTION_DAYS = 90;

/** Mirrors runtimeContextKind() in the agent module's wake-runtime-context.ts: a
 *  runtime-context message is "initial" when its metadata says so.
 *
 *  json_valid() has to come first: json_extract() raises "malformed JSON" rather
 *  than returning null, so one unparseable row would abort the entire pass.
 *
 *  What keeps this no wider than runtimeContextKind() rests on an invariant held
 *  elsewhere: json_extract() returns the FIRST of a repeated key where JSON.parse()
 *  returns the last, so a content value carrying runtimeContextKind twice would read
 *  differently here. That is unreachable only because every agent_messages row comes
 *  from one writer, appendMessage() in agent-store.ts, which binds
 *  JSON.stringify(input.content). */
const IS_INITIAL_CONTEXT = `(
  json_valid(content)
  and coalesce(json_extract(content, '$.type'), '') = 'text'
  and json_extract(content, '$.metadata.runtimeContextKind') = 'initial'
)`;

export interface RetentionPassResult {
  runtimeContextDeleted: number;
  llmPayloadsCleared: number;
  toolResultsTruncated: number;
  replayStateCleared: number;
  mailboxDeleted: number;
  skipMarkersDeleted: number;
}

/** A tool result to shorten: its row and the content it gets. */
export interface ToolResultCut {
  id: string;
  content: string;
}

/** What one pass found to do. Finding it is the slow part (scans of the chat
 *  table, the calls past their window); doing it is a few hundred rows. The
 *  hourly pass finds it in a worker that only reads, and the server's own
 *  connection does it: one writer, so no transaction of the server's meets a
 *  write it did not make (see retention-away.ts). */
export interface RetentionWork {
  /** Superseded runtime context and plan reminders. */
  runtimeContextIds: string[];
  /** Calls past the payload window that still hold a payload. */
  llmPayloadIds: string[];
  toolResults: ToolResultCut[];
  /** Replies a compaction has passed that still hold their replay copy or
   *  their reasoning. */
  replayStateIds: string[];
  /** Rows nothing reads again (findBacklogs). */
  mailboxIds: string[];
  skipMarkerIds: string[];
}

/** Finds a pass's work, reading only. */
export function findRetentionWork(
  db: Database,
  now: Date,
  retention: RetentionConfig
): RetentionWork {
  const cutoff = new Date(now.getTime() - retention.chatRetentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const overCeiling = isOverCeiling(db, retention.chatMaxTableBytes, now.getTime());
  return {
    runtimeContextIds: findSupersededRuntimeContext(db),
    llmPayloadIds: findOldLlmPayloads(db, now),
    // The idle gate. Over the ceiling the age gate is dropped and there is by
    // definition work, so the probe is skipped; otherwise it answers whether the
    // candidate query could return anything at all, for about a millisecond against
    // the hundreds that query costs -- an hourly bill that never stops, since
    // "nothing to do" is the steady state this reaches on day one.
    toolResults: overCeiling
      || hasAgeEligibleRow(db, cutoffIso, retention.chatToolResultHeadChars)
      ? findToolResultCuts(db, {
        headChars: retention.chatToolResultHeadChars,
        cutoffIso,
        maxRows: RETENTION_MAX_ROWS_PER_TICK,
        overCeiling
      })
      : [],
    replayStateIds: findCompactedReplayState(db),
    ...findBacklogs(db, now)
  };
}

/** Does what findRetentionWork found, in one short write. Each part asks again
 *  of each row as it writes it, so work found a while ago changes only what
 *  it still applies to (a row deleted meanwhile, a result shortened by the
 *  manual cleanup). */
export function applyRetentionWork(db: Database, work: RetentionWork, now: Date = new Date()): RetentionPassResult {
  return db.transaction(() => ({
    runtimeContextDeleted: deleteMessages(db, work.runtimeContextIds),
    llmPayloadsCleared: clearLlmPayloads(db, work.llmPayloadIds, now),
    toolResultsTruncated: applyToolResultCuts(db, work.toolResults),
    replayStateCleared: clearReplayState(db, work.replayStateIds),
    ...clearBacklogs(db, work, now)
  })).immediate();
}

/** Rows of each backlog one pass removes: a few milliseconds of the server's
 *  thread, and a backlog of years drains over days. */
const BACKLOG_ROWS_PER_TICK = 2_000;
/** Delivered mail is kept this long: its message is in the conversation from
 *  the moment it is delivered, and only that moment's wake reads it back. */
const MAILBOX_KEEP_DAYS = 7;
/** ...or a later turn that carries on from that one, when it failed or got
 *  stuck: a retry, or a turn resumed after a restart, forwards its reply to
 *  whoever sent the mail (worker-message-relay.ts). Mail of a turn that
 *  finished, or was stopped (its recovery is dropped), or is gone, can go. */
const MAIL_TURN_ENDED = (alias: string) =>
  `not exists (select 1 from agent_wakes w where w.id = ${alias}.wake_id and w.status not in ('finished', 'canceled'))`;
/** The history index's backfill mark (history-store.ts): a backfill looks
 *  only at messages above it, so a skip marker at or below it is not read
 *  again. Named here as the trigger that lowers it names it. */
const BACKFILL_MARK_KEY = "backfill_checked_rowid";

/** Rows nothing reads again: mail delivered a week ago, and skip markers
 *  below the backfill's mark or for a message gone. None while there is no mark: then a backfill
 *  looks at every message, markers and all. */
function findBacklogs(db: Database, now: Date): Pick<RetentionWork, "mailboxIds" | "skipMarkerIds"> {
  const ids = (sql: string, ...args: Array<string | number>) =>
    (db.prepare(sql).all(...args, BACKLOG_ROWS_PER_TICK) as Array<{ id: string }>).map((row) => row.id);
  const mark = backfillMark(db);
  return {
    mailboxIds: ids(`select id from agent_mailbox m where status = 'delivered' and delivered_at < ? and ${MAIL_TURN_ENDED("m")} limit ?`, mailboxCutoff(now)),
    skipMarkerIds: mark === null ? [] : ids(`
      select s.message_id as id from agent_message_search_skipped s
      left join agent_messages m on m.id = s.message_id
      where m.id is null or m.rowid <= ?
      limit ?`, mark)
  };
}

/** Removes what findBacklogs found that still qualifies. */
function clearBacklogs(db: Database, work: RetentionWork, now: Date): Pick<RetentionPassResult, "mailboxDeleted" | "skipMarkersDeleted"> {
  const remove = (ids: readonly string[], sql: string, ...args: Array<string | number>) => {
    if (ids.length === 0) return 0;
    db.prepare(sql).run(JSON.stringify(ids), ...args);
    return directChanges(db);
  };
  const mark = backfillMark(db);
  return {
    mailboxDeleted: remove(work.mailboxIds,
      `delete from agent_mailbox where id in (select value from json_each(?)) and status = 'delivered' and delivered_at < ? and ${MAIL_TURN_ENDED("agent_mailbox")}`, mailboxCutoff(now)),
    skipMarkersDeleted: mark === null ? 0 : remove(work.skipMarkerIds, `
      delete from agent_message_search_skipped
       where message_id in (select value from json_each(?))
         and coalesce((select m.rowid from agent_messages m where m.id = message_id), 0) <= ?`, mark)
  };
}

function backfillMark(db: Database): number | null {
  const row = db.prepare("select value from agent_message_search_words_state where key = ?").get(BACKFILL_MARK_KEY) as { value: string } | null;
  const mark = Number(row?.value);
  return row && Number.isFinite(mark) ? mark : null;
}

function mailboxCutoff(now: Date): string {
  return new Date(now.getTime() - MAILBOX_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Rows of the compacted-reply unit one pass may rewrite. Larger than the
 *  other units' cap: each write only drops two keys from a row, and a day of
 *  compactions passes a few thousand replies. */
const REPLAY_STATE_ROWS_PER_TICK = 1000;

/** A reply carries what the model sent (its reasoning, sealed, and its calls)
 *  to send back to that model on the next step (`sdkAssistantMessages`), and
 *  its reasoning as text, which nothing shows. Once a compaction has passed
 *  the reply, neither is read again: a prompt holds the latest summary, the
 *  user turns it keeps by id, and what came after it. A compaction is never
 *  undone, so passed stays passed. What the chat shows (the text and the
 *  calls) stays.
 *
 *  The key test is exact (json_type), behind a cheap text prefilter: a call
 *  whose own arguments hold a "reasoning" key passes the prefilter but is not
 *  selected, so it never takes a slot in every pass (the convergence trap
 *  REDUCED_MARKER_KEY describes). json_type raises on text that is not JSON,
 *  so CASE keeps it from being reached. */
const HOLDS_REPLAY_STATE = (alias: string) => `(
  (instr(${alias}.content, '"sdkAssistantMessages"') > 0 or instr(${alias}.content, '"reasoning"') > 0)
  and case when json_valid(${alias}.content)
    then json_type(${alias}.content, '$.sdkAssistantMessages') is not null or json_type(${alias}.content, '$.reasoning') is not null
    else 0 end
)`;

function findCompactedReplayState(db: Database): string[] {
  return (db.prepare(`
    with last as (
      select thread_id, max(seq) s from agent_messages where source = 'compression' group by thread_id
    )
    select m.id from last l
    join agent_messages m on m.thread_id = l.thread_id and m.seq < l.s
    where m.role = 'assistant' and ${HOLDS_REPLAY_STATE("m")}
    limit ?
  `).all(REPLAY_STATE_ROWS_PER_TICK) as Array<{ id: string }>).map((row) => row.id);
}

function clearReplayState(db: Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  db.prepare(`
    update agent_messages as m
    set content = json_remove(m.content, '$.sdkAssistantMessages', '$.reasoning')
    where m.id in (select value from json_each(?)) and m.role = 'assistant' and ${HOLDS_REPLAY_STATE("m")}
  `).run(JSON.stringify(ids));
  return directChanges(db);
}

/** Does the age trigger have anything to do? Asked before the candidate query so
 *  that a pass with no work skips it entirely.
 *
 *  It has to ask the sharper question -- "an expired thread holding a row this
 *  pass can shorten" -- and not merely "an expired thread". Threads expire
 *  permanently, so the moment one does, a gate asking only about expiry is open
 *  forever and saves nothing from then on. A database can hold expired
 *  threads with no shortenable rows in them, and then the weaker gate
 *  would open on every pass and pay the full query anyway.
 *
 *  What keeps it a probe rather than a second copy of the query is that nothing
 *  is scanned table-wide. The thread list comes from agent_threads (one row per
 *  thread, against many messages each); each thread's last activity is the tip of
 *  the (thread_id, seq) index rather than a max(created_at) over its rows; and
 *  the exists() walks one thread through the same index, stopping at the first
 *  hit, so it answers "no work" far faster than the query it replaces. Written instead as `max(m.created_at)` per thread it costs
 *  as much as that query -- max() over a column with no index reads every row of
 *  every thread, where the index tip reads one.
 *
 *  Its worst case is a large expired thread with no shortenable rows, which is
 *  walked in full before the answer is "no". That is bounded by the size of the
 *  expired threads, i.e. by what the query being skipped would have scanned
 *  anyway, so the gate cannot make a pass dearer than not having it.
 *
 *  Reading the seq tip instead of max(created_at) is exact here, not an
 *  approximation: appendMessage() in agent-store.ts assigns seq as max(seq) + 1
 *  and created_at as the same moment, so within a thread the two orders agree.
 *
 *  Where it is inexact it fails safe, and the candidate predicate is shared rather
 *  than restated so the two cannot drift into disagreeing. A thread whose messages
 *  outlive its agent_threads row would not be probed (there is no such path today:
 *  nothing in src/server deletes from agent_threads), and an explicit `input.seq` could in principle
 *  put the tip out of time order. Either way the gate answers "no work" for a
 *  thread that has some, and those rows are kept rather than shortened -- the same
 *  direction every other predicate in this file errs in. The ceiling trigger is the
 *  backstop: it ignores age entirely, so growth stays bounded even if this gate
 *  never opens. */
function hasAgeEligibleRow(db: Database, cutoffIso: string, headChars: number): boolean {
  const row = db.prepare(`
    select 1 from agent_threads t
    where (
      select created_at from agent_messages m
      -- An idle compaction's summary is not activity: the walk steps past it.
      where m.thread_id = t.id and ${NOT_IDLE_SUMMARY} order by m.seq desc limit 1
    ) < ?
      and exists (
        select 1 from agent_messages c
        where c.thread_id = t.id
          and c.role = 'tool'
          and length(c.content) > ?
          and ${toolResultNeedsTruncation("c")}
      )
    limit 1
  `).get(cutoffIso, headChars, headChars);
  return row !== null;
}

/** Every wake already hides these: modelVisibleContextMessages keeps only the last
 *  `initial` runtime-context message and the updates after it, so anything an
 *  `initial` has overtaken is never shown to a model again. They are also excluded
 *  from the history search index. Deleting them changes nothing any agent can see;
 *  the rule is the one the prompt path already applies. */
function findSupersededRuntimeContext(db: Database): string[] {
  const threads = db.prepare(
    "select distinct thread_id from agent_messages where source = 'runtime-context'"
  ).all() as Array<{ thread_id: string }>;

  // Walk each thread backwards and stop at its first `initial`. Written this way
  // rather than as one CTE over every runtime-context row because the index on
  // (thread_id, seq) turns it into a few reads per thread: several times
  // cheaper than the scan, which also grows with the table.
  const latestInitial = db.prepare(`
    select seq from agent_messages
    where thread_id = ? and source = 'runtime-context' and ${IS_INITIAL_CONTEXT}
    order by seq desc limit 1
  `);
  // Plan reminders are model-only nudges too: hidden from the user, left out
  // of compaction, never shown to a model again once a compaction's initial
  // context has overtaken them.
  const before = db.prepare(`
    select id from agent_messages
    where thread_id = ? and source in (${MODEL_ONLY_SOURCES_SQL}) and seq < ?
    order by seq limit ?
  `);

  const ids: string[] = [];
  for (const { thread_id: threadId } of threads) {
    if (ids.length >= RETENTION_MAX_ROWS_PER_TICK) break;
    const marker = latestInitial.get(threadId) as { seq: number } | null;
    if (!marker) continue;
    const budget = RETENTION_MAX_ROWS_PER_TICK - ids.length;
    for (const row of before.all(threadId, marker.seq, budget) as Array<{ id: string }>) ids.push(row.id);
  }
  return ids;
}

/** Superseded stays superseded (a later initial only overtakes more), so the
 *  ids are deleted as found; one gone meanwhile is simply not counted. */
function deleteMessages(db: Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  db.prepare("delete from agent_messages where id in (select value from json_each(?))").run(JSON.stringify(ids));
  return directChanges(db);
}

/** Written as the first key of every metadata object this pass has reduced, and set
 *  to the version of the key set below. Two jobs.
 *
 *  It is how a pass tells "already reduced" from "not yet". `metadata_json is not
 *  null` cannot say that any more -- the column stays non-null now -- and without a
 *  usable answer every pass would rewrite the same 200 rows forever and never reach
 *  the ones behind them. Writing it first makes the check `substr()` over the opening
 *  bytes of the column: no json parsing per row, which matters because that check
 *  runs against every row past the window on every idle pass, forever. With every
 *  row of a large table past the window and already reduced, it adds tens of ms to an
 *  idle pass; written as `json_extract(metadata_json, '$._retention') is null` the
 *  same question would re-parse every one of those documents, hourly, forever.
 *
 *  The version is what lets the rule below change later. Bumping it makes rows
 *  reduced under the old rule stop matching, so they are reduced again, once. A wrong
 *  answer here fails safe in the direction that matters: a row mistaken for already
 *  reduced keeps its bytes, it does not lose them. Version 1 first kept a list of
 *  keys and dropped the rest; it now drops the stream statistics and keeps the rest.
 *  Rows reduced under the list are not reduced again: what it dropped is gone, and
 *  a second pass would only rewrite them. */
const REDUCED_MARKER_KEY = "_retention";
const REDUCED_MARKER_VERSION = 1;
const REDUCED_PREFIX = `{"${REDUCED_MARKER_KEY}":${REDUCED_MARKER_VERSION}`;

/** The reduced metadata object: the marker, then every key but the stream statistics.
 *
 *  metadata_json cannot be nulled the way request_json can: Activity reads it for
 *  as long as the row lives (a call's phase, provider name, wake and
 *  role, a judgement's answer), and agent-compression-controller.ts reads
 *  `promptMaxSeq` off a thread's newest step to size its next prompt. What grows is
 *  `stream`, the per-call streaming statistics nothing reads outside the raw-JSON
 *  section of the detail panel: most of the column's bytes. Dropping only it gives back nearly all the space
 *  a list of kept keys did, and a key written later is kept without anyone having
 *  to add it here -- under a list, one nobody added was lost at 90 days.
 *
 *  json_patch() over the marker puts the marker first (the check below reads the
 *  opening bytes). Merge-patch drops a key whose value is null, which reads as the
 *  key absent; arrays are copied through untouched. */
const REDUCED_METADATA = `json_patch('{"${REDUCED_MARKER_KEY}":${REDUCED_MARKER_VERSION}}',
  json_remove(metadata_json, '$.stream'))`;

/** Metadata the reduction can read: a JSON object. json_valid() is asked inside
 *  a CASE because json_type() *raises* on text that is not JSON, and CASE is what
 *  keeps it from being reached (an `and` does not, see llm-call-rows.ts). */
const METADATA_IS_OBJECT = `json_type(case when json_valid(metadata_json) then metadata_json end) = 'object'`;

/** A reduced object is `{"_retention":1}` or `{"_retention":1,...`, so one substr()
 *  covers both and nothing else can be confused for either: no writer of this column
 *  emits a `_retention` key.
 *
 *  Being an object has to be part of the question and not just of the rewrite. A row
 *  whose metadata is not a readable JSON object is left as it is, so it can never come
 *  to match the prefix -- select it and it takes one of the 200 slots in this pass, and
 *  in every pass after it, and the rows behind it are never reached. It is asked
 *  second because substr() answers for every already-reduced row without parsing
 *  anything, which is the whole cost of an idle pass once the backlog is gone. */
const METADATA_NEEDS_REDUCTION = `(
  metadata_json is not null
  and substr(metadata_json, 1, ${REDUCED_PREFIX.length + 1})
      not in ('${REDUCED_PREFIX},', '${REDUCED_PREFIX}}')
  and ${METADATA_IS_OBJECT}
)`;

/** Drops the raw request payload and the stream statistics from the metadata of
 *  calls past the retention window. The row stays, so every count and timing stays
 *  queryable, and the Activity page still renders what it did before the window
 *  closed; what is lost is the ability to replay one specific request verbatim, and
 *  the streaming statistics in the raw-JSON view of the call.
 *
 *  The object test guards the rewrite rather than the row: a row whose metadata is
 *  not a readable JSON object keeps it, because the rewrite would have nothing to
 *  remove from it, but its request payload is still dropped. CASE evaluates one
 *  branch, so the test protects json_remove() from raising on that row and aborting
 *  the pass.
 *
 *  Capped for the same reason the delete is: this statement is synchronous, and the
 *  backlog it drains is whatever accumulated while the 90-day window was closed. */
function findOldLlmPayloads(db: Database, now: Date): string[] {
  const cutoff = payloadCutoff(now);
  return (db.prepare(`
    select id from llm_calls
    where created_at < ?
      and (request_json is not null or ${METADATA_NEEDS_REDUCTION})
    limit ?
  `).all(cutoff, RETENTION_MAX_ROWS_PER_TICK) as Array<{ id: string }>).map((row) => row.id);
}

/** The rewrite, asked again of each row: one already reduced (by an earlier
 *  write) is left as it is. */
function clearLlmPayloads(db: Database, ids: string[], now: Date): number {
  if (ids.length === 0) return 0;
  return db.prepare(`
    update llm_calls
    set request_json = null,
        metadata_json = case
          when ${METADATA_IS_OBJECT} then ${REDUCED_METADATA}
          else metadata_json
        end
    where id in (select value from json_each(?))
      and created_at < ?
      and (request_json is not null or ${METADATA_NEEDS_REDUCTION})
  `).run(JSON.stringify(ids), payloadCutoff(now)).changes;
}

function payloadCutoff(now: Date): string {
  return new Date(now.getTime() - LLM_PAYLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Measuring the table costs a full scan -- on a large database, more
 *  than the whole idle pass otherwise costs. That pass runs
 *  every hour forever, so paying it every tick would nearly triple the cost of
 *  the case that never stops running.
 *
 *  A day adds little to the table, so a 1 GB ceiling cannot be crossed and
 *  missed inside a day. The age trigger is gated too, but per pass rather
 *  than per day, because hasAgeEligibleRow() answers in about 1 ms.
 *
 *  Keyed by Database rather than a single pair of module-level variables:
 *  production only ever runs one Database per process (createAppStores()
 *  builds exactly one MandateStore), so a shared cache is harmless there, but
 *  the test suite opens many `:memory:` databases in one process, and a
 *  shared cache would let one test's ceiling reading leak into another's. A
 *  WeakMap also means a closed test database's entry is collectable rather
 *  than accumulating for the life of the process. */
const CEILING_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** When the table was last measured, and its size then. The size, not
 *  whether it was over: the limit can change in Settings between measures,
 *  and each pass weighs the day's size against the limit it is given. */
export interface CeilingReading {
  checkedAtMs: number;
  bytes: number;
}
const ceilingCache = new WeakMap<Database, CeilingReading>();

/** The reading this connection holds, to carry to the next pass's connection
 *  (each pass runs in a worker of its own: see retention-away.ts). */
export function ceilingReading(db: Database): CeilingReading | null {
  return ceilingCache.get(db) ?? null;
}

/** A reading an earlier connection took, for this one to go on from. */
export function rememberCeilingReading(db: Database, reading: CeilingReading): void {
  ceilingCache.set(db, reading);
}

function isOverCeiling(db: Database, maxBytes: number, nowMs: number): boolean {
  const cached = ceilingCache.get(db);
  if (cached && nowMs - cached.checkedAtMs < CEILING_CHECK_INTERVAL_MS) return cached.bytes > maxBytes;
  const row = db.prepare("select coalesce(sum(length(content)), 0) b from agent_messages")
    .get() as { b: number };
  ceilingCache.set(db, { checkedAtMs: nowMs, bytes: row.b });
  return row.b > maxBytes;
}

/** Rows this pass can still shorten -- every stable reason
 *  truncateToolResultContent() would refuse a row, restated in SQL. Takes the
 *  table alias because hasAgeEligibleRow() asks the same question of a different
 *  one, and a gate that disagreed with the query it guards would either skip real
 *  work or wave through a pass that finds nothing.
 *
 *  This is not an optimisation, it is the convergence condition, and it is the
 *  same trap REDUCED_MARKER_KEY above documents for llm_calls: a row the query
 *  selects and the JS then refuses consumes one of the 200 slots in this pass and
 *  in every pass after it, and the rows behind it are never reached. The whole
 *  unit makes progress exactly once and then stalls forever.
 *
 *  With only the marker term added and the rest of the predicate left as
 *  `length(content) > headChars`, a whole tick of 200 rows can be ones the JS will
 *  not rewrite: a non-string result, or a string already shorter than the head
 *  inside an envelope longer than it. Every one of those stalls the pass, so each
 *  term below earns its place:
 *
 *    instr(...) = 0          - not already shortened by an earlier pass. The
 *                              marker's text is fixed, so this needs no json
 *                              parsing. A shortened row (the head and the marker)
 *                              is still over the threshold: without this term it
 *                              would be rewritten again and stall the pass.
 *    json_valid(...)         - must come FIRST of the json terms: json_extract()
 *                              and friends raise "malformed JSON" rather than
 *                              returning null, and one unparseable row would abort
 *                              the whole pass. Same reason IS_INITIAL_CONTEXT
 *                              orders its terms the way it does.
 *    $.type = 'tool_result'  - `role = 'tool'` stays as the cheap first cut;
 *                              this makes its agreement with this term a property of the query
 *                              rather than a coincidence a second writer could end.
 *    json_type(...) = 'text' - the result is a JSON string. An object result is
 *                              the common case and is deliberately never
 *                              shortened.
 *    length(->> ...) > ?     - the STRING is longer than the head. `length(content)`
 *                              alone measures the JSON envelope too, which is why
 *                              some rows would otherwise be selected forever.
 *
 *  Two deliberate asymmetries with the JS guard, both of which must stay:
 *
 *  instr() matches the marker anywhere in `content`, while TRUNCATION_MARKER_RE
 *  anchors it at the end of `result`. SQL is therefore the more conservative of
 *  the two. That is not an inconsistency to repair -- SQL only ever narrows the
 *  candidate set and truncateToolResultContent() remains the authority on what is
 *  written, so a row wrongly excluded here is merely left alone, while widening
 *  SQL to match the anchor would let a row the JS refuses back in to stall the
 *  pass. The same holds for length(): SQLite counts characters where JS counts
 *  UTF-16 code units, so SQL's length is never the larger of the two and a row it
 *  admits is one the JS agrees is over the head. */
const toolResultNeedsTruncation = (alias: string) => `(
  instr(${alias}.content, '${TRUNCATION_MARKER_PREFIX}') = 0
  and json_valid(${alias}.content)
  and json_extract(${alias}.content, '$.type') = 'tool_result'
  and json_type(${alias}.content, '$.result') = 'text'
  and length(${alias}.content ->> '$.result') > ?
)`;

/** Exported so the manual cleanup route runs exactly this rule, ungated by age and
 *  chunked rather than capped at one tick.
 *
 *  The `m.role = 'tool'` filter is a cheap prefilter that avoids parsing JSON for
 *  every row in the table -- the parse then happens only for rows this already
 *  narrowed to. The predicate below does not depend on `role = 'tool'` and
 *  `json_extract(content,'$.type') = 'tool_result'` selecting the same rows. */
export function truncateChatToolResults(
  db: Database,
  opts: { headChars: number; cutoffIso: string; maxRows: number; overCeiling: boolean }
): number {
  return applyToolResultCuts(db, findToolResultCuts(db, opts));
}

/** The rows truncateChatToolResults would shorten and what each becomes, read only. */
export function findToolResultCuts(
  db: Database,
  opts: { headChars: number; cutoffIso: string; maxRows: number; overCeiling: boolean }
): ToolResultCut[] {
  // Over the ceiling the age gate is dropped and the oldest threads go first;
  // otherwise only threads that have been silent past the cutoff are eligible.
  // Ordering by the thread's last activity in both branches keeps one query.
  const rows = db.prepare(`
    with last as (select thread_id, max(created_at) la from agent_messages where ${NOT_IDLE_SUMMARY} group by thread_id)
    select m.id, m.content
    from agent_messages m
    join last l on l.thread_id = m.thread_id
    where m.role = 'tool'
      and (? or l.la < ?)
      and length(m.content) > ?
      and ${toolResultNeedsTruncation("m")}
    order by l.la asc
    limit ?
  `).all(
    opts.overCeiling ? 1 : 0, opts.cutoffIso, opts.headChars, opts.headChars, opts.maxRows
  ) as Array<{ id: string; content: string }>;

  const cuts: ToolResultCut[] = [];
  for (const row of rows) {
    const next = truncateToolResultContent(row.content, opts.headChars);
    if (next) cuts.push({ id: row.id, content: next });
  }
  return cuts;
}

/** Writes the shortened results; a row shortened meanwhile (it carries the
 *  marker) is left as it is. */
function applyToolResultCuts(db: Database, cuts: ToolResultCut[]): number {
  const update = db.prepare(`update agent_messages set content = ? where id = ? and instr(content, '${TRUNCATION_MARKER_PREFIX}') = 0`);
  let changed = 0;
  for (const cut of cuts) {
    update.run(cut.content, cut.id);
    changed += directChanges(db);
  }
  return changed;
}
