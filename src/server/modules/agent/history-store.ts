import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  AgentMessage,
  AgentMessageContent,
  AgentMessageSource,
  AgentRole
} from "./agent-store.js";
import { newId } from "../../platform/ids.js";
import { redactSecrets } from "../../platform/text/text.js";
import { limitToolText } from "./tool-result-format.js";

type ChatHistoryTimePreset = "last7d" | "last30d" | "last90d" | "projectLifetime" | "all";

interface ChatHistoryTimeRangeInput {
  preset?: ChatHistoryTimePreset;
  since?: string;
  until?: string;
  reason?: string;
}

export interface ResolvedChatHistoryTimeRange {
  preset: ChatHistoryTimePreset;
  since: string | null;
  until: string | null;
  reason: string | null;
}

export interface ChatHistorySearchInput {
  callerThreadId: string;
  wakeId?: string | null;
  projectId?: string | null;
  query: string;
  featureId?: string | null;
  threadId?: string | null;
  timeRange?: ChatHistoryTimeRangeInput;
  includeArchived?: boolean;
  includeCurrentLineage?: boolean;
  limit?: number;
  snippetsPerThread?: number;
}

export interface ChatHistorySearchResult {
  project: { id: string; name: string };
  timeRange: ResolvedChatHistoryTimeRange;
  includeArchived: boolean;
  results: ChatHistoryThreadResult[];
  caps: { maxPayloadChars: number; truncated: boolean };
}

export interface ChatHistoryThreadResult {
  thread: ChatHistoryThreadMeta;
  /** Relative to the other results in this response only -- the signals behind
   *  it are normalized across the set, so it is not comparable across searches. */
  score: number;
  hitCount: number;
  hits: ChatHistoryHit[];
}

interface ChatHistoryThreadMetaBase {
  id: string;
  archivedAt: string | null;
  updatedAt: string;
}

/** A feature thread always belongs to a feature; an overview thread never does.
 *  Discriminated on `scope` so the feature arm keeps its non-null contract —
 *  a plain `string | null` would loosen it for callers that can never see null. */
export type ChatHistoryThreadMeta =
  | (ChatHistoryThreadMetaBase & { scope: "worker"; featureId: string; featureName: string })
  | (ChatHistoryThreadMetaBase & { scope: "manager"; featureId: null; featureName: null });

interface ChatHistoryHit {
  messageId: string;
  seq: number;
  role: AgentRole;
  source: AgentMessageSource;
  createdAt: string;
  snippet: string;
  redactions: string[];
  readHandle: string;
}

export interface ChatHistoryReadInput {
  callerThreadId: string;
  wakeId?: string | null;
  handle: string;
  limitBefore?: number;
  limitAfter?: number;
  includeTools?: boolean;
  maxCharsPerMessage?: number;
}

export interface ChatHistoryReadResult {
  project: { id: string; name: string };
  thread: ChatHistoryThreadMeta;
  timeRange: ResolvedChatHistoryTimeRange;
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
  project_id: string;
  feature_id: string | null;
  seq: number;
  role: string;
  source: string;
  content_text: string;
  tool_names_json: string | null;
  attachment_count: number;
  redaction_flags_json: string | null;
  message_created_at: string;
  thread_updated_at: string;
  /** bm25 from the FTS path, `null` from the LIKE path. LIKE has no notion of
   *  relevance, and `null` says so -- a numeric stand-in would be compared
   *  against real bm25 values as if it meant something. */
  rank?: number | null;
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

interface ThreadScopeRow {
  thread_id: string;
  thread_kind: string;
  scope: string;
  scope_id: string | null;
  thread_archived_at: string | null;
  thread_updated_at: string;
  feature_id: string | null;
  feature_name: string | null;
  feature_archived_at: string | null;
  project_id: string | null;
  project_name: string | null;
  project_archived_at: string | null;
}

interface HandleRow {
  id: string;
  caller_thread_id: string;
  project_id: string;
  thread_id: string;
  message_id: string;
  seq: number;
  time_preset: string;
  since: string | null;
  until: string | null;
  include_archived: number;
  reason: string | null;
  expires_at: string;
}

/** Overview threads are global — they have no project and no feature — but the
 *  index's project_id column is `not null`. This reserved value stands in for
 *  "no project". Real project ids are UUIDs, so it cannot collide. */
export const GLOBAL_HISTORY_PROJECT = "__global__";

const SEARCH_LIMIT_DEFAULT = 5;
const SEARCH_LIMIT_MAX = 10;
const SNIPPETS_PER_THREAD_DEFAULT = 2;
const SNIPPETS_PER_THREAD_MAX = 5;
const SEARCH_PAYLOAD_CHAR_CAP = 32_000;
const READ_HANDLE_TTL_MS = 24 * 60 * 60 * 1000;
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
 *  Which retrieval path answered is not a quality signal -- it is which half's
 *  tokenizer happened to match. Measured over 45 mixed-path searches, 39 had the
 *  *project* half on LIKE (unicode61 does not segment Han, so any non-initial
 *  fragment of a Chinese clause is LIKE-only). Sinking LIKE groups would
 *  systematically punish whichever half fell back; floating them to the top was
 *  the bug this replaced. 0.5 is the neutral midpoint, and needs no calibration
 *  against any corpus. */
const LIKE_MATCH_RELEVANCE = 0.5;

const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  { name: "authorization", pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: "Authorization: Bearer [redacted]" },
  { name: "api_key", pattern: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}['"]?/gi, replacement: "$1=[redacted]" },
  { name: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[redacted private key]" },
  { name: "cookie", pattern: /\b(cookie|set-cookie)\s*:\s*[^\n\r]+/gi, replacement: "$1: [redacted]" }
];

export class AgentHistoryStore {
  constructor(private db: Database) {}

  indexMessage(message: AgentMessage): void {
    indexAgentHistoryMessage(this.db, message);
  }

  backfill(): number {
    return backfillAgentHistoryIndex(this.db);
  }

  search(input: ChatHistorySearchInput): ChatHistorySearchResult {
    this.backfill();
    const caller = this.resolveCaller(input.callerThreadId);
    const projectId = resolveRequestedProjectId(caller, input.projectId);
    const project = this.getProject(projectId, Boolean(input.includeArchived));
    if (!project) throw historyError("project_not_found", "project not found or archived");

    const timeRange = withProjectLifetimeSince(resolveTimeRange(input.timeRange), project.createdAt);
    const featureId = normalizeNullable(input.featureId);
    const threadId = normalizeNullable(input.threadId);
    if (featureId) this.assertFeatureInScope(featureId, projectId, Boolean(input.includeArchived));
    // Only an overview agent may name an overview thread; a feature agent's
    // project scope can never reach one.
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
    // context. That holds for a feature agent. It does not hold for an overview
    // agent: overview history is one long-lived thread that has been compressed
    // many times, and reaching what fell out of its context is the whole point
    // of this search. Every global entry lives in that thread, so excluding it
    // would return nothing at all under default flags.
    const excludedThreads = input.includeCurrentLineage || caller.scope === "manager"
      ? new Set<string>()
      : this.currentLineage(caller.threadId);

    const rowBudget = Math.max(limit * snippetsPerThread * 3, 25);
    const rowQuery = {
      query,
      featureId,
      threadId,
      timeRange,
      includeArchived,
      excludedThreads,
      limit: rowBudget
    };
    // One ranked query per scope, each with its own full row budget. A single
    // query spanning both scopes lets whichever scope ranks higher consume the
    // whole window: overview history is one long-lived thread holding tens of
    // thousands of entries, so it can fill every row and still collapse to a
    // single result, starving the requested project's own feature threads out
    // of the answer. Two pinned queries cannot overlap -- their project_id
    // differs -- so concatenating them needs no dedup, and groupSearchRows
    // groups, scores and slices the union exactly as it does for one query.
    const rows = this.searchRows({ ...rowQuery, projectId });
    // Only an overview agent may reach the global scope. A feature agent's
    // project id never matches the sentinel, and resolveRequestedProjectId
    // refuses to let it name one. Narrowing to a feature also excludes global
    // entries by definition -- their feature_id is null -- so skip the query
    // rather than run one that cannot match. And an overview agent may name the
    // sentinel itself as the project it wants: getProject accepts it, so the
    // half above has already searched the global scope and running it again
    // would return every row twice, doubling hitCount and minting two handles
    // for one message.
    if (caller.scope === "manager" && !featureId && projectId !== GLOBAL_HISTORY_PROJECT) {
      rows.push(...this.searchRows({ ...rowQuery, projectId: GLOBAL_HISTORY_PROJECT }));
    }
    const grouped = this.groupSearchRows(rows, {
      projectId,
      timeRange,
      includeArchived,
      callerThreadId: caller.threadId,
      limit,
      snippetsPerThread,
      // The row filter has already pinned every row to a scope the caller may
      // see, so this is the second of two layers rather than the only one. Real
      // project ids are prefixed ids, never the sentinel, so an overview caller
      // is the only one this can admit a global row for.
      allowGlobal: caller.scope === "manager"
    });
    const capped = capSearchResults(grouped, SEARCH_PAYLOAD_CHAR_CAP);
    this.audit({
      callerThreadId: caller.threadId,
      wakeId: input.wakeId ?? null,
      toolName: "chat_history_search",
      projectId,
      featureId,
      targetThreadId: threadId,
      timeRange,
      query,
      resultCount: capped.results.length,
      charsReturned: capped.charCount,
      metadata: { includeArchived, truncated: capped.truncated }
    });
    return {
      project: { id: project.id, name: project.name },
      timeRange,
      includeArchived,
      results: capped.results,
      caps: { maxPayloadChars: SEARCH_PAYLOAD_CHAR_CAP, truncated: capped.truncated }
    };
  }

  read(input: ChatHistoryReadInput): ChatHistoryReadResult {
    const caller = this.resolveCaller(input.callerThreadId);
    const handle = this.getHandle(input.handle, caller.threadId);
    const timeRange = {
      preset: handle.time_preset as ChatHistoryTimePreset,
      since: handle.since,
      until: handle.until,
      reason: handle.reason
    };
    this.assertCallerAllowedProject(caller, handle.project_id);
    const project = this.getProject(handle.project_id, handle.include_archived === 1);
    if (!project) throw historyError("project_not_found", "project not found or archived");
    const threadMeta = this.assertThreadInScope(
      handle.thread_id,
      handle.project_id,
      handle.include_archived === 1,
      handle.project_id === GLOBAL_HISTORY_PROJECT
    );
    const target = this.getSearchEntryByMessage(handle.message_id);
    if (!target || target.thread_id !== handle.thread_id || target.seq !== handle.seq) {
      throw historyError("read_handle_invalid", "read handle no longer points at an indexed message");
    }
    assertWithinTimeRange(target.message_created_at, timeRange);

    const limitBefore = boundedInt(input.limitBefore, READ_LIMIT_BEFORE_DEFAULT, READ_LIMIT_MAX);
    const limitAfter = boundedInt(input.limitAfter, READ_LIMIT_AFTER_DEFAULT, READ_LIMIT_MAX);
    const maxChars = boundedInt(input.maxCharsPerMessage, READ_MESSAGE_CHAR_DEFAULT, READ_MESSAGE_CHAR_MAX);
    const includeTools = Boolean(input.includeTools);
    const rows = this.readWindow(handle.thread_id, handle.seq, limitBefore, limitAfter, timeRange, includeTools);
    const messages = rows
      .map((row) => serializeReadMessage(row, {
        includeTools,
        maxChars
      }))
      .filter((message): message is ChatHistoryReadMessage => Boolean(message));
    const firstSeq = rows[0]?.seq ?? handle.seq;
    const lastSeq = rows[rows.length - 1]?.seq ?? handle.seq;
    const hasMoreBefore = this.hasReadableMessageBefore(handle.thread_id, firstSeq, timeRange, includeTools);
    const hasMoreAfter = this.hasReadableMessageAfter(handle.thread_id, lastSeq, timeRange, includeTools);
    const truncated = messages.some((message) => message.content.truncated);
    this.audit({
      callerThreadId: caller.threadId,
      wakeId: input.wakeId ?? null,
      toolName: "chat_history_read",
      projectId: handle.project_id,
      featureId: threadMeta.featureId,
      targetThreadId: handle.thread_id,
      timeRange,
      query: null,
      resultCount: messages.length,
      charsReturned: messages.reduce((sum, message) => sum + message.content.text.length, 0),
      metadata: { handle: input.handle, includeTools, truncated }
    });
    return {
      project: { id: project.id, name: project.name },
      thread: threadMeta,
      timeRange,
      messages,
      hasMoreBefore,
      hasMoreAfter,
      caps: { maxCharsPerMessage: maxChars, truncated }
    };
  }

  private resolveCaller(threadId: string) {
    const thread = this.db.prepare(`
      select id, scope, scope_id, archived_at
      from agent_threads
      where id = ?
    `).get(threadId) as {
      id: string;
      scope: string;
      scope_id: string | null;
      archived_at: string | null;
    } | undefined;
    if (!thread) throw historyError("caller_thread_not_found", "caller thread not found");
    if (thread.scope === "worker") {
      const feature = this.db.prepare(`
        select f.id, f.project_id, f.archived_at, p.archived_at as project_archived_at
        from features f
        join projects p on p.id = f.project_id
        where f.id = ?
      `).get(thread.scope_id) as {
        id: string;
        project_id: string;
        archived_at: string | null;
        project_archived_at: string | null;
      } | undefined;
      if (!feature) throw historyError("feature_not_found", "caller feature not found");
      return {
        threadId: thread.id,
        scope: "worker" as const,
        featureId: feature.id,
        projectId: feature.project_id
      };
    }
    return {
      threadId: thread.id,
      scope: "manager" as const,
      featureId: null,
      projectId: null
    };
  }

  private assertCallerAllowedProject(
    caller: ReturnType<AgentHistoryStore["resolveCaller"]>,
    projectId: string
  ): void {
    if (caller.scope === "worker" && caller.projectId !== projectId) {
      throw historyError("project_out_of_scope", "workers can only search their own project");
    }
  }

  private getProject(projectId: string, includeArchived: boolean): { id: string; name: string; createdAt: string } | null {
    if (projectId === GLOBAL_HISTORY_PROJECT) {
      // The global scope has no projects row. Overview history belongs to no
      // project, so there is nothing to look up and nothing to archive.
      return { id: GLOBAL_HISTORY_PROJECT, name: "Overview", createdAt: new Date(0).toISOString() };
    }
    const row = this.db.prepare(`
      select id, name, created_at, archived_at
      from projects
      where id = ?
    `).get(projectId) as { id: string; name: string; created_at: string; archived_at: string | null } | undefined;
    if (!row) return null;
    if (row.archived_at && !includeArchived) return null;
    return { id: row.id, name: row.name, createdAt: row.created_at };
  }

  private assertFeatureInScope(
    featureId: string,
    projectId: string,
    includeArchived: boolean
  ): void {
    const row = this.db.prepare(`
      select id, project_id, archived_at
      from features
      where id = ?
    `).get(featureId) as { id: string; project_id: string; archived_at: string | null } | undefined;
    if (!row) throw historyError("feature_not_found", "feature not found");
    if (row.project_id !== projectId) throw historyError("feature_out_of_scope", "feature is outside project scope");
    if (row.archived_at && !includeArchived) throw historyError("archived_not_included", "feature is archived");
  }

  private assertThreadInScope(
    threadId: string,
    projectId: string,
    includeArchived: boolean,
    allowGlobal = false
  ): ChatHistoryThreadMeta {
    const row = this.threadScope(threadId);
    if (!row) throw historyError("thread_not_found", "thread not found");

    if (row.scope === "manager") {
      // An overview thread is global: it has no project or feature to match
      // against, and only the thread itself can be archived.
      if (!allowGlobal && projectId !== GLOBAL_HISTORY_PROJECT) {
        throw historyError("thread_out_of_scope", "thread is outside project scope");
      }
      if (!includeArchived && row.thread_archived_at) {
        throw historyError("archived_not_included", "thread or owner is archived");
      }
      return {
        id: row.thread_id,
        scope: "manager",
        featureId: null,
        featureName: null,
        archivedAt: row.thread_archived_at,
        updatedAt: row.thread_updated_at
      };
    }

    if (row.project_id !== projectId || !row.feature_id || !row.feature_name) {
      throw historyError("thread_out_of_scope", "thread is outside project scope");
    }
    if (
      !includeArchived
      && (row.thread_archived_at || row.feature_archived_at || row.project_archived_at)
    ) {
      throw historyError("archived_not_included", "thread or owner is archived");
    }
    return {
      id: row.thread_id,
      scope: "worker",
      featureId: row.feature_id,
      featureName: row.feature_name,
      archivedAt: row.thread_archived_at,
      updatedAt: row.thread_updated_at
    };
  }

  private threadScope(threadId: string): ThreadScopeRow | null {
    const row = this.db.prepare(`
      select
        t.id as thread_id,
        t.kind as thread_kind,
        t.scope,
        t.scope_id,
        t.archived_at as thread_archived_at,
        t.updated_at as thread_updated_at,
        f.id as feature_id,
        f.name as feature_name,
        f.archived_at as feature_archived_at,
        p.id as project_id,
        p.name as project_name,
        p.archived_at as project_archived_at
      from agent_threads t
      left join features f on f.id = t.scope_id and t.scope = 'worker'
      left join projects p on p.id = f.project_id
      where t.id = ?
    `).get(threadId) as ThreadScopeRow | undefined;
    return row ?? null;
  }

  /** One scope per call: `projectId` is either a real project or
   *  GLOBAL_HISTORY_PROJECT. The FTS-then-LIKE fallback is therefore decided
   *  per scope -- a scope with no FTS hits falls back on its own, whatever the
   *  other scope's query found. */
  private searchRows(input: {
    query: string;
    projectId: string;
    featureId: string | null;
    threadId: string | null;
    timeRange: ResolvedChatHistoryTimeRange;
    includeArchived: boolean;
    excludedThreads: Set<string>;
    limit: number;
  }): SearchEntryRow[] {
    const fts = buildFtsQuery(input.query);
    const rows = fts
      ? this.searchRowsFts({ ...input, fts })
      : [];
    if (rows.length > 0) return rows;
    return this.searchRowsLike(input);
  }

  private searchRowsFts(input: {
    query: string;
    fts: string;
    projectId: string;
    featureId: string | null;
    threadId: string | null;
    timeRange: ResolvedChatHistoryTimeRange;
    includeArchived: boolean;
    excludedThreads: Set<string>;
    limit: number;
  }): SearchEntryRow[] {
    const filter = this.searchSqlFilter(input);
    try {
      return this.db.prepare(`
        select e.*, bm25(agent_message_search_fts) as rank
        from agent_message_search_fts
        join agent_message_search_entries e on e.id = agent_message_search_fts.entry_id
        join agent_threads t on t.id = e.thread_id
        left join features f on f.id = e.feature_id
        left join projects p on p.id = e.project_id
        where agent_message_search_fts match ?
          ${filter.where}
        order by rank asc, e.message_created_at desc
        limit ?
      `).all(input.fts, ...filter.params, input.limit) as SearchEntryRow[];
    } catch {
      return [];
    }
  }

  private searchRowsLike(input: {
    query: string;
    projectId: string;
    featureId: string | null;
    threadId: string | null;
    timeRange: ResolvedChatHistoryTimeRange;
    includeArchived: boolean;
    excludedThreads: Set<string>;
    limit: number;
  }): SearchEntryRow[] {
    const filter = this.searchSqlFilter(input);
    return this.db.prepare(`
      select e.*, null as rank
      from agent_message_search_entries e
      join agent_threads t on t.id = e.thread_id
      left join features f on f.id = e.feature_id
      left join projects p on p.id = e.project_id
      where e.content_text like ? escape '\\'
        ${filter.where}
      order by e.message_created_at desc
      limit ?
    `).all(`%${escapeLike(input.query)}%`, ...filter.params, input.limit) as SearchEntryRow[];
  }

  private searchSqlFilter(input: {
    projectId: string;
    featureId: string | null;
    threadId: string | null;
    timeRange: ResolvedChatHistoryTimeRange;
    includeArchived: boolean;
    excludedThreads: Set<string>;
  }) {
    // Exactly one scope: the caller's own project, or the global scope when the
    // call site pinned the sentinel. A feature caller can never reach the
    // sentinel, so its rows stay inside its own project.
    const where: string[] = ["and e.project_id = ?"];
    const params: unknown[] = [input.projectId];
    // The joins above are LEFT so global entries survive them. Keep the old
    // INNER JOIN meaning for every other entry: it must still resolve to a real
    // project, and to a real feature. Only a global entry may have neither.
    where.push("and (e.project_id = ? or p.id is not null)");
    params.push(GLOBAL_HISTORY_PROJECT);
    where.push("and (e.project_id = ? or f.id is not null)");
    params.push(GLOBAL_HISTORY_PROJECT);
    if (input.featureId) {
      where.push("and e.feature_id = ?");
      params.push(input.featureId);
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
      where.push("and t.archived_at is null and f.archived_at is null and p.archived_at is null");
    }
    if (input.excludedThreads.size > 0) {
      where.push(`and e.thread_id not in (${Array.from(input.excludedThreads).map(() => "?").join(",")})`);
      params.push(...Array.from(input.excludedThreads));
    }
    return { where: ` ${where.join(" ")}`, params };
  }

  private groupSearchRows(
    rows: SearchEntryRow[],
    opts: {
      projectId: string;
      timeRange: ResolvedChatHistoryTimeRange;
      includeArchived: boolean;
      callerThreadId: string;
      limit: number;
      snippetsPerThread: number;
      allowGlobal: boolean;
    }
  ): ChatHistoryThreadResult[] {
    // A thread is either overview (global) or feature (its own project), so
    // every entry grouped under one thread carries the same project id.
    const groups = new Map<string, { projectId: string; entries: SearchEntryRow[] }>();
    for (const row of rows) {
      const group = groups.get(row.thread_id) ?? { projectId: row.project_id, entries: [] };
      group.entries.push(row);
      groups.set(row.thread_id, group);
    }
    // Scored against each other, so every group's signals must be in hand
    // before any score exists.
    const scores = scoreThreads(
      [...groups].map(([id, group]) => ({ id, entries: group.entries }))
    );
    const results: ChatHistoryThreadResult[] = [];
    for (const [threadId, { projectId, entries }] of groups) {
      const meta = this.assertThreadInScope(
        threadId,
        opts.projectId,
        opts.includeArchived,
        opts.allowGlobal
      );
      const sorted = entries
        .slice()
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || b.message_created_at.localeCompare(a.message_created_at));
      const hits = sorted.slice(0, opts.snippetsPerThread).map((entry) => {
        const handle = this.createHandle({
          callerThreadId: opts.callerThreadId,
          // The entry's own project, not the requested one. An overview agent
          // searching a real project can be handed a global hit, and its handle
          // has to say so or chat_history_read will refuse to open it. For every
          // other hit the filter has already pinned the two to the same value.
          projectId,
          threadId,
          messageId: entry.message_id,
          seq: entry.seq,
          timeRange: opts.timeRange,
          includeArchived: opts.includeArchived
        });
        const redactions = parseStringArray(entry.redaction_flags_json);
        return {
          messageId: entry.message_id,
          seq: entry.seq,
          role: entry.role as AgentRole,
          source: entry.source as AgentMessageSource,
          createdAt: entry.message_created_at,
          snippet: makeSnippet(entry.content_text),
          redactions,
          readHandle: handle
        };
      });
      results.push({
        thread: meta,
        score: scores.get(threadId) ?? 0,
        hitCount: entries.length,
        hits
      });
    }
    return results
      .sort((a, b) => b.score - a.score || b.thread.updatedAt.localeCompare(a.thread.updatedAt))
      .slice(0, opts.limit);
  }

  private currentLineage(threadId: string): Set<string> {
    return new Set<string>([threadId]);
  }

  private createHandle(input: {
    callerThreadId: string;
    projectId: string;
    threadId: string;
    messageId: string;
    seq: number;
    timeRange: ResolvedChatHistoryTimeRange;
    includeArchived: boolean;
  }): string {
    const id = newId("hist");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + READ_HANDLE_TTL_MS).toISOString();
    this.db.prepare(`
      insert into agent_history_read_handles
        (id, caller_thread_id, project_id, thread_id, message_id, seq,
         time_preset, since, until, include_archived, reason, created_at, expires_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.callerThreadId,
      input.projectId,
      input.threadId,
      input.messageId,
      input.seq,
      input.timeRange.preset,
      input.timeRange.since,
      input.timeRange.until,
      input.includeArchived ? 1 : 0,
      input.timeRange.reason,
      now.toISOString(),
      expiresAt
    );
    return id;
  }

  private getHandle(handleId: string, callerThreadId: string): HandleRow {
    const row = this.db.prepare(`
      select *
      from agent_history_read_handles
      where id = ? and caller_thread_id = ?
      limit 1
    `).get(handleId, callerThreadId) as HandleRow | undefined;
    if (!row) throw historyError("read_handle_not_found", "read handle not found for caller thread");
    if (row.expires_at < new Date().toISOString()) {
      throw historyError("read_handle_expired", "read handle expired");
    }
    return row;
  }

  private getSearchEntryByMessage(messageId: string): SearchEntryRow | null {
    const row = this.db.prepare(`
      select *
      from agent_message_search_entries
      where message_id = ?
      limit 1
    `).get(messageId) as SearchEntryRow | undefined;
    return row ?? null;
  }

  private readWindow(
    threadId: string,
    seq: number,
    limitBefore: number,
    limitAfter: number,
    timeRange: ResolvedChatHistoryTimeRange,
    includeTools: boolean
  ): AgentMessage[] {
    const beforeRows = this.readMessageRows(threadId, `m.seq < ?`, [seq], limitBefore, "desc", timeRange, includeTools)
      .reverse();
    const centerRows = this.readMessageRows(threadId, `m.seq = ?`, [seq], 1, "asc", timeRange, includeTools);
    const afterRows = this.readMessageRows(threadId, `m.seq > ?`, [seq], limitAfter, "asc", timeRange, includeTools);
    return [...beforeRows, ...centerRows, ...afterRows].map(rawRowToMessage);
  }

  private readMessageRows(
    threadId: string,
    seqPredicate: string,
    seqParams: unknown[],
    limit: number,
    order: "asc" | "desc",
    timeRange: ResolvedChatHistoryTimeRange,
    includeTools: boolean
  ): RawMessageRow[] {
    const timeFilter = timeRangeMessageFilter(timeRange);
    const visibilityFilter = readableMessageSqlFilter(includeTools);
    return this.db.prepare(`
      select m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id,
             m.wake_id, m.content, m.created_at
      from agent_messages m
      where m.thread_id = ?
        and ${seqPredicate}
        ${visibilityFilter}
        ${timeFilter.where}
      order by m.seq ${order}, m.created_at ${order}, m.id ${order}
      limit ?
    `).all(threadId, ...seqParams, ...timeFilter.params, limit) as RawMessageRow[];
  }

  private hasReadableMessageBefore(
    threadId: string,
    seq: number,
    timeRange: ResolvedChatHistoryTimeRange,
    includeTools: boolean
  ): boolean {
    const filter = timeRangeMessageFilter(timeRange);
    const visibilityFilter = readableMessageSqlFilter(includeTools);
    const row = this.db.prepare(`
      select id
      from agent_messages m
      where m.thread_id = ? and m.seq < ? ${visibilityFilter} ${filter.where}
      limit 1
    `).get(threadId, seq, ...filter.params) as { id: string } | undefined;
    return Boolean(row);
  }

  private hasReadableMessageAfter(
    threadId: string,
    seq: number,
    timeRange: ResolvedChatHistoryTimeRange,
    includeTools: boolean
  ): boolean {
    const filter = timeRangeMessageFilter(timeRange);
    const visibilityFilter = readableMessageSqlFilter(includeTools);
    const row = this.db.prepare(`
      select id
      from agent_messages m
      where m.thread_id = ? and m.seq > ? ${visibilityFilter} ${filter.where}
      limit 1
    `).get(threadId, seq, ...filter.params) as { id: string } | undefined;
    return Boolean(row);
  }

  private audit(input: {
    callerThreadId: string;
    wakeId: string | null;
    toolName: string;
    projectId: string;
    featureId: string | null;
    targetThreadId: string | null;
    timeRange: ResolvedChatHistoryTimeRange;
    query: string | null;
    resultCount: number;
    charsReturned: number;
    metadata: Record<string, unknown>;
  }): void {
    const redacted = input.query ? redactText(input.query) : null;
    this.db.prepare(`
      insert into agent_history_audit
        (id, caller_thread_id, wake_id, tool_name, project_id, feature_id,
         target_thread_id, time_preset, since, until, reason, query_hash,
         query_preview, result_count, chars_returned, metadata_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId("hist"),
      input.callerThreadId,
      input.wakeId,
      input.toolName,
      input.projectId,
      input.featureId,
      input.targetThreadId,
      input.timeRange.preset,
      input.timeRange.since,
      input.timeRange.until,
      input.timeRange.reason,
      input.query ? createHash("sha256").update(input.query).digest("hex") : null,
      redacted ? limitToolText(redacted.text, 240).text : null,
      input.resultCount,
      input.charsReturned,
      JSON.stringify(input.metadata),
      new Date().toISOString()
    );
  }
}

export function indexAgentHistoryMessage(db: Database, message: AgentMessage): void {
  const projection = projectMessageForHistory(db, message);
  if (!projection) {
    deleteIndexedMessage(db, message.id);
    markSkippedMessage(db, message.id);
    return;
  }
  unmarkSkippedMessage(db, message.id);
  upsertProjection(db, projection);
}

function backfillAgentHistoryIndex(db: Database): number {
  let processed = 0;
  while (processed < BACKFILL_MAX_ROWS) {
    const rows = db.prepare(`
    select m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id,
           m.wake_id, m.content, m.created_at
    from agent_messages m
    left join agent_message_search_entries e on e.message_id = m.id
    left join agent_message_search_skipped s on s.message_id = m.id
    where e.message_id is null
      and s.message_id is null
    order by m.created_at desc, m.id desc
    limit ?
  `).all(Math.min(BACKFILL_BATCH_SIZE, BACKFILL_MAX_ROWS - processed)) as RawMessageRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      const message = rawRowToMessage(row);
      try {
        indexAgentHistoryMessage(db, message);
      } catch {
        markSkippedMessage(db, message.id);
      }
    }
    processed += rows.length;
  }
  return processed;
}

function projectMessageForHistory(db: Database, message: AgentMessage): {
  id: string;
  messageId: string;
  threadId: string;
  projectId: string;
  featureId: string | null;
  seq: number;
  role: AgentRole;
  source: AgentMessageSource;
  contentText: string;
  toolNames: string[];
  attachmentCount: number;
  redactions: string[];
  createdAt: string;
  threadUpdatedAt: string;
} | null {
  const scope = threadScopeForMessage(db, message.threadId);
  if (!scope || scope.thread_kind === "side") return null;

  // A feature thread indexes under its own project. An overview thread is
  // global: it belongs to no project and no feature, so it indexes under the
  // reserved project id with a null feature. Anything else (legacy scopes) is
  // still skipped.
  let projectId: string;
  let featureId: string | null;
  if (scope.scope === "worker") {
    if (!scope.project_id || !scope.feature_id) return null;
    projectId = scope.project_id;
    featureId = scope.feature_id;
  } else if (scope.scope === "manager") {
    projectId = GLOBAL_HISTORY_PROJECT;
    featureId = null;
  } else {
    return null;
  }

  const extracted = extractHistoryText(message);
  if (!extracted || !extracted.text.trim()) return null;
  const redacted = redactText(extracted.text);
  if (!redacted.text.trim()) return null;
  return {
    id: `hidx_${message.id}`,
    messageId: message.id,
    threadId: message.threadId,
    projectId,
    featureId,
    seq: message.seq,
    role: message.role,
    source: message.source,
    contentText: redacted.text,
    toolNames: extracted.toolNames,
    attachmentCount: extracted.attachmentCount,
    redactions: Array.from(new Set([...extracted.redactions, ...redacted.flags])),
    createdAt: message.createdAt,
    threadUpdatedAt: scope.thread_updated_at
  };
}

function threadScopeForMessage(db: Database, threadId: string): ThreadScopeRow | null {
  const row = db.prepare(`
    select
      t.id as thread_id,
      t.kind as thread_kind,
      t.scope,
      t.scope_id,
      t.archived_at as thread_archived_at,
      t.updated_at as thread_updated_at,
      f.id as feature_id,
      f.name as feature_name,
      f.archived_at as feature_archived_at,
      p.id as project_id,
      p.name as project_name,
      p.archived_at as project_archived_at
    from agent_threads t
    left join features f on f.id = t.scope_id and t.scope = 'worker'
    left join projects p on p.id = f.project_id
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
        (id, message_id, thread_id, project_id, feature_id, seq, role, source,
         content_text, tool_names_json, attachment_count, redaction_flags_json,
         message_created_at, thread_updated_at, indexed_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(message_id) do update set
        thread_id = excluded.thread_id,
        project_id = excluded.project_id,
        feature_id = excluded.feature_id,
        seq = excluded.seq,
        role = excluded.role,
        source = excluded.source,
        content_text = excluded.content_text,
        tool_names_json = excluded.tool_names_json,
        attachment_count = excluded.attachment_count,
        redaction_flags_json = excluded.redaction_flags_json,
        message_created_at = excluded.message_created_at,
        thread_updated_at = excluded.thread_updated_at,
        indexed_at = excluded.indexed_at
    `).run(
      projection.id,
      projection.messageId,
      projection.threadId,
      projection.projectId,
      projection.featureId,
      projection.seq,
      projection.role,
      projection.source,
      projection.contentText,
      JSON.stringify(projection.toolNames),
      projection.attachmentCount,
      JSON.stringify(projection.redactions),
      projection.createdAt,
      projection.threadUpdatedAt,
      indexedAt
    );
  db.prepare("delete from agent_message_search_fts where entry_id = ?").run(projection.id);
  db.prepare(`
      insert into agent_message_search_fts
        (entry_id, message_id, thread_id, project_id, feature_id, role, source, content_text, tool_names)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projection.id,
      projection.messageId,
      projection.threadId,
      projection.projectId,
      projection.featureId,
      projection.role,
      projection.source,
      projection.contentText,
      projection.toolNames.join(" ")
    );
}

function deleteIndexedMessage(db: Database, messageId: string): void {
  const row = db.prepare(`
    select id
    from agent_message_search_entries
    where message_id = ?
  `).get(messageId) as { id: string } | undefined;
  if (!row) return;
  db.prepare("delete from agent_message_search_fts where entry_id = ?").run(row.id);
  db.prepare("delete from agent_message_search_entries where id = ?").run(row.id);
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
  attachmentCount: number;
  redactions: string[];
} | null {
  if (message.role === "system" || message.source === "runtime-context") {
    return null;
  }
  const content = message.content;
  switch (content.type) {
    case "text": {
      const attachmentCount = content.attachments?.length ?? 0;
      return {
        text: content.text,
        toolNames: [],
        attachmentCount,
        redactions: attachmentCount > 0 ? ["attachments_filtered"] : []
      };
    }
    case "assistant":
      return {
        text: content.text ?? "",
        toolNames: (content.toolCalls ?? []).map((call) => call.toolName),
        attachmentCount: 0,
        redactions: content.toolCalls?.length ? ["tool_args_filtered"] : []
      };
    case "summary":
      return {
        text: content.summary,
        toolNames: [],
        attachmentCount: 0,
        redactions: []
      };
    case "feature_event":
      return {
        text: `${content.label}\n${content.summary}`,
        toolNames: [],
        attachmentCount: 0,
        redactions: []
      };
    case "tool_result":
      return null;
  }
}

function serializeReadMessage(
  message: AgentMessage,
  opts: { includeTools: boolean; maxChars: number }
): ChatHistoryReadMessage | null {
  if (message.role === "system" || message.source === "runtime-context") {
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
    case "feature_event": {
      const redacted = redactText(`${content.label}\n${content.summary}`);
      const limited = limitToolText(redacted.text, opts.maxChars);
      return {
        type: "feature_event",
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
  }
}

function resolveTimeRange(input: ChatHistoryTimeRangeInput | undefined): ResolvedChatHistoryTimeRange {
  const preset = input?.preset ?? "last90d";
  if (!isTimePreset(preset)) throw historyError("time_range_invalid", "unknown time range preset");
  const until = normalizeIso(input?.until, "until");
  let since = normalizeIso(input?.since, "since");
  const now = new Date();
  const presetSince = relativePresetSince(preset, now);
  if (presetSince) {
    since = since && since > presetSince ? since : presetSince;
  }
  const reason = normalizeNullable(input?.reason);
  if (preset === "all" && !reason) {
    throw historyError("all_time_reason_required", "timeRange preset all requires a reason");
  }
  if (since && until && since > until) {
    throw historyError("time_range_invalid", "timeRange since must be before until");
  }
  return { preset, since, until, reason };
}

function relativePresetSince(preset: ChatHistoryTimePreset, now: Date): string | null {
  if (preset === "last7d") return new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  if (preset === "last30d") return new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
  if (preset === "last90d") return new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
  return null;
}

function withProjectLifetimeSince(
  timeRange: ResolvedChatHistoryTimeRange,
  projectCreatedAt: string
): ResolvedChatHistoryTimeRange {
  if (timeRange.preset !== "projectLifetime") return timeRange;
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
  const normalized = normalizeNullable(value);
  if (!normalized) return null;
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) throw historyError("time_range_invalid", `${field} must be an ISO timestamp`);
  return new Date(time).toISOString();
}

function resolveRequestedProjectId(
  caller: { scope: "worker" | "manager"; projectId: string | null },
  requested: string | null | undefined
): string {
  const normalized = normalizeNullable(requested);
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
  if (!normalized) {
    throw historyError("project_required", "manager chat history search requires projectId");
  }
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

function buildFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim().replace(/"/g, ""))
    .filter((token) => token.length > 0)
    .slice(0, 12);
  return tokens.map((token) => `${token}*`).join(" OR ");
}

function timeRangeMessageFilter(timeRange: ResolvedChatHistoryTimeRange) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (timeRange.since) {
    where.push("and m.created_at >= ?");
    params.push(timeRange.since);
  }
  if (timeRange.until) {
    where.push("and m.created_at <= ?");
    params.push(timeRange.until);
  }
  return { where: where.join(" "), params };
}

function readableMessageSqlFilter(includeTools: boolean): string {
  const where = ["and m.role != 'system'", "and m.source != 'runtime-context'"];
  if (!includeTools) where.push("and m.role != 'tool'");
  return where.join(" ");
}

function assertWithinTimeRange(createdAt: string, timeRange: ResolvedChatHistoryTimeRange): void {
  if (timeRange.since && createdAt < timeRange.since) {
    throw historyError("read_handle_out_of_range", "read handle is outside its search time range");
  }
  if (timeRange.until && createdAt > timeRange.until) {
    throw historyError("read_handle_out_of_range", "read handle is outside its search time range");
  }
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
  // its bm25 -- the mirror image of the free win this scorer replaced. Applied
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

function capSearchResults(results: ChatHistoryThreadResult[], maxChars: number) {
  let chars = 0;
  const capped: ChatHistoryThreadResult[] = [];
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

function redactText(text: string): { text: string; flags: string[] } {
  let output = text;
  const flags: string[] = [];
  const platformRedacted = redactSecrets(output);
  if (platformRedacted !== output) {
    flags.push("secret");
    output = platformRedacted;
  }
  for (const rule of SENSITIVE_PATTERNS) {
    if (rule.pattern.test(output)) {
      flags.push(rule.name);
      output = output.replace(rule.pattern, rule.replacement);
    }
    rule.pattern.lastIndex = 0;
  }
  return { text: output, flags: Array.from(new Set(flags)) };
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function normalizeNullable(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function historyError(code: string, message: string): Error {
  const err = new Error(`${code}: ${message}`);
  (err as Error & { code?: string }).code = code;
  return err;
}
