import type { Database } from "bun:sqlite";
import type { RetentionConfig } from "../../config/types.js";
import { TRUNCATION_MARKER_PREFIX, truncateToolResultContent } from "./tool-result-truncate.js";
import { NOT_IDLE_SUMMARY } from "./activity-sql.js";
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

/** Mirrors the values in config/defaults.ts, duplicated here so a test can call
 *  runRetentionPass() without constructing a whole Config. */
const DEFAULT_RETENTION: RetentionConfig = {
  chatRetentionDays: 90,
  chatMaxTableBytes: 512 * 1024 * 1024,
  chatToolResultHeadChars: 2000
};

export function runRetentionPass(
  db: Database,
  now: Date = new Date(),
  retention: RetentionConfig = DEFAULT_RETENTION
): { runtimeContextDeleted: number; llmPayloadsCleared: number; toolResultsTruncated: number } {
  const cutoff = new Date(now.getTime() - retention.chatRetentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const overCeiling = isOverCeiling(db, retention.chatMaxTableBytes, now.getTime());
  return {
    runtimeContextDeleted: deleteSupersededRuntimeContext(db),
    llmPayloadsCleared: clearOldLlmPayloads(db, now),
    // The idle gate. Over the ceiling the age gate is dropped and there is by
    // definition work, so the probe is skipped; otherwise it answers whether the
    // candidate query could return anything at all, for about a millisecond against
    // the hundreds that query costs -- an hourly bill that never stops, since
    // "nothing to do" is the steady state this reaches on day one.
    toolResultsTruncated: overCeiling
      || hasAgeEligibleRow(db, cutoffIso, retention.chatToolResultHeadChars)
      ? truncateChatToolResults(db, {
        headChars: retention.chatToolResultHeadChars,
        cutoffIso,
        maxRows: RETENTION_MAX_ROWS_PER_TICK,
        overCeiling
      })
      : 0
  };
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
function deleteSupersededRuntimeContext(db: Database): number {
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
  const deleteBefore = db.prepare(`
    delete from agent_messages
    where id in (
      select id from agent_messages
      where thread_id = ? and source in (${MODEL_ONLY_SOURCES_SQL}) and seq < ?
      order by seq limit ?
    )
  `);

  let deleted = 0;
  for (const { thread_id: threadId } of threads) {
    if (deleted >= RETENTION_MAX_ROWS_PER_TICK) break;
    const marker = latestInitial.get(threadId) as { seq: number } | null;
    if (!marker) continue;
    const budget = RETENTION_MAX_ROWS_PER_TICK - deleted;
    deleted += deleteBefore.run(threadId, marker.seq, budget).changes;
  }
  return deleted;
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
function clearOldLlmPayloads(db: Database, now: Date): number {
  const cutoff = new Date(now.getTime() - LLM_PAYLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    update llm_calls
    set request_json = null,
        metadata_json = case
          when ${METADATA_IS_OBJECT} then ${REDUCED_METADATA}
          else metadata_json
        end
    where id in (
      select id from llm_calls
      where created_at < ?
        and (request_json is not null or ${METADATA_NEEDS_REDUCTION})
      limit ?
    )
  `).run(cutoff, RETENTION_MAX_ROWS_PER_TICK).changes;
}

/** Measuring the table costs a full scan -- on a large database, more
 *  than the whole idle pass otherwise costs. That pass runs
 *  every hour forever, so paying it every tick would nearly triple the cost of
 *  the case that never stops running.
 *
 *  A day adds little to the table, so a 512 MB ceiling cannot be crossed and
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
const ceilingCache = new WeakMap<Database, { checkedAtMs: number; exceeded: boolean }>();

function isOverCeiling(db: Database, maxBytes: number, nowMs: number): boolean {
  const cached = ceilingCache.get(db);
  if (cached && nowMs - cached.checkedAtMs < CEILING_CHECK_INTERVAL_MS) return cached.exceeded;
  const row = db.prepare("select coalesce(sum(length(content)), 0) b from agent_messages")
    .get() as { b: number };
  const exceeded = row.b > maxBytes;
  ceilingCache.set(db, { checkedAtMs: nowMs, exceeded });
  return exceeded;
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

  const update = db.prepare("update agent_messages set content = ? where id = ?");
  let changed = 0;
  for (const row of rows) {
    const next = truncateToolResultContent(row.content, opts.headChars);
    if (!next) continue;
    update.run(next, row.id);
    changed += 1;
  }
  return changed;
}
