import type { Database } from "bun:sqlite";
import type {
  AgentMessage,
  AgentMessageContent,
  AgentMessageSource,
  AgentRole
} from "./agent-store.js";
import { redactForReader as redactText } from "./reader-redaction.js";
import { buildWordsQuery, deleteWordsRow, fillHistoryWords, historyOldIndexInUse, historyWordsReady, queryTerms, wordKeyBounds, writeWordsRow } from "./history-words.js";
import { logError } from "../../platform/logger.js";
import { escapeLike, normalizeNullableString } from "../../platform/text/sql-text.js";
import { limitToolText } from "./tool-result-format.js";
import { WorkerRecordStore, RECORD_SEARCH_LIMIT } from "../plans/record-store.js";
import type { SqlValue } from "../../platform/db/sql-value.js";
import { parseJsonStringArray } from "../../platform/json.js";
import { isModelOnlySource, MODEL_ONLY_SOURCES_SQL } from "../../../shared/agent-message-types.js";
import { runSearchReadsAway } from "./history-search-away.js";

type ChatHistoryTimePreset = "last7d" | "last30d" | "last90d" | "projectLifetime" | "all";

interface ChatHistoryTimeRangeInput {
  preset?: ChatHistoryTimePreset;
  since?: string;
  until?: string;
}

interface ResolvedChatHistoryTimeRange {
  preset: ChatHistoryTimePreset;
  since: string | null;
  until: string | null;
}

interface ChatHistorySearchInput {
  callerThreadId: string;
  projectId?: string | null;
  query: string;
  workerId?: string | null;
  threadId?: string | null;
  timeRange?: ChatHistoryTimeRangeInput;
  includeArchived?: boolean;
  includeOwnThread?: boolean;
  limit?: number;
  snippetsPerThread?: number;
}

/** A worker's task record a search found: by its worker and first line,
 *  with the lines holding the query's terms; memory_read opens it whole. */
interface ChatHistoryRecord {
  id: string;
  worker: string;
  project: string;
  /** The record's last rewrite, YYYY-MM-DD. */
  updated: string;
  firstLine: string;
  lines: string[];
}

interface ChatHistorySearchResult {
  /** The project searched; null when none was named. */
  project: { id: string; name: string } | null;
  timeRange: ResolvedChatHistoryTimeRange;
  includeArchived: boolean;
  threads: ChatHistoryThread[];
  records: ChatHistoryRecord[];
  /** Why the chats were not searched, when they were not. */
  chatsNotSearched?: string;
  caps: { maxPayloadChars: number; truncated: boolean };
}

/** A thread a search found: whose it is, then how it matched. */
type ChatHistoryThread = ChatHistoryThreadMeta & {
  /** Relative to the other results in this response only -- the signals behind
   *  it are normalized across the set, so it is not comparable across searches. */
  score: number;
  hitCount: number;
  hits: ChatHistoryHit[];
};

interface ChatHistoryThreadMetaBase {
  id: string;
  archivedAt: string | null;
  updatedAt: string;
}

/** Whose a thread is. A worker's is in its project; a manager's and the
 *  personal agent's are in none. */
type ChatHistoryThreadMeta =
  | (ChatHistoryThreadMetaBase & { kind: "worker"; project: string; worker: { id: string; name: string } })
  | (ChatHistoryThreadMetaBase & { kind: "manager"; title: string | null })
  | (ChatHistoryThreadMetaBase & { kind: "personal" });

interface ChatHistoryHit {
  messageId: string;
  seq: number;
  role: AgentRole;
  source: AgentMessageSource;
  createdAt: string;
  snippet: string;
  redactions: string[];
}

interface ChatHistoryReadInput {
  callerThreadId: string;
  /** The thread and seq of a search hit. */
  threadId: string;
  seq: number;
  limitBefore?: number;
  limitAfter?: number;
  includeTools?: boolean;
  maxCharsPerMessage?: number;
}

interface ChatHistoryReadResult {
  thread: ChatHistoryThreadMeta;
  messages: ChatHistoryReadMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  caps: { maxCharsPerMessage: number; truncated: boolean };
}

interface ChatHistoryReadMessage {
  messageId: string;
  seq: number;
  role: AgentRole;
  source: AgentMessageSource;
  createdAt: string;
  content: { type: string; text: string; redactions: string[]; truncated?: boolean };
}

interface SearchEntryRow {
  id: string;
  message_id: string;
  thread_id: string;
  seq: number;
  role: string;
  source: string;
  content_text: string;
  tool_names_json: string | null;
  redaction_flags_json: string | null;
  message_created_at: string;
  /** bm25 from the FTS path, `null` from the LIKE path. LIKE has no notion of
   *  relevance, and `null` says so -- a numeric stand-in would be compared
   *  against real bm25 values as if it meant something. */
  rank?: number | null;
}

/** One scope's search: what searchRows and its FTS and LIKE paths take. */
interface SearchRowQuery {
  query: string;
  /** A project's worker threads, or with null the threads outside any
   *  project: managers' and the personal agent's. */
  projectId: string | null;
  workerId: string | null;
  threadId: string | null;
  timeRange: ResolvedChatHistoryTimeRange;
  includeArchived: boolean;
  excludedThreads: Set<string>;
  limit: number;
}

interface RawMessageRow {
  id: string;
  thread_id: string;
  seq: number;
  role: string;
  source: string;
  source_thread_id: string | null;
  wake_id: string | null;
  content: string;
  created_at: string;
}

/** The columns of a RawMessageRow, read from `agent_messages m`. */
const RAW_MESSAGE_COLUMNS = `m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id,
  m.wake_id, m.content, m.created_at`;

interface ThreadScopeRow {
  thread_id: string;
  scope: string;
  scope_id: string | null;
  thread_title: string | null;
  thread_archived_at: string | null;
  thread_updated_at: string;
  worker_id: string | null;
  worker_name: string | null;
  worker_archived_at: string | null;
  project_id: string | null;
  project_name: string | null;
  project_archived_at: string | null;
}

const SEARCH_LIMIT_DEFAULT = 5;
const SEARCH_LIMIT_MAX = 10;
const SNIPPETS_PER_THREAD_DEFAULT = 2;
const SNIPPETS_PER_THREAD_MAX = 5;
const SEARCH_PAYLOAD_CHAR_CAP = 32_000;
const READ_LIMIT_BEFORE_DEFAULT = 5;
const READ_LIMIT_AFTER_DEFAULT = 5;
const READ_LIMIT_MAX = 20;
const READ_MESSAGE_CHAR_DEFAULT = 2_000;
const READ_MESSAGE_CHAR_MAX = 4_000;
const BACKFILL_BATCH_SIZE = 500;
const BACKFILL_MAX_ROWS = 5_000;
/** Relevance given to a group that came from the LIKE fallback, on the [0, 1]
 *  scale scoreThreads normalizes onto. Also given to *every* group in a mixed set
 *  whose ranked groups share a single quality value, because a lone bm25 has
 *  nothing in that set it can be placed against -- see scoreThreads.
 *
 *  Which retrieval path answered is not a quality signal -- it is whether that
 *  half's index matched by word; a half where nothing did falls back to LIKE.
 *  Sinking LIKE groups would systematically punish whichever half fell back;
 *  floating them to the top would hand them a free win. 0.5 is the neutral
 *  midpoint, and needs no calibration against any corpus. */
const LIKE_MATCH_RELEVANCE = 0.5;

export class AgentHistoryStore {
  constructor(private db: Database) {}

  backfill(): number {
    const { processed, complete } = backfillAgentHistoryIndex(this.db);
    if (complete) historyIndexComplete.add(this.db);
    return processed;
  }

  search(input: ChatHistorySearchInput): ChatHistorySearchResult {
    const plan = this.planSearch(input);
    return this.finishSearch(plan, runSearchReads(this.db, plan.reads));
  }

  /** search, with its reads in a worker of their own (a read-only
   *  connection), so a search that reads thousands of rows does not hold
   *  the server's thread; the checks before and the writes after stay here.
   *  A worker that fails leaves the reads to this thread. */
  async searchAway(input: ChatHistorySearchInput): Promise<ChatHistorySearchResult> {
    const plan = this.planSearch(input);
    let found: SearchFound;
    try {
      found = await runSearchReadsAway(this.db.filename, plan.reads);
    } catch (error) {
      logError("history-search", error, "searching in a worker failed; searching on the server's thread");
      found = runSearchReads(this.db, plan.reads);
    }
    return this.finishSearch(plan, found);
  }

  /** What a search may read, checked, and what it reads. */
  private planSearch(input: ChatHistorySearchInput) {
    // Looking for misses is a pass over every message: only until a backfill
    // has found none, and again after a message's indexing failed.
    if (!historyIndexComplete.has(this.db)) this.backfill();
    // Until a pass over the words index has ended (just deployed, started
    // up, a new ICU), a search takes one bounded step of it, never a reset;
    // it finds by text until then.
    if (!historyWordsReady(this.db)) {
      try {
        fillHistoryWords(this.db, { reset: false });
      } catch (e) {
        logError("history-words", e, "filling the words index failed");
      }
    }
    const caller = this.resolveCaller(input.callerThreadId);
    const workerId = normalizeNullableString(input.workerId);
    // A manager naming a worker and no project searches that worker's project.
    const requested = resolveRequestedProjectId(caller, input.projectId);
    const projectId = requested === null && workerId ? this.projectOfWorker(workerId) : requested;
    const project = projectId === null ? null : this.getProject(projectId, Boolean(input.includeArchived));
    if (projectId !== null && !project) throw historyError("project_not_found", "project not found or archived");

    const timeRange = withProjectLifetimeSince(resolveTimeRange(input.timeRange), project?.createdAt ?? null);
    const threadId = normalizeNullableString(input.threadId);
    const workerArchived = workerId && projectId !== null ? this.assertWorkerInScope(workerId, projectId) : false;
    // Only a manager or the personal agent may name a thread outside the
    // projects; a worker's project scope can never reach one.
    if (threadId) {
      this.assertThreadInScope(
        threadId,
        projectId,
        Boolean(input.includeArchived),
        caller.scope === "manager"
      );
    }
    this.assertCallerAllowedProject(caller, projectId);

    const query = input.query.trim();
    if (query.length < 2) throw historyError("invalid_query", "query must be at least 2 characters");
    const limit = boundedInt(input.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
    const snippetsPerThread = boundedInt(
      input.snippetsPerThread,
      SNIPPETS_PER_THREAD_DEFAULT,
      SNIPPETS_PER_THREAD_MAX
    );
    const includeArchived = Boolean(input.includeArchived);
    // Excluding the current thread assumes it is already in the caller's
    // context. That holds for a worker. It does not hold for a manager or the
    // personal agent: their thread is long-lived and compressed many times, and
    // reaching what fell out of its context is the whole point of this
    // search, so it is never excluded.
    const excludedThreads = input.includeOwnThread || caller.scope === "manager"
      ? new Set<string>()
      : new Set<string>([caller.threadId]);

    // Workers' task records: their own lane, of any age unless the caller
    // bounds it (a time preset is for chats), never narrowed to one thread.
    // A worker's own record only with its own thread.
    const records: RecordReadQuery | null = threadId ? null : {
      query,
      projectId,
      workerId,
      includeArchived,
      excludeWorkerId: caller.scope === "worker" && !input.includeOwnThread ? caller.workerId : null,
      since: normalizeIso(input.timeRange?.since, "since"),
      until: normalizeIso(input.timeRange?.until, "until")
    };

    const rowBudget = Math.max(limit * snippetsPerThread * 3, 25);
    const rowQuery = {
      query,
      workerId,
      threadId,
      timeRange,
      includeArchived,
      excludedThreads,
      limit: rowBudget
    };
    // One ranked query per place, each with its own full row budget. A single
    // query spanning a project and the threads outside the projects lets
    // whichever ranks higher consume the whole window: a manager's thread is
    // far longer than any worker thread, so it can fill every row and still
    // collapse to a single result, starving the requested project's own
    // worker threads out of the answer. The two places share no thread, so
    // concatenating them needs no dedup, and groupSearchRows groups, scores
    // and slices the union exactly as it does for one query.
    // An until before the time preset's start leaves no chats to search.
    const chatsOutOfRange = Boolean(timeRange.since && timeRange.until && timeRange.since > timeRange.until);
    // Why no chats came back when the search could not look: said, so an
    // empty result does not read as "nothing was said".
    const chatsNotSearched = chatsOutOfRange
      ? "The until is before this time range's start, so no chats were searched: for older chats, pass preset \"projectLifetime\" or \"all\"."
      : workerArchived && !includeArchived
        ? "This worker is archived: its chats are searched with includeArchived: true."
        : null;
    const rows: SearchRowQuery[] = chatsOutOfRange ? [] : [{ ...rowQuery, projectId }];
    // Only a manager or the personal agent reaches the threads outside the
    // projects; a worker's search keeps to its project. Narrowing to a worker
    // leaves them out by definition, and a search that named no project
    // already reads them above.
    if (!chatsOutOfRange && caller.scope === "manager" && !workerId && projectId !== null) {
      rows.push({ ...rowQuery, projectId: null });
    }
    return {
      input, caller, project, projectId, workerId, threadId, timeRange, includeArchived, query, limit, snippetsPerThread, chatsNotSearched,
      reads: { records, rows } satisfies SearchReads
    };
  }

  /** The rows whose thread a search made now would still find. The reads may
   *  have run on another connection, before a thread, its worker or its
   *  project was archived or deleted here; those rows drop out rather than
   *  fail the whole search. */
  private stillListed(rows: SearchEntryRow[], includeArchived: boolean): SearchEntryRow[] {
    const listed = new Map<string, boolean>();
    return rows.filter((row) => {
      let keep = listed.get(row.thread_id);
      if (keep === undefined) {
        const scope = this.threadScope(row.thread_id);
        keep = scope !== null
          && (includeArchived || !(scope.thread_archived_at || scope.worker_archived_at || scope.project_archived_at));
        listed.set(row.thread_id, keep);
      }
      return keep;
    });
  }

  /** The task records a search made now would still return: the same
   *  question as stillListed asks of chat rows. A record goes with its
   *  worker, and its project may have been archived since the read. */
  private recordsStillListed(records: ChatHistoryRecord[], includeArchived: boolean): ChatHistoryRecord[] {
    if (records.length === 0) return records;
    const listed = new Set((this.db.prepare(`
      select r.id from worker_records r join projects p on p.id = r.project_id
      where r.id in (${records.map(() => "?").join(", ")})${includeArchived ? "" : " and p.archived_at is null"}
    `).all(...records.map((r) => r.id)) as Array<{ id: string }>).map((r) => r.id));
    return records.filter((r) => listed.has(r.id));
  }

  private finishSearch(plan: ReturnType<AgentHistoryStore["planSearch"]>, found: SearchFound): ChatHistorySearchResult {
    const { caller, project, projectId, timeRange, includeArchived, limit, snippetsPerThread, chatsNotSearched } = plan;
    // One read of the threads, workers and projects the answer names.
    const { records, capped } = this.db.transaction(() => {
      const records = this.recordsStillListed(found.records, includeArchived);
      const grouped = this.groupSearchRows(this.stillListed(found.rows, includeArchived), {
        projectId,
        includeArchived,
        snippetsPerThread,
        limit,
        // The row filter has already pinned every row to a place the caller
        // may see, so this is the second of two layers rather than the only one.
        allowOutsideProjects: caller.scope === "manager"
      });
      // The records come first; the chats fill what is left of the payload.
      return { records, capped: capSearchResults(grouped, SEARCH_PAYLOAD_CHAR_CAP - JSON.stringify(records).length) };
    })();
    return {
      project: project ? { id: project.id, name: project.name } : null,
      timeRange,
      includeArchived,
      threads: capped.results,
      records,
      ...(chatsNotSearched ? { chatsNotSearched } : {}),
      caps: { maxPayloadChars: SEARCH_PAYLOAD_CHAR_CAP, truncated: capped.truncated }
    };
  }

  /** The window around one message of a thread the caller could have found
   *  by search: a worker its own project's worker threads, a manager or the
   *  personal agent any thread that is searched. A thread named this way is
   *  read even when archived. */
  read(input: ChatHistoryReadInput): ChatHistoryReadResult {
    const caller = this.resolveCaller(input.callerThreadId);
    const threadId = normalizeNullableString(input.threadId);
    if (!threadId) throw historyError("thread_not_found", "thread not found");
    const row = this.threadScope(threadId);
    if (!row || !SEARCHED_SCOPES.has(row.scope)) throw historyError("thread_not_found", "thread not found");
    if (caller.scope === "worker" && (row.scope !== "worker" || row.project_id !== caller.projectId)) {
      throw historyError("thread_out_of_scope", "workers can only read their own project's worker threads");
    }
    const thread = threadMetaOf(row);
    const seq = Number(input.seq);
    if (!Number.isInteger(seq) || !this.hasIndexedMessage(threadId, seq)) {
      throw historyError("message_not_found", `no indexed message ${input.seq} in that thread`);
    }
    const limitBefore = boundedInt(input.limitBefore, READ_LIMIT_BEFORE_DEFAULT, READ_LIMIT_MAX);
    const limitAfter = boundedInt(input.limitAfter, READ_LIMIT_AFTER_DEFAULT, READ_LIMIT_MAX);
    const maxChars = boundedInt(input.maxCharsPerMessage, READ_MESSAGE_CHAR_DEFAULT, READ_MESSAGE_CHAR_MAX);
    const includeTools = Boolean(input.includeTools);
    const rows = this.readWindow(threadId, seq, limitBefore, limitAfter, includeTools);
    const messages = rows
      .map((message) => serializeReadMessage(message, { includeTools, maxChars }))
      .filter((message): message is ChatHistoryReadMessage => Boolean(message));
    const firstSeq = rows[0]?.seq ?? seq;
    const lastSeq = rows[rows.length - 1]?.seq ?? seq;
    return {
      thread,
      messages,
      hasMoreBefore: this.hasReadableMessage("before", threadId, firstSeq, includeTools),
      hasMoreAfter: this.hasReadableMessage("after", threadId, lastSeq, includeTools),
      caps: { maxCharsPerMessage: maxChars, truncated: messages.some((message) => message.content.truncated) }
    };
  }

  private resolveCaller(threadId: string) {
    const threadRow = (sql: string, id: string) => this.db.prepare(sql).get(id) as {
      id: string;
      scope: string;
      scope_id: string | null;
      archived_at: string | null;
    } | null | undefined;
    const caller = threadRow(`
      select id, scope, scope_id, archived_at
      from agent_threads
      where id = ?
    `, threadId);
    if (!caller) throw historyError("caller_thread_not_found", "caller thread not found");
    // A subagent searches as the thread that started it (a worker's subagent
    // within the worker's project), under its own id: its own thread is the
    // one left out. A subagent never starts another.
    const thread = caller.scope !== "subagent" ? caller : threadRow(`
      select t.id, t.scope, t.scope_id, t.archived_at
      from background_tasks bt
      join agent_threads t on t.id = bt.parent_thread_id
      where bt.child_thread_id = ? and t.scope != 'subagent'
    `, caller.id);
    if (!thread) throw historyError("caller_thread_not_found", "caller thread not found");
    if (thread.scope === "worker") {
      const worker = this.db.prepare(`
        select wk.id, wk.project_id, wk.archived_at, p.archived_at as project_archived_at
        from workers wk
        join projects p on p.id = wk.project_id
        where wk.id = ?
      `).get(thread.scope_id) as {
        id: string;
        project_id: string;
        archived_at: string | null;
        project_archived_at: string | null;
      } | undefined;
      if (!worker) throw historyError("worker_not_found", "caller worker not found");
      return {
        threadId: caller.id,
        scope: "worker" as const,
        workerId: worker.id,
        projectId: worker.project_id
      };
    }
    return {
      threadId: caller.id,
      scope: "manager" as const,
      workerId: null,
      projectId: null
    };
  }

  private assertCallerAllowedProject(
    caller: ReturnType<AgentHistoryStore["resolveCaller"]>,
    projectId: string | null
  ): void {
    if (caller.scope === "worker" && caller.projectId !== projectId) {
      throw historyError("project_out_of_scope", "workers can only search their own project");
    }
  }

  private getProject(projectId: string, includeArchived: boolean): { id: string; name: string; createdAt: string } | null {
    const row = this.db.prepare(`
      select id, name, created_at, archived_at
      from projects
      where id = ?
    `).get(projectId) as { id: string; name: string; created_at: string; archived_at: string | null } | undefined;
    if (!row) return null;
    if (!includeArchived && row.archived_at) return null;
    return { id: row.id, name: row.name, createdAt: row.created_at };
  }

  /** A worker named as a filter must exist and belong to the project
   *  searched; whether it is archived. An archived one is no error: its
   *  record still answers, and its chats are left out unless
   *  includeArchived, as every archived thread's are (chatsNotSearched). */
  private assertWorkerInScope(workerId: string, projectId: string): boolean {
    const row = this.db.prepare(`
      select id, project_id, archived_at
      from workers
      where id = ?
    `).get(workerId) as { id: string; project_id: string; archived_at: string | null } | undefined;
    if (!row) throw historyError("worker_not_found", "worker not found");
    if (row.project_id !== projectId) throw historyError("worker_out_of_scope", "worker is outside project scope");
    return Boolean(row.archived_at);
  }

  private projectOfWorker(workerId: string): string {
    const row = this.db.prepare("select project_id from workers where id = ?").get(workerId) as { project_id: string } | undefined;
    if (!row) throw historyError("worker_not_found", "worker not found");
    return row.project_id;
  }

  /** A thread a search in `projectId` (null: outside the projects) may
   *  return, as the answer names it. */
  private assertThreadInScope(
    threadId: string,
    projectId: string | null,
    includeArchived: boolean,
    allowOutsideProjects = false
  ): ChatHistoryThreadMeta {
    const row = this.threadScope(threadId);
    if (!row || !SEARCHED_SCOPES.has(row.scope)) throw historyError("thread_not_found", "thread not found");
    if (row.scope !== "worker") {
      // A manager's or the personal agent's thread is in no project: only a
      // manager or the personal agent reaches it, and only the thread itself
      // can be archived. (A worker's search always names its project.)
      if (!allowOutsideProjects) {
        throw historyError("thread_out_of_scope", "thread is outside project scope");
      }
      if (!includeArchived && row.thread_archived_at) {
        throw historyError("archived_not_included", "thread or owner is archived");
      }
      return threadMetaOf(row);
    }
    if (row.project_id !== projectId || !row.worker_id || !row.worker_name) {
      throw historyError("thread_out_of_scope", "thread is outside project scope");
    }
    if (!includeArchived && (row.thread_archived_at || row.worker_archived_at || row.project_archived_at)) {
      throw historyError("archived_not_included", "thread or owner is archived");
    }
    return threadMetaOf(row);
  }

  private threadScope(threadId: string): ThreadScopeRow | null {
    return threadScopeRow(this.db, threadId);
  }

  /** Each thread's rows as one result, scored against the others. */
  private groupSearchRows(
    rows: SearchEntryRow[],
    opts: {
      projectId: string | null;
      includeArchived: boolean;
      limit: number;
      snippetsPerThread: number;
      allowOutsideProjects: boolean;
    }
  ): ChatHistoryThread[] {
    const groups = new Map<string, SearchEntryRow[]>();
    for (const row of rows) groups.set(row.thread_id, [...(groups.get(row.thread_id) ?? []), row]);
    // Scored against each other, so every group's signals must be in hand
    // before any score exists.
    const scores = scoreThreads([...groups].map(([id, entries]) => ({ id, entries })));
    const results: ChatHistoryThread[] = [];
    for (const [threadId, entries] of groups) {
      // A row from the threads outside the projects is admitted with them;
      // a project's row only in its own project.
      const outside = this.threadScope(threadId)?.scope !== "worker";
      const meta = this.assertThreadInScope(threadId, outside ? null : opts.projectId, opts.includeArchived, opts.allowOutsideProjects);
      const hits = entries
        .slice()
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.message_created_at.localeCompare(a.message_created_at))
        .slice(0, opts.snippetsPerThread)
        .map((entry) => ({
          messageId: entry.message_id,
          seq: entry.seq,
          role: entry.role as AgentRole,
          source: entry.source as AgentMessageSource,
          createdAt: entry.message_created_at,
          snippet: makeSnippet(entry.content_text),
          redactions: parseJsonStringArray(entry.redaction_flags_json)
        }));
      results.push({ ...meta, score: scores.get(threadId) ?? 0, hitCount: entries.length, hits });
    }
    return results
      .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, opts.limit);
  }

  private hasIndexedMessage(threadId: string, seq: number): boolean {
    return Boolean(this.db.prepare(`
      select 1 from agent_message_search_entries where thread_id = ? and seq = ? limit 1
    `).get(threadId, seq));
  }

  private readWindow(threadId: string, seq: number, limitBefore: number, limitAfter: number, includeTools: boolean): AgentMessage[] {
    const beforeRows = this.readMessageRows(threadId, `m.seq < ?`, [seq], limitBefore, "desc", includeTools).reverse();
    const centerRows = this.readMessageRows(threadId, `m.seq = ?`, [seq], 1, "asc", includeTools);
    const afterRows = this.readMessageRows(threadId, `m.seq > ?`, [seq], limitAfter, "asc", includeTools);
    return [...beforeRows, ...centerRows, ...afterRows].map(rawRowToMessage);
  }

  private readMessageRows(
    threadId: string,
    seqPredicate: string,
    seqParams: SqlValue[],
    limit: number,
    order: "asc" | "desc",
    includeTools: boolean
  ): RawMessageRow[] {
    return this.db.prepare(`
      select ${RAW_MESSAGE_COLUMNS}
      from agent_messages m
      where m.thread_id = ?
        and ${seqPredicate}
        ${readableMessageSqlFilter(includeTools)}
      order by m.seq ${order}, m.created_at ${order}, m.id ${order}
      limit ?
    `).all(threadId, ...seqParams, limit) as RawMessageRow[];
  }

  /** Whether the thread has a readable message before or after `seq`. */
  private hasReadableMessage(direction: "before" | "after", threadId: string, seq: number, includeTools: boolean): boolean {
    const seqOperator = direction === "before" ? "<" : ">";
    // From the window outward: the nearest row answers.
    const row = this.db.prepare(`
      select id
      from agent_messages m
      where m.thread_id = ? and m.seq ${seqOperator} ? ${readableMessageSqlFilter(includeTools)}
      order by m.seq ${direction === "before" ? "desc" : "asc"}
      limit 1
    `).get(threadId, seq) as { id: string } | undefined;
    return Boolean(row);
  }
}

/** The thread scopes the index holds: a subagent's thread is not indexed
 *  (what it was told and found are in its parent's). */
const SEARCHED_SCOPES = new Set(["worker", "manager", "personal"]);

/** Whose a thread is, as a search and a read name it. */
function threadMetaOf(row: ThreadScopeRow): ChatHistoryThreadMeta {
  const base = { id: row.thread_id, archivedAt: row.thread_archived_at, updatedAt: row.thread_updated_at };
  if (row.scope === "worker") {
    if (!row.worker_id || !row.worker_name || !row.project_name) throw historyError("thread_not_found", "thread not found");
    return { ...base, kind: "worker", project: row.project_name, worker: { id: row.worker_id, name: row.worker_name } };
  }
  if (row.scope === "personal") return { ...base, kind: "personal" };
  return { ...base, kind: "manager", title: row.thread_title };
}

/** Indexes `message` in its index, or not at all: a words write that
 *  failed after the entry was in left it out of words searches with nothing
 *  to repair it, where an entry not in at all is backfilled on the next search. */
export function indexAgentHistoryMessage(db: Database, message: AgentMessage): void {
  db.transaction(() => {
    const projection = projectMessageForHistory(db, message);
    if (!projection) {
      deleteIndexedMessage(db, message.id);
      markSkippedMessage(db, message.id);
      return;
    }
    unmarkSkippedMessage(db, message.id);
    upsertProjection(db, projection);
  }).immediate();
}

/** The databases whose every message this process knows to be indexed: a
 *  backfill ran to its end and no indexing failed since. */
const historyIndexComplete = new WeakSet<Database>();

/** A message's indexing failed as it was written: the next search looks for
 *  misses again. */
export function markHistoryIndexIncomplete(db: Database): void {
  historyIndexComplete.delete(db);
}

/** How far a backfill that found none left had read: every message at or
 *  below this rowid was indexed or passed over then, and is not looked for
 *  again (each message is indexed as it is written; a backfill catches what
 *  a failed indexing left). Kept beside the words
 *  index's own state. */
const BACKFILL_CHECKED_KEY = "backfill_checked_rowid";
// The trigger that brings it down after a deletion names it too (history-schema.ts).

/** Indexes unindexed messages after the last complete backfill's mark,
 *  newest first, in bounded batches; complete when a batch found none left,
 *  and then the mark moves to where this one began. */
function backfillAgentHistoryIndex(db: Database): { processed: number; complete: boolean } {
  const mark = db.prepare("select value from agent_message_search_words_state where key = ?").get(BACKFILL_CHECKED_KEY) as { value: string } | null;
  const checked = Number(mark?.value ?? 0) || 0;
  // A message written while this runs is past it: looked for next time.
  const top = (db.prepare("select coalesce(max(rowid), 0) as top from agent_messages").get() as { top: number }).top;
  let processed = 0;
  while (processed < BACKFILL_MAX_ROWS) {
    const rows = db.prepare(`
    select ${RAW_MESSAGE_COLUMNS}
    from agent_messages m
    left join agent_message_search_entries e on e.message_id = m.id
    left join agent_message_search_skipped s on s.message_id = m.id
    where m.rowid > ? and m.rowid <= ?
      and e.message_id is null
      and s.message_id is null
    order by m.created_at desc, m.id desc
    limit ?
  `).all(checked, top, Math.min(BACKFILL_BATCH_SIZE, BACKFILL_MAX_ROWS - processed)) as RawMessageRow[];
    if (rows.length === 0) {
      db.prepare("insert into agent_message_search_words_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
        .run(BACKFILL_CHECKED_KEY, String(top));
      return { processed, complete: true };
    }
    for (const row of rows) {
      const message = rawRowToMessage(row);
      try {
        indexAgentHistoryMessage(db, message);
      } catch (error) {
        // A full or locked database is not the message's fault: the next
        // search tries it again. Anything else, it is passed over for good.
        if (isTransientSqliteError(error)) return { processed, complete: false };
        markSkippedMessage(db, message.id);
      }
    }
    processed += rows.length;
  }
  return { processed, complete: false };
}

/** Moves the backfill's mark to the newest message while this process knows
 *  every message to be indexed (a backfill ran to its end, and each message
 *  since was indexed as it was written, none failing): the next backfill,
 *  the first search after a restart, then looks only at what came after.
 *  Run by the hourly retention pass. True when it moved. */
export function advanceHistoryBackfillMark(db: Database): boolean {
  if (!historyIndexComplete.has(db)) return false;
  const top = (db.prepare("select coalesce(max(rowid), 0) as top from agent_messages").get() as { top: number }).top;
  db.prepare("insert into agent_message_search_words_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value")
    .run(BACKFILL_CHECKED_KEY, String(top));
  return true;
}

/** SQLite failing for the database's state, not for the data written. */
function isTransientSqliteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^SQLITE_(BUSY|LOCKED|FULL|IOERR|NOMEM|READONLY|INTERRUPT|CANTOPEN|PROTOCOL)/.test(code);
}

function projectMessageForHistory(db: Database, message: AgentMessage): {
  id: string;
  messageId: string;
  threadId: string;
  seq: number;
  role: AgentRole;
  source: AgentMessageSource;
  contentText: string;
  toolNames: string[];
  redactions: string[];
  createdAt: string;
} | null {
  const scope = threadScopeRow(db, message.threadId);
  // Where a message is comes from its thread when a search reads it; here
  // only whether it is indexed: a worker's, a manager's and the personal
  // agent's are, a subagent's is not (SEARCHED_SCOPES).
  if (!scope || !SEARCHED_SCOPES.has(scope.scope)) return null;
  if (scope.scope === "worker" && (!scope.project_id || !scope.worker_id)) return null;

  const extracted = extractHistoryText(message);
  if (!extracted || !extracted.text.trim()) return null;
  const redacted = redactText(extracted.text);
  if (!redacted.text.trim()) return null;
  return {
    id: `hidx_${message.id}`,
    messageId: message.id,
    threadId: message.threadId,
    seq: message.seq,
    role: message.role,
    source: message.source,
    contentText: redacted.text,
    toolNames: extracted.toolNames,
    redactions: Array.from(new Set([...extracted.redactions, ...redacted.flags])),
    createdAt: message.createdAt
  };
}

function threadScopeRow(db: Database, threadId: string): ThreadScopeRow | null {
  const row = db.prepare(`
    select
      t.id as thread_id,
      t.scope,
      t.scope_id,
      t.title as thread_title,
      t.archived_at as thread_archived_at,
      t.updated_at as thread_updated_at,
      wk.id as worker_id,
      wk.name as worker_name,
      wk.archived_at as worker_archived_at,
      p.id as project_id,
      p.name as project_name,
      p.archived_at as project_archived_at
    from agent_threads t
    left join workers wk on wk.id = t.scope_id and t.scope = 'worker'
    left join projects p on p.id = wk.project_id
    where t.id = ?
  `).get(threadId) as ThreadScopeRow | undefined;
  return row ?? null;
}

function upsertProjection(
  db: Database,
  projection: NonNullable<ReturnType<typeof projectMessageForHistory>>
): void {
  const indexedAt = new Date().toISOString();
  db.prepare(`
      insert into agent_message_search_entries
        (id, message_id, thread_id, seq, role, source,
         content_text, tool_names_json, redaction_flags_json,
         message_created_at, indexed_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(message_id) do update set
        thread_id = excluded.thread_id,
        seq = excluded.seq,
        role = excluded.role,
        source = excluded.source,
        content_text = excluded.content_text,
        tool_names_json = excluded.tool_names_json,
        redaction_flags_json = excluded.redaction_flags_json,
        message_created_at = excluded.message_created_at,
        indexed_at = excluded.indexed_at
    `).run(
      projection.id,
      projection.messageId,
      projection.threadId,
      projection.seq,
      projection.role,
      projection.source,
      projection.contentText,
      JSON.stringify(projection.toolNames),
      JSON.stringify(projection.redactions),
      projection.createdAt,
      indexedAt
    );
  if (historyOldIndexInUse(db)) {
    db.prepare("delete from agent_message_search_fts where entry_id = ?").run(projection.id);
    db.prepare(`
        insert into agent_message_search_fts
          (entry_id, message_id, thread_id, role, source, content_text, tool_names)
        values (?, ?, ?, ?, ?, ?, ?)
      `).run(
        projection.id,
        projection.messageId,
        projection.threadId,
        projection.role,
        projection.source,
        projection.contentText,
        projection.toolNames.join(" ")
      );
  }
  writeWordsRow(db, { id: projection.id, createdAt: projection.createdAt, contentText: projection.contentText, toolNames: projection.toolNames, indexedAt });
}

function deleteIndexedMessage(db: Database, messageId: string): void {
  const row = db.prepare(`
    select id
    from agent_message_search_entries
    where message_id = ?
  `).get(messageId) as { id: string } | undefined;
  if (!row) return;
  deleteWordsRow(db, row.id);
  if (historyOldIndexInUse(db)) db.prepare("delete from agent_message_search_fts where entry_id = ?").run(row.id);
  db.prepare("delete from agent_message_search_entries where id = ?").run(row.id);
}

/** A message deleted from its conversation: what search kept of it goes. */
export function forgetIndexedMessage(db: Database, messageId: string): void {
  deleteIndexedMessage(db, messageId);
  unmarkSkippedMessage(db, messageId);
}

function markSkippedMessage(db: Database, messageId: string): void {
  db.prepare(`
    insert into agent_message_search_skipped (message_id, indexed_at)
    values (?, ?)
    on conflict(message_id) do update set indexed_at = excluded.indexed_at
  `).run(messageId, new Date().toISOString());
}

function unmarkSkippedMessage(db: Database, messageId: string): void {
  db.prepare("delete from agent_message_search_skipped where message_id = ?").run(messageId);
}

function extractHistoryText(message: AgentMessage): {
  text: string;
  toolNames: string[];
  redactions: string[];
} | null {
  if (message.role === "system" || isModelOnlySource(message.source)) {
    return null;
  }
  const content = message.content;
  switch (content.type) {
    case "text":
      return {
        text: content.text,
        toolNames: [],
        redactions: content.attachments?.length ? ["attachments_filtered"] : []
      };
    case "assistant":
      return {
        text: content.text ?? "",
        toolNames: (content.toolCalls ?? []).map((call) => call.toolName),
        redactions: content.toolCalls?.length ? ["tool_args_filtered"] : []
      };
    case "summary":
      return {
        text: content.summary,
        toolNames: [],
        redactions: []
      };
    case "tool_result":
    case "wake_failure":
      return null;
  }
}

function serializeReadMessage(
  message: AgentMessage,
  opts: { includeTools: boolean; maxChars: number }
): ChatHistoryReadMessage | null {
  if (message.role === "system" || isModelOnlySource(message.source)) {
    return null;
  }
  const serialized = serializeReadContent(message.content, opts);
  if (!serialized) return null;
  return {
    messageId: message.id,
    seq: message.seq,
    role: message.role,
    source: message.source,
    createdAt: message.createdAt,
    content: serialized
  };
}

function serializeReadContent(
  content: AgentMessageContent,
  opts: { includeTools: boolean; maxChars: number }
): ChatHistoryReadMessage["content"] | null {
  switch (content.type) {
    case "text": {
      const redacted = redactText(content.text);
      const limited = limitToolText(redacted.text, opts.maxChars);
      const flags = [...redacted.flags];
      if (content.attachments?.length) flags.push("attachments_filtered");
      return {
        type: "text",
        text: limited.text,
        redactions: flags,
        ...(limited.truncated ? { truncated: true } : {})
      };
    }
    case "assistant": {
      const text = content.text ?? "";
      const redacted = redactText(text);
      const limited = limitToolText(redacted.text, opts.maxChars);
      const flags = [...redacted.flags];
      if (content.toolCalls?.length) flags.push("tool_args_filtered");
      return {
        type: "assistant",
        text: limited.text,
        redactions: flags,
        ...(limited.truncated ? { truncated: true } : {})
      };
    }
    case "summary": {
      const redacted = redactText(content.summary);
      const limited = limitToolText(redacted.text, opts.maxChars);
      return {
        type: "summary",
        text: limited.text,
        redactions: redacted.flags,
        ...(limited.truncated ? { truncated: true } : {})
      };
    }
    case "tool_result": {
      if (!opts.includeTools) return null;
      const value = content.isError
        ? `tool ${content.toolName} error: ${content.error ?? "error"}`
        : `tool ${content.toolName} result omitted`;
      const safe = content.isError ? redactText(value) : { text: value, flags: ["tool_payload_filtered"] };
      const limited = limitToolText(safe.text, opts.maxChars);
      return {
        type: "tool_result",
        text: limited.text,
        redactions: safe.flags,
        ...(limited.truncated ? { truncated: true } : {})
      };
    }
    case "wake_failure":
      return null;
  }
}

function resolveTimeRange(input: ChatHistoryTimeRangeInput | undefined): ResolvedChatHistoryTimeRange {
  const preset = input?.preset ?? "last90d";
  if (!isTimePreset(preset)) throw historyError("time_range_invalid", "unknown time range preset");
  const until = normalizeIso(input?.until, "until");
  const explicitSince = normalizeIso(input?.since, "since");
  let since = explicitSince;
  const now = new Date();
  const presetSince = relativePresetSince(preset, now);
  if (presetSince) {
    since = since && since > presetSince ? since : presetSince;
  }
  // A range the caller set backwards is refused. An until before the preset's
  // own start leaves no chats to search (chatsOutOfRange), and the records,
  // which no preset bounds, still answer.
  if (explicitSince && until && explicitSince > until) {
    throw historyError("time_range_invalid", "timeRange since must be before until");
  }
  return { preset, since, until };
}

function relativePresetSince(preset: ChatHistoryTimePreset, now: Date): string | null {
  if (preset === "last7d") return new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  if (preset === "last30d") return new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  if (preset === "last90d") return new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
  return null;
}

/** projectLifetime starts at the project's creation; with no project named
 *  it does not narrow. */
function withProjectLifetimeSince(
  timeRange: ResolvedChatHistoryTimeRange,
  projectCreatedAt: string | null
): ResolvedChatHistoryTimeRange {
  if (timeRange.preset !== "projectLifetime" || projectCreatedAt === null) return timeRange;
  const createdAt = normalizeIso(projectCreatedAt, "since");
  if (!createdAt) throw historyError("time_range_invalid", "project createdAt is invalid");
  const since = timeRange.since && timeRange.since > createdAt
    ? timeRange.since
    : createdAt;
  if (timeRange.until && since > timeRange.until) {
    throw historyError("time_range_invalid", "effective projectLifetime range is empty");
  }
  return { ...timeRange, since };
}

function isTimePreset(value: string): value is ChatHistoryTimePreset {
  return value === "last7d"
    || value === "last30d"
    || value === "last90d"
    || value === "projectLifetime"
    || value === "all";
}

function normalizeIso(value: unknown, field: "since" | "until"): string | null {
  const normalized = normalizeNullableString(value);
  if (!normalized) return null;
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) throw historyError("time_range_invalid", `${field} must be an ISO timestamp`);
  return new Date(time).toISOString();
}

function resolveRequestedProjectId(
  caller: { scope: "worker" | "manager"; projectId: string | null },
  requested: string | null | undefined
): string | null {
  const normalized = normalizeNullableString(requested);
  if (caller.scope === "worker") {
    if (normalized) {
      throw historyError(
        "project_out_of_scope",
        "workers must omit projectId; current project scope is applied automatically"
      );
    }
    if (!caller.projectId) throw historyError("project_not_found", "caller project not found");
    return caller.projectId;
  }
  // Naming no project searches the threads outside the projects and every
  // project's task records (searchRecordRows).
  return normalized;
}

function rawRowToMessage(row: RawMessageRow): AgentMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    role: row.role as AgentRole,
    source: row.source as AgentMessageSource,
    sourceThreadId: row.source_thread_id,
    wakeId: row.wake_id,
    wakeReason: null,
    content: JSON.parse(row.content) as AgentMessageContent,
    createdAt: row.created_at
  };
}

/** The old index's query: each term by its start, quoted (a term spelled
 *  like an operator is a word). */
function buildFtsQuery(query: string): string {
  return queryTerms(query).map((term) => `"${term}"*`).join(" OR ");
}

function readableMessageSqlFilter(includeTools: boolean): string {
  // The model-only sources, excluded before the window is cut so they never
  // take a slot a visible message should have.
  const where = ["and m.role != 'system'", `and m.source not in (${MODEL_ONLY_SOURCES_SQL})`];
  if (!includeTools) where.push("and m.role != 'tool'");
  return where.join(" ");
}

/** Maps one signal onto [0, 1] across the whole result set, so its weight in
 *  scoreThreads is its real influence rather than a nominal one. */
function normalizeSpan(values: number[]): (value: number) => number {
  const finite = values.filter((value) => Number.isFinite(value));
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  // One distinct value carries no ordering information, so no group is worse
  // than any other on this signal.
  if (finite.length === 0 || hi === lo) return () => 1;
  // A value carrying no signal is contained rather than left to poison the whole
  // set: NaN propagates through every comparison once it enters the span. It
  // lands at the bottom of a real span; where the finite span is degenerate the
  // branch above has already tied every group, which distinguishes nobody.
  return (value) => (Number.isFinite(value) ? (value - lo) / (hi - lo) : 0);
}

/** Scores every group against the others in the same result set. Pure: the
 *  three signals are relative to this set, so nothing here reads the clock. */
export function scoreThreads(
  groups: Array<{ id: string; entries: SearchEntryRow[] }>
): Map<string, number> {
  const signals = groups.map((group) => {
    const ranked = group.entries.filter((entry) => entry.rank !== null && entry.rank !== undefined);
    return {
      id: group.id,
      // bm25 is negative and a better match is more negative, so the magnitude
      // of the best rank is this group's match quality. An unranked group came
      // from the LIKE fallback and carries no quality signal at all.
      quality: ranked.length > 0
        ? Math.abs(Math.min(...ranked.map((entry) => Number(entry.rank))))
        : null,
      hits: group.entries.length,
      // The "" seed cannot survive the reduce: a group exists only because a row
      // was pushed into it, and message_created_at is not null.
      newest: group.entries.reduce(
        (best, entry) => (entry.message_created_at > best ? entry.message_created_at : best),
        ""
      )
    };
  });

  const qualities = signals
    .map((signal) => signal.quality)
    .filter((quality): quality is number => quality !== null);
  const normQuality = normalizeSpan(qualities);
  // A degenerate span collapses to a constant, and a constant is free of ordering
  // effect only when *every* group shares it. Two separate reasons let quality
  // stand, so they are named separately:
  const hasComparableQualities = new Set(qualities).size > 1;
  // ...either there are two values to compare, or there is no group sitting off
  // the scale to be compared against. Where a lone ranked group shares the set
  // with unranked ones, neither holds: it would take the span's ceiling while
  // every unranked group sat at LIKE_MATCH_RELEVANCE, handing it the win whatever
  // its bm25 -- the mirror image of the free win LIKE_MATCH_RELEVANCE avoids. Applied
  // here rather than inside normalizeSpan, which hits and recency share: nothing
  // sits off *their* scales, so a degenerate span there ties every group at once.
  const everyGroupRanked = qualities.length === signals.length;
  const qualityDiscriminates = hasComparableQualities || everyGroupRanked;
  const normHits = normalizeSpan(signals.map((signal) => signal.hits));
  const normNewest = normalizeSpan(signals.map((signal) => Date.parse(signal.newest)));

  const scores = new Map<string, number>();
  for (const signal of signals) {
    const relevance = signal.quality === null || !qualityDiscriminates
      ? LIKE_MATCH_RELEVANCE
      : normQuality(signal.quality);
    scores.set(
      signal.id,
      relevance * 0.72 + normHits(signal.hits) * 0.2 + normNewest(Date.parse(signal.newest)) * 0.08
    );
  }
  return scores;
}

function capSearchResults(results: ChatHistoryThread[], maxChars: number) {
  let chars = 0;
  const capped: ChatHistoryThread[] = [];
  let truncated = false;
  for (const result of results) {
    const nextChars = JSON.stringify(result).length;
    if (chars + nextChars > maxChars) {
      truncated = true;
      break;
    }
    capped.push(result);
    chars += nextChars;
  }
  return { results: capped, charCount: chars, truncated };
}

function makeSnippet(text: string): string {
  return limitToolText(text.replace(/\s+/g, " ").trim(), 700).text;
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function historyError(code: string, message: string): Error {
  const err = new Error(`${code}: ${message}`);
  (err as Error & { code?: string }).code = code;
  return err;
}

// The search's reads: functions of a connection, so the server's thread or a
// worker of their own (history-search-away.ts) can run them.

function searchRows(db: Database, input: SearchRowQuery): SearchEntryRow[] {
  // The words index once a first pass of it has ended; the old one only
  // where there is no words index; by text in between.
  const words = historyWordsReady(db);
  const fts = words ? buildWordsQuery(input.query) : historyOldIndexInUse(db) ? buildFtsQuery(input.query) : "";
  const rows = !fts ? [] : words ? searchRowsWords(db, { ...input, fts }) : searchRowsFts(db, { ...input, fts });
  if (rows.length > 0) return rows;
  return searchRowsLike(db, input);
}

/** The words index, read within the time range's rowids: rowids run in
 *  time, so the index visits only the range's rows. */
function searchRowsWords(db: Database, input: SearchRowQuery & { fts: string }): SearchEntryRow[] {
  const filter = searchSqlFilter(input);
  const [low, high] = wordKeyBounds(input.timeRange);
  try {
    return db.prepare(`
      select e.*, bm25(agent_message_search_words) as rank
      from agent_message_search_words
      join agent_message_search_word_keys k on k.word_rowid = agent_message_search_words.rowid
      join agent_message_search_entries e indexed by idx_agent_message_search_entries_place on e.id = k.entry_id
      join agent_threads t on t.id = e.thread_id
      left join workers wk on t.scope = 'worker' and wk.id = t.scope_id
      left join projects p on p.id = wk.project_id
      where agent_message_search_words match ?
        and agent_message_search_words.rowid between ? and ?
        ${filter.where}
      order by rank asc, e.message_created_at desc
      limit ?
    `).all(input.fts, low, high, ...filter.params, input.limit) as SearchEntryRow[];
  } catch {
    return [];
  }
}

function searchRowsFts(db: Database, input: SearchRowQuery & { fts: string }): SearchEntryRow[] {
  const filter = searchSqlFilter(input);
  try {
    return db.prepare(`
      select e.*, bm25(agent_message_search_fts) as rank
      from agent_message_search_fts
      join agent_message_search_entries e on e.id = agent_message_search_fts.entry_id
      join agent_threads t on t.id = e.thread_id
      left join workers wk on t.scope = 'worker' and wk.id = t.scope_id
      left join projects p on p.id = wk.project_id
      where agent_message_search_fts match ?
        ${filter.where}
      order by rank asc, e.message_created_at desc
      limit ?
    `).all(input.fts, ...filter.params, input.limit) as SearchEntryRow[];
  } catch {
    return [];
  }
}

/** Nothing matched by word: each term looked for as text (the whole query
 *  when it has none), newest first. */
function searchRowsLike(db: Database, input: SearchRowQuery): SearchEntryRow[] {
  const terms = queryTerms(input.query);
  const found = new Map<string, SearchEntryRow>();
  for (const term of terms.length > 0 ? terms : [input.query]) {
    for (const row of searchRowsLikeText(db, input, term)) if (!found.has(row.id)) found.set(row.id, row);
  }
  return [...found.values()]
    .sort((a, b) => b.message_created_at.localeCompare(a.message_created_at))
    .slice(0, input.limit);
}

function searchRowsLikeText(db: Database, input: SearchRowQuery, text: string): SearchEntryRow[] {
  const filter = searchSqlFilter(input);
  // A text match reads each row's text: only the place's threads' rows,
  // found by thread, so another project's rows are never read.
  const place = input.projectId === null
    ? { sql: "select id from agent_threads where scope in ('manager', 'personal')", params: [] as SqlValue[] }
    : { sql: "select t.id from agent_threads t join workers w on w.id = t.scope_id where t.scope = 'worker' and w.project_id = ?", params: [input.projectId] as SqlValue[] };
  return db.prepare(`
    select e.*, null as rank
    from agent_message_search_entries e
    join agent_threads t on t.id = e.thread_id
    left join workers wk on t.scope = 'worker' and wk.id = t.scope_id
    left join projects p on p.id = wk.project_id
    where e.thread_id in (${place.sql})
      and e.content_text like ? escape '\\'
      ${filter.where}
    order by e.message_created_at desc
    limit ?
  `).all(...place.params, `%${escapeLike(text)}%`, ...filter.params, input.limit) as SearchEntryRow[];
}

function searchSqlFilter(input: Omit<SearchRowQuery, "query" | "limit">) {
  // Exactly one place, read from the message's thread: a project's worker
  // threads (their worker and project must still exist), or the threads
  // outside the projects. A worker caller's place is always its project.
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (input.projectId === null) {
    where.push("and t.scope in ('manager', 'personal')");
  } else {
    where.push("and t.scope = 'worker' and wk.project_id = ? and p.id is not null");
    params.push(input.projectId);
  }
  if (input.workerId) {
    where.push("and t.scope_id = ?");
    params.push(input.workerId);
  }
  if (input.threadId) {
    where.push("and e.thread_id = ?");
    params.push(input.threadId);
  }
  if (input.timeRange.since) {
    where.push("and e.message_created_at >= ?");
    params.push(input.timeRange.since);
  }
  if (input.timeRange.until) {
    where.push("and e.message_created_at <= ?");
    params.push(input.timeRange.until);
  }
  if (!input.includeArchived) {
    where.push("and t.archived_at is null and wk.archived_at is null and p.archived_at is null");
  }
  if (input.excludedThreads.size > 0) {
    where.push(`and e.thread_id not in (${Array.from(input.excludedThreads).map(() => "?").join(",")})`);
    params.push(...Array.from(input.excludedThreads));
  }
  return { where: ` ${where.join(" ")}`, params };
}

/** A search's reads: the task records (none when the search names a thread)
 *  and the chats, one query per scope. Cloned to a worker as they are. */
export interface SearchReads {
  records: RecordReadQuery | null;
  rows: SearchRowQuery[];
}

/** What they found: the records, and the chats' rows in the order asked. */
export interface SearchFound {
  records: ChatHistoryRecord[];
  rows: SearchEntryRow[];
}

/** Which records a caller may see: its project's, or with no project named
 *  every project's (archived ones only when asked). */
export interface RecordReadQuery {
  query: string;
  projectId: string | null;
  workerId: string | null;
  includeArchived: boolean;
  excludeWorkerId: string | null;
  since: string | null;
  until: string | null;
}

export function runSearchReads(db: Database, reads: SearchReads): SearchFound {
  return {
    records: reads.records ? searchRecordRows(db, reads.records) : [],
    rows: reads.rows.flatMap((query) => searchRows(db, query))
  };
}

function searchRecordRows(db: Database, input: RecordReadQuery): ChatHistoryRecord[] {
  const projects = db.prepare(`select id, name, archived_at from projects`).all() as Array<{ id: string; name: string; archived_at: string | null }>;
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  // A named project is checked again here: the search was planned on the
  // server's connection, and the project may have been archived since.
  const projectIds = projects
    .filter((p) => input.projectId === null || p.id === input.projectId)
    .filter((p) => input.includeArchived || !p.archived_at)
    .map((p) => p.id);
  return new WorkerRecordStore(db).search({
    query: input.query,
    projectIds,
    workerId: input.workerId,
    excludeWorkerId: input.excludeWorkerId,
    since: input.since,
    until: input.until,
    limit: RECORD_SEARCH_LIMIT
  }).map((hit) => ({
    id: hit.id,
    worker: hit.workerName,
    project: nameOf.get(hit.projectId) ?? hit.projectId,
    updated: hit.updatedAt.slice(0, 10),
    firstLine: hit.firstLine,
    lines: hit.lines
  }));
}
