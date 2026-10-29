import type { Database } from "bun:sqlite";
import type {
  ActiveWakeDto,
  AgentContextUsageDto,
  AgentMessageDto,
  AgentScope,
  AgentThreadDto,
  AgentWakeDto,
  AgentWakeMetadata,
  AgentWakeReason,
  AgentWakeStatus
} from "../../../shared/api-contracts.js";
import type {
  AgentRole,
  AgentMessageSource,
  AgentMessageContent,
  WakeFailureContent
} from "../../../shared/agent-message-types.js";
import {
  ASK_TOOL, WITHDRAW_TOOL, skippedOf, withoutQueuedAnswers,
  type AnsweredQuestion, type OpenQuestion, type QueuedAnswer, type QuestionRow
} from "../../../shared/questions.js";
import { newId } from "../../platform/ids.js";
import { NOT_IDLE_SUMMARY } from "../../platform/db/activity-sql.js";
import { QuestionIndex } from "./question-index.js";
import { subagentTaskOf, type SubagentTaskMetadata } from "../../../shared/subagent-task.js";
import { indexAgentHistoryMessage } from "./history-store.js";
import { discardRecovery, pendingWakeRecovery, recoverInterruptedWakes } from "./wake-recovery.js";

export type {
  AgentScope,
  AgentWakeReason,
  AgentWakeStatus
} from "../../../shared/api-contracts.js";
export type AgentThread = AgentThreadDto;
export type AgentMessage = AgentMessageDto;
export type AgentWake = AgentWakeDto;
export type AgentContextUsage = AgentContextUsageDto;
type AgentMailboxStatus = "queued" | "delivered";

export interface AgentMailboxItem {
  id: string;
  threadId: string;
  role: AgentRole;
  source: AgentMessageSource;
  sourceThreadId: string | null;
  content: AgentMessageContent;
  triggerTurn: boolean;
  status: AgentMailboxStatus;
  wakeId: string | null;
  deliveredMessageId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

interface RawThread {
  id: string;
  scope: string;
  scope_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  title: string | null;
  seen_seq: number;
}

const THREAD_COLUMNS = `id, scope, scope_id,
  created_at, updated_at, archived_at, title, seen_seq`;

/** A message row with the reason, metadata, start and status of the wake it
 *  belongs to; every query reads `agent_messages m left join agent_wakes w`. */
/** A wake's failure row, read through the failure-only index: a long clean
 *  wake has thousands of rows and none of them is a failure. */
export const WAKE_FAILURE_STATUS_SQL = `select json_extract(content, '$.status') as status from agent_messages
  where wake_id = ? and source = 'wake-failure' order by seq desc limit 1`;

const MESSAGE_COLUMNS = `m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id, m.wake_id,
  w.reason as wake_reason, w.metadata_json as wake_metadata_json, w.started_at as wake_started_at,
  w.status as wake_status, m.content, m.created_at`;

const WAKE_COLUMNS = `id, thread_id, reason, trigger_message_id, status, step_count,
  error_message, metadata_json, started_at, finished_at`;

const MAILBOX_COLUMNS = `id, thread_id, role, source, source_thread_id, content,
  trigger_turn, status, wake_id, delivered_message_id,
  created_at, delivered_at`;

function toThread(r: RawThread): AgentThread {
  return {
    id: r.id,
    scope: r.scope as AgentScope,
    scopeId: r.scope_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
    title: r.title ?? null,
    seenSeq: r.seen_seq ?? 0
  };
}

export type {
  AgentRole,
  AgentMessageSource,
  AgentMessageContent,
  AgentMessageAttachment,
  AssistantContent,
  ToolCall
} from "../../../shared/agent-message-types.js";

interface AppendMessageInput {
  threadId: string;
  role: AgentRole;
  source: AgentMessageSource;
  content: AgentMessageContent;
  sourceThreadId?: string | null;
  wakeId?: string | null;
  /** When set, insert with this exact seq. */
  seq?: number;
}

interface RawMessage {
  id: string;
  thread_id: string;
  seq: number;
  role: string;
  source: string;
  source_thread_id: string | null;
  wake_id: string | null;
  wake_reason?: string | null;
  wake_started_at?: string | null;
  wake_status?: string | null;
  wake_metadata_json?: string | null;
  content: string;
  created_at: string;
}

interface RawWake {
  id: string;
  thread_id: string;
  reason: string;
  trigger_message_id: string | null;
  status: string;
  step_count: number;
  error_message: string | null;
  metadata_json: string | null;
  started_at: string;
  finished_at: string | null;
}

interface RawMailbox {
  id: string;
  thread_id: string;
  role: string;
  source: string;
  source_thread_id: string | null;
  content: string;
  trigger_turn: number;
  status: string;
  wake_id: string | null;
  delivered_message_id: string | null;
  created_at: string;
  delivered_at: string | null;
}

interface RawCompressionSummaryCursor {
  seq: number;
  content: string;
  created_at: string;
}

function toWake(r: RawWake): AgentWake {
  return {
    id: r.id,
    threadId: r.thread_id,
    reason: r.reason as AgentWakeReason,
    triggerMessageId: r.trigger_message_id,
    status: r.status as AgentWakeStatus,
    stepCount: r.step_count,
    errorMessage: r.error_message,
    metadata: parseWakeMetadata(r.metadata_json),
    startedAt: r.started_at,
    finishedAt: r.finished_at
  };
}

function toMailboxItem(r: RawMailbox): AgentMailboxItem {
  return {
    id: r.id,
    threadId: r.thread_id,
    role: r.role as AgentRole,
    source: r.source as AgentMessageSource,
    sourceThreadId: r.source_thread_id,
    content: JSON.parse(r.content) as AgentMessageContent,
    triggerTurn: r.trigger_turn === 1,
    status: r.status as AgentMailboxStatus,
    wakeId: r.wake_id,
    deliveredMessageId: r.delivered_message_id,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at
  };
}

function toMessage(r: RawMessage): AgentMessage {
  return {
    id: r.id,
    threadId: r.thread_id,
    seq: r.seq,
    role: r.role as AgentRole,
    source: r.source as AgentMessageSource,
    sourceThreadId: r.source_thread_id,
    wakeId: r.wake_id,
    wakeReason: r.wake_reason ? (r.wake_reason as AgentWakeReason) : null,
    wakeMetadata: parseWakeMetadata(r.wake_metadata_json ?? null),
    wakeStartedAt: r.wake_started_at ?? null,
    ...(r.wake_status === "canceled" ? { wakeInterrupted: true } : {}),
    content: JSON.parse(r.content) as AgentMessageContent,
    createdAt: r.created_at
  };
}

export class AgentStore {
  private managerThreadCreated = new Set<(thread: AgentThread) => void>();
  private readonly questionIndex = new QuestionIndex(this);
  private queuedAnswers: (threadId: string) => QueuedAnswer[] = () => [];

  constructor(private db: Database) {}

  /** One write: all of it or none (inside another, a part of that one). */
  transaction<T>(write: () => T): T {
    return this.db.inTransaction ? write() : this.db.transaction(write).immediate();
  }

  /** Every manager thread this store opens, whichever path opened it (a
   *  worker created without one, an adopted project, a fallback): a client
   *  learns of a thread only when it is published. */
  onManagerThreadCreated(listener: (thread: AgentThread) => void): () => void {
    this.managerThreadCreated.add(listener);
    return () => { this.managerThreadCreated.delete(listener); };
  }

  getThreadById(id: string): AgentThread | null {
    const r = this.db
      .prepare(
        `select ${THREAD_COLUMNS}
       from agent_threads where id = ?`
      )
      .get(id) as RawThread | undefined;
    return r ? toThread(r) : null;
  }

  /** The model a thread was switched to (`provider/model`); null: its route's. */
  threadModelOverride(threadId: string): string | null {
    const row = this.db.prepare(`select model_override from agent_threads where id = ?`).get(threadId) as { model_override: string | null } | undefined;
    return row?.model_override ?? null;
  }

  /** Sets or clears it; false when the thread is gone. */
  setThreadModelOverride(threadId: string, modelRef: string | null): boolean {
    return this.db.prepare(`update agent_threads set model_override = ? where id = ?`).run(modelRef, threadId).changes > 0;
  }

  /** The newest thread of a worker, archived or not: an archived
   *  worker's conversation is archived with it. */
  latestMainThreadId(scope: "worker", scopeId: string): string | null {
    const r = this.db.prepare(
      `select id from agent_threads
        where scope = ? and scope_id = ?
        order by created_at desc, rowid desc limit 1`
    ).get(scope, scopeId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** The open global-agent thread, or null before its first use. */
  openGlobalThread(): AgentThread | null {
    const r = this.db.prepare(
      `select ${THREAD_COLUMNS} from agent_threads
        where scope = 'global' and archived_at is null limit 1`
    ).get() as RawThread | undefined;
    return r ? toThread(r) : null;
  }

  /** The one global-agent thread, created on first use. Never published as a
   *  manager thread: it is not one. */
  getOrCreateGlobalThread(): AgentThread {
    const existing = this.openGlobalThread();
    if (existing) return existing;
    const id = newId("thr");
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        `insert into agent_threads (id, scope, scope_id, created_at, updated_at)
         values (?, 'global', null, ?, ?)`
      ).run(id, now, now);
    } catch {
      // A concurrent create won the singleton index; take its thread.
      const winner = this.openGlobalThread();
      if (winner) return winner;
      throw new Error("failed to create or find the global thread");
    }
    return this.getThreadById(id)!;
  }

  /** Returns the main (user-facing) thread for a scope+scopeId, or null. */
  getThreadByScope(scope: AgentScope, scopeId: string | null): AgentThread | null {
    if (scope === "global") return this.openGlobalThread();
    // Test shim: there is no single manager thread any more.
    // Production code calls latestManagerThread() or addresses a thread by id;
    // tests/manager-thread-residue.test.ts keeps it that way.
    if (scope === "manager") return this.latestOpenManagerThread();
    const r = this.db
      .prepare(
        `select ${THREAD_COLUMNS}
       from agent_threads
       where scope = ? and scope_id is ?
         and archived_at is null`
      )
      .get(scope, scopeId) as RawThread | undefined;
    return r ? toThread(r) : null;
  }

  getOrCreateThread(scope: AgentScope, scopeId: string | null): AgentThread {
    if (scope === "global") return this.getOrCreateGlobalThread();
    if (scope === "manager") return this.latestManagerThread();
    const existing = this.getThreadByScope(scope, scopeId);
    if (existing) return existing;
    const id = newId("thr");
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `insert into agent_threads (id, scope, scope_id, created_at, updated_at)
         values (?, ?, ?, ?, ?)`
        )
        .run(id, scope, scopeId, now, now);
    } catch {
      // Concurrent create lost the unique-index race; re-fetch.
      const winner = this.getThreadByScope(scope, scopeId);
      if (winner) return winner;
      throw new Error(`failed to create or find thread for ${scope}/${scopeId}`);
    }
    return this.getThreadById(id)!;
  }

  listOpenManagerThreads(): AgentThread[] {
    const rows = this.db.prepare(
      `select ${THREAD_COLUMNS} from agent_threads
        where scope = 'manager' and archived_at is null
        order by created_at asc, rowid asc`
    ).all() as RawThread[];
    return rows.map(toThread);
  }

  /** Newest archived first. */
  listArchivedManagerThreads(): AgentThread[] {
    const rows = this.db.prepare(
      `select ${THREAD_COLUMNS} from agent_threads
        where scope = 'manager' and archived_at is not null
        order by archived_at desc, rowid desc`
    ).all() as RawThread[];
    return rows.map(toThread);
  }

  /** The open manager thread the user last wrote in; the newest one when
   *  nobody has written yet; null when none is open. "Last" is insertion
   *  order (rowid), not the timestamp: two writes in one millisecond tie on
   *  created_at, and the later one must win. Creates nothing. */
  latestOpenManagerThread(): AgentThread | null {
    const r = this.db.prepare(
      `select ${THREAD_COLUMNS} from agent_threads t
        where t.scope = 'manager' and t.archived_at is null
        order by coalesce((
          select max(m.rowid) from agent_messages m
           where m.thread_id = t.id and m.role = 'user' and m.source = 'user'
        ), -1) desc, t.created_at desc, t.rowid desc
        limit 1`
    ).get() as RawThread | undefined;
    return r ? toThread(r) : null;
  }

  /** Where a message goes when nobody named a thread: voice started with no
   *  thread open, a report whose owner is gone. When no thread is open it
   *  opens an ordinary one — titled `titleIfNew` when the caller has a name
   *  for it (a report names it after its worker), untitled otherwise (the
   *  manager names it). */
  latestManagerThread(titleIfNew: string | null = null): AgentThread {
    return this.latestOpenManagerThread() ?? this.createManagerThread(titleIfNew);
  }

  /** A title the server picks (a worker's or a project's name) is the
   *  manager's to rename; one the user asked for is not. */
  createManagerThread(title: string | null = null, { titleByUser = false }: { titleByUser?: boolean } = {}): AgentThread {
    const id = newId("thr");
    const now = new Date().toISOString();
    this.db.prepare(
      `insert into agent_threads (id, scope, scope_id, title, title_by_user, created_at, updated_at)
       values (?, 'manager', null, ?, ?, ?, ?)`
    ).run(id, title, title !== null && titleByUser ? 1 : 0, now, now);
    const thread = this.getThreadById(id)!;
    for (const listener of this.managerThreadCreated) listener(thread);
    return thread;
  }

  /** A subagent's thread: scope "subagent", its task's id as scope id;
   *  never published as a manager thread. Which conversation it works
   *  for is its task's (background_tasks.parent_thread_id): threads carry no
   *  parent link. One thread per task (the open-thread index). */
  createSubagentThread(taskId: string): AgentThread {
    const id = newId("thr");
    const now = new Date().toISOString();
    this.db.prepare(
      `insert into agent_threads (id, scope, scope_id, created_at, updated_at)
       values (?, 'subagent', ?, ?, ?)`
    ).run(id, taskId, now, now);
    return this.getThreadById(id)!;
  }

  /** The user's title: it always wins, and from then on it stays. */
  setThreadTitle(id: string, title: string): void {
    this.db.prepare(`update agent_threads set title = ?, title_by_user = 1, updated_at = ? where id = ?`)
      .run(title, new Date().toISOString(), id);
  }

  /** The agent names a thread, or renames it when its task changed: never
   *  over a title the user set. Null when there is no such thread. */
  nameThreadByAgent(id: string, title: string):
    | { kind: "named" | "renamed"; previous: string | null }
    | { kind: "same" }
    | { kind: "user"; title: string }
    | null {
    const row = this.db.prepare(`select title, title_by_user from agent_threads where id = ?`)
      .get(id) as { title: string | null; title_by_user: number } | null;
    if (!row) return null;
    if (row.title_by_user && row.title !== null) return { kind: "user", title: row.title };
    if (row.title === title) return { kind: "same" };
    this.db.prepare(`update agent_threads set title = ?, updated_at = ? where id = ?`)
      .run(title, new Date().toISOString(), id);
    return { kind: row.title === null ? "named" : "renamed", previous: row.title };
  }

  /** Only moves forward: a stale tab cannot un-see what another tab saw. */
  markThreadSeen(id: string, seq: number): void {
    this.db.prepare(`update agent_threads set seen_seq = max(seen_seq, ?) where id = ?`)
      .run(Math.max(0, Math.floor(seq)), id);
  }

  /** How many tool calls a thread's turns have made: a subagent's steps. */
  countToolCalls(threadId: string): number {
    const row = this.db.prepare(
      `select coalesce(sum(json_array_length(content, '$.toolCalls')), 0) as n from agent_messages
        where thread_id = ? and role = 'assistant' and json_extract(content, '$.type') = 'assistant'`
    ).get(threadId) as { n: number } | null;
    return row?.n ?? 0;
  }

  /** Seq of the newest message a person wrote (typed or spoken); 0 if none. */
  latestPersonMessageSeq(threadId: string): number {
    const row = this.db.prepare(
      `select max(seq) as seq from agent_messages
        where thread_id = ? and role = 'user' and source in ('user', 'voice')`
    ).get(threadId) as { seq: number | null } | null;
    return row?.seq ?? 0;
  }

  /** The newest message before `seq` that a person wrote (typed or spoken)
   *  or Your agent sent for them (its content carries the relay). */
  latestPersonMessageBefore(threadId: string, seq: number): AgentMessage | null {
    const row = this.db.prepare(
      `select ${MESSAGE_COLUMNS}
       from agent_messages m
       left join agent_wakes w on w.id = m.wake_id
       where m.thread_id = ? and m.seq < ? and m.role = 'user' and m.source in ('user', 'voice')
       order by m.seq desc
       limit 1`
    ).get(threadId, seq) as RawMessage | null;
    return row ? toMessage(row) : null;
  }

  /** Where the round before `beforeSeq` of the turn `wakeId` began: the seq
   *  of the thread's previous turn's newest message (an assistant message of
   *  another wake, or of none — a reply written outside a wake ends its own
   *  round); 0 when there was none. The user's round is one they spoke in
   *  after it. */
  roundStartSeq(threadId: string, beforeSeq: number, wakeId: string | null): number {
    const row = this.db.prepare(
      `select max(seq) as seq from agent_messages
        where thread_id = ? and seq < ? and role = 'assistant' and (wake_id is null or wake_id is not ?)`
    ).get(threadId, beforeSeq, wakeId) as { seq: number | null } | null;
    return row?.seq ?? 0;
  }

  /** What the user said in the round the reply at `replySeq` ends: the
   *  texts of their own messages, typed or spoken and none Your agent relayed,
   *  after the round began (roundStartSeq) and before the reply, oldest
   *  first; an empty one (an attachment alone) is left out. */
  userWordsInRound(threadId: string, replySeq: number): string[] {
    const reply = this.db.prepare(`select wake_id from agent_messages where thread_id = ? and seq = ?`)
      .get(threadId, replySeq) as { wake_id: string | null } | null;
    const start = this.roundStartSeq(threadId, replySeq, reply?.wake_id ?? null);
    const rows = this.db.prepare(
      `select json_extract(content, '$.text') as text
         from agent_messages
        where thread_id = ? and seq > ? and seq < ? and role = 'user' and source in ('user', 'voice')
          and json_extract(content, '$.type') = 'text'
          and json_extract(content, '$.relay') is null
        order by seq`
    ).all(threadId, start, replySeq) as Array<{ text: string | null }>;
    return rows.map((row) => (row.text ?? "").trim()).filter(Boolean);
  }

  /** A transaction is open on this connection: what is read now may be rolled back. */
  uncommitted(): boolean {
    return this.db.inTransaction;
  }

  /** Seq of the conversation's newest row; 0 for an empty one. */
  lastSeq(threadId: string): number {
    const row = this.db.prepare(`select max(seq) as seq from agent_messages where thread_id = ?`).get(threadId) as { seq: number | null } | null;
    return row?.seq ?? 0;
  }

  /** The rows after `seq` that can open or close a question, oldest first:
   *  the messages on the user's side that name what they answer or keep what
   *  they closed under an earlier rule, and the tool results that name one of
   *  the two question tools. The filter only narrows; the fold decides. */
  questionRowsAfter(threadId: string, seq: number): Array<QuestionRow & { seq: number }> {
    const rows = this.db.prepare(
      `select seq, role, source, content, created_at from agent_messages
        where thread_id = ? and seq > ?
          and ((role = 'user' and (json_type(content, '$.metadata.answers') = 'array'
                                   or json_type(content, '$.metadata.closedQuestions') = 'array'))
               or (role = 'tool' and (instr(content, '"${ASK_TOOL}"') > 0 or instr(content, '"${WITHDRAW_TOOL}"') > 0)))
        order by seq asc`
    ).all(threadId, seq) as Array<{ seq: number; role: string; source: string; content: string; created_at: string }>;
    return rows.map((r) => ({
      seq: r.seq,
      role: r.role as AgentRole,
      source: r.source as AgentMessageSource,
      content: JSON.parse(r.content) as AgentMessageContent,
      createdAt: r.created_at
    }));
  }

  /** Where the answers come from that the user gave while this conversation's
   *  turn ran: accepted, and not yet rows. */
  setQueuedAnswers(source: (threadId: string) => QueuedAnswer[]): void {
    this.queuedAnswers = source;
  }

  /** The questions asked of the user in a conversation and not yet answered
   *  or taken back. An answer counts from the moment it was accepted: what
   *  waits behind the conversation's running turn is read as it will be once
   *  it lands. */
  openQuestions(threadId: string): OpenQuestion[] {
    const skipped = this.queuedSkips(threadId);
    return withoutQueuedAnswers(this.questionIndex.open(threadId), this.queuedAnswers(threadId))
      .filter((question) => !skipped.has(question.id));
  }

  /** The questions skipped while the conversation's turn ran: the row that
   *  says so waits in its mailbox for the turn's next step. */
  private queuedSkips(threadId: string): Set<string> {
    const rows = this.db.prepare(
      `select content from agent_mailbox
        where thread_id = ? and status = 'queued' and source = 'question-skip'`
    ).all(threadId) as Array<{ content: string }>;
    return new Set(rows.flatMap((row) => skippedOf({ role: "user", source: "question-skip", content: JSON.parse(row.content) as AgentMessageContent })));
  }

  /** The questions open in a conversation's rows now that are not among
   *  `stood`: what a message that waited lands after without answering. */
  questionsAskedSince(threadId: string, stood: ReadonlySet<string>): AnsweredQuestion[] {
    return this.questionIndex.open(threadId)
      .filter((question) => !stood.has(question.id))
      .map((question) => ({ id: question.id, question: question.question }));
  }

  /** The thread's latest end-of-turn reply: its newest assistant row with
   *  words, no tool call, and not words its turn went on after (endTurn
   *  false), among its last 20 assistant rows. */
  latestReply(threadId: string): AgentMessage | null {
    const rows = this.db.prepare(
      `select ${MESSAGE_COLUMNS}
       from agent_messages m
       left join agent_wakes w on w.id = m.wake_id
       where m.thread_id = ? and m.role = 'assistant'
       order by m.seq desc
       limit 20`
    ).all(threadId) as RawMessage[];
    for (const row of rows) {
      const message = toMessage(row);
      const content = message.content;
      if (content.type === "assistant" && content.text?.trim() && !content.toolCalls?.length && content.endTurn !== false) return message;
    }
    return null;
  }

  /** Seq of the newest row a person reads: assistant text, a worker's report
   *  to its manager, or a notice to the global agent that something it
   *  waited on stopped (its turn may then say nothing). Walks back from the
   *  end, so it stops early. "Text" is decided by JavaScript's trim(), as the
   *  chat decides it (SQLite's trim keeps Unicode spaces such as U+00A0).
   *  Stopping early leaves the statement mid-read, and bun:sqlite resets it
   *  only when it is finalized: until then the connection keeps a read
   *  snapshot, and every write after another connection's commit (an agent
   *  running sqlite3) fails SQLITE_BUSY_SNAPSHOT. So it is finalized here. */
  lastVisibleSeq(threadId: string): number {
    const statement = this.db.prepare(
      `select seq, source, json_extract(content, '$.text') as text from agent_messages
        where thread_id = ? and (source in ('worker-report', 'thread-notice') or role = 'assistant')
        order by seq desc`
    );
    try {
      for (const r of statement.iterate(threadId) as Iterable<{ seq: number; source: string; text: unknown }>) {
        if (r.source === "worker-report" || (typeof r.text === "string" && r.text.trim())) return r.seq;
      }
      return 0;
    } finally {
      statement.finalize();
    }
  }

  /** How a wake's failure row says it ended (cut_off on a wake whose own
   *  status is finished), or null when it left none. */
  wakeFailureStatus(wakeId: string): WakeFailureContent["status"] | null {
    const r = this.db.prepare(WAKE_FAILURE_STATUS_SQL).get(wakeId) as { status: unknown } | undefined;
    const status = r?.status;
    return status === "error" || status === "stuck" || status === "cut_off" ? status : null;
  }

  /** The thread's newest message's time; an idle compaction's summary is
   *  not activity (it moves no thread up the list). */
  lastActivityAt(threadId: string): string | null {
    const r = this.db.prepare(
      `select created_at from agent_messages where thread_id = ? and ${NOT_IDLE_SUMMARY} order by seq desc limit 1`
    ).get(threadId) as { created_at: string } | undefined;
    return r?.created_at ?? null;
  }

  /** When a worker in the project last had a message, archived workers too;
   *  null when none has. */
  lastWorkerMessageAtInProject(projectId: string): string | null {
    const r = this.db.prepare(`
      select max((select m.created_at from agent_messages m where m.thread_id = t.id and ${NOT_IDLE_SUMMARY} order by m.seq desc limit 1)) as at
      from agent_threads t
      join features f on f.id = t.scope_id
      where t.scope = 'worker' and f.project_id = ?
    `).get(projectId) as { at: string | null } | undefined;
    return r?.at ?? null;
  }

  /** What a subagent's thread was handed with its task (its first
   *  message's metadata), or null. */
  subagentTaskOfThread(threadId: string): SubagentTaskMetadata | null {
    const r = this.db.prepare(
      `select content from agent_messages where thread_id = ? and source = 'subagent-task' order by seq asc limit 1`
    ).get(threadId) as { content: string } | undefined;
    if (!r) return null;
    try {
      return subagentTaskOf(JSON.parse(r.content) as AgentMessageContent);
    } catch {
      return null;
    }
  }

  /** First non-empty line of the first message the user wrote. */
  firstUserLine(threadId: string): string | null {
    const r = this.db.prepare(
      `select json_extract(content, '$.text') as text from agent_messages
        where thread_id = ? and role = 'user' and source = 'user'
        order by seq asc limit 1`
    ).get(threadId) as { text: string | null } | undefined;
    const line = (r?.text ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    return line ?? null;
  }

  getSystemMessage(threadId: string): AgentMessage | null {
    const r = this.db
      .prepare(
        `select ${MESSAGE_COLUMNS}
       from agent_messages m
       left join agent_wakes w on w.id = m.wake_id
       where m.thread_id = ? and m.role = 'system' and m.source = 'self'
       order by m.seq asc, m.created_at asc, m.id asc
       limit 1`
      )
      .get(threadId) as RawMessage | undefined;
    return r ? toMessage(r) : null;
  }

  ensureSystemMessage(threadId: string, text: string): AgentMessage | null {
    const content = text.trim();
    if (!content) return null;
    const existing = this.getSystemMessage(threadId);
    if (existing) {
      if (existing.content.type === "text" && existing.content.text === content) {
        return existing;
      }
      // The prompt template changed since this thread was created. Templates
      // are static (dynamic state travels via runtime context), so a
      // difference means a shipped policy/prompt upgrade — replace in place
      // so long-lived threads pick it up at their next wake instead of
      // staying frozen on the old text forever.
      this.db
        .prepare("update agent_messages set content = ? where id = ?")
        .run(JSON.stringify({ type: "text", text: content }), existing.id);
      return this.getSystemMessage(threadId);
    }
    return this.appendMessage({
      threadId,
      role: "system",
      source: "self",
      seq: 0,
      content: { type: "text", text: content }
    });
  }

  archiveThread(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `update agent_threads set archived_at = ?, updated_at = ?
       where id = ? and archived_at is null`
      )
      .run(now, now, id);
  }

  restoreMainThread(scope: AgentScope, scopeId: string | null): AgentThread | null {
    const existing = this.getThreadByScope(scope, scopeId);
    if (existing) return existing;
    const archived = this.db
      .prepare(
        `select ${THREAD_COLUMNS}
       from agent_threads
       where scope = ? and scope_id is ?
         and archived_at is not null
       order by archived_at desc, updated_at desc, created_at desc
       limit 1`
      )
      .get(scope, scopeId) as RawThread | undefined;
    if (!archived) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(`update agent_threads set archived_at = NULL, updated_at = ? where id = ?`)
      .run(now, archived.id);
    return this.getThreadById(archived.id);
  }

  appendMessage(input: AppendMessageInput): AgentMessage {
    const id = newId("msg");
    const now = new Date().toISOString();
    let seq: number;
    if (input.seq !== undefined) {
      seq = input.seq;
    } else {
      const seqRow = this.db
        .prepare(`select coalesce(max(seq), 0) + 1 as next from agent_messages where thread_id = ?`)
        .get(input.threadId) as { next: number };
      seq = seqRow.next;
    }
    this.db
      .prepare(
        `insert into agent_messages
        (id, thread_id, seq, role, source, source_thread_id, wake_id, content, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.threadId,
        seq,
        input.role,
        input.source,
        input.sourceThreadId ?? null,
        input.wakeId ?? null,
        JSON.stringify(input.content),
        now
      );
    const message = this.getMessageById(id)!;
    try {
      indexAgentHistoryMessage(this.db, message);
    } catch {
      // History search is best-effort; search-time backfill repairs misses.
    }
    return message;
  }

  getMessageById(id: string): AgentMessage | null {
    const r = this.db
      .prepare(
        `select ${MESSAGE_COLUMNS}
       from agent_messages m
       left join agent_wakes w on w.id = m.wake_id
       where m.id = ?`
      )
      .get(id) as RawMessage | undefined;
    return r ? toMessage(r) : null;
  }

  getActiveMessages(threadId: string): AgentMessage[] {
    const ownSummary = this.getLatestCompressionSummary(threadId);
    return this.getOwnActiveMessages(
      threadId,
      ownSummary?.seq ?? null,
      retainedFromSummaryRow(ownSummary)
    );
  }

  private getOwnActiveMessages(
    threadId: string,
    lastSummarySeq: number | null,
    retained: Array<{ id: string; truncatedText?: string }> = []
  ): AgentMessage[] {
    const columns = MESSAGE_COLUMNS;
    const order = `order by m.seq asc, m.created_at asc, m.id asc`;
    if (lastSummarySeq === null) {
      const rows = this.db.prepare(
        `select ${columns}
           from agent_messages m
           left join agent_wakes w on w.id = m.wake_id
           where m.thread_id = ? and m.role != 'system'
           ${order}`
      ).all(threadId);
      return (rows as RawMessage[]).map(toMessage);
    }
    // Single `or`, not a union: keeps one row per message and leaves the sort
    // clause and row mapping untouched. With nothing retained the predicate is
    // `(m.seq >= ?)` with no alternatives, so it selects exactly what the old
    // `m.seq >= ?` query selected — behaviourally identical, though the text
    // now carries parentheses.
    // The thread filter stays OUTSIDE the parenthesised or-group. Inside it, a
    // retained id belonging to another thread would pull that thread's user
    // text into this prompt.
    const ids = retained.map((entry) => entry.id);
    const retainedClause = ids.length
      ? ` or m.id in (${ids.map(() => "?").join(",")})`
      : "";
    const rows = this.db.prepare(
      `select ${columns}
         from agent_messages m
         left join agent_wakes w on w.id = m.wake_id
         where m.thread_id = ? and m.role != 'system' and (m.seq >= ?${retainedClause})
         ${order}`
    ).all(threadId, lastSummarySeq, ...ids);
    // A retained turn too large to keep whole carries a truncated copy. Swap
    // only its text: identity, ordering and provenance still come from the real
    // row, and the stored row is never modified.
    const truncated = new Map(
      retained
        .filter((entry) => typeof entry.truncatedText === "string")
        .map((entry) => [entry.id, entry.truncatedText as string])
    );
    return (rows as RawMessage[]).map(toMessage).map((message) => {
      const text = truncated.get(message.id);
      if (text === undefined || message.content.type !== "text") return message;
      return { ...message, content: { ...message.content, text } };
    });
  }

  private getLatestCompressionSummary(
    threadId: string,
    atOrBeforeSeq?: number
  ): RawCompressionSummaryCursor | null {
    const rows = this.db
      .prepare(
        `select seq, content, created_at
       from agent_messages
       where thread_id = ? and role != 'system' and source = 'compression'
         ${atOrBeforeSeq === undefined ? "" : "and seq <= ?"}
       order by seq desc, created_at desc, id desc`
      )
      .all(...(atOrBeforeSeq === undefined ? [threadId] : [threadId, atOrBeforeSeq])) as RawCompressionSummaryCursor[];
    for (const row of rows) {
      const content = JSON.parse(row.content) as AgentMessageContent;
      if (content.type === "summary") return row;
    }
    return null;
  }

  /** The newest reply with words a turn wrote in a thread, trimmed; null
   *  when it wrote none. Read by the turn's own rows (its wake's index),
   *  whatever the conversation's length. */
  latestAssistantTextOfWake(threadId: string, wakeId: string): string | null {
    const rows = this.db.prepare(
      `select json_extract(content, '$.text') as text from agent_messages
        where wake_id = ? and thread_id = ? and role = 'assistant' and json_extract(content, '$.type') = 'assistant'
        order by seq desc, created_at desc, id desc`
    ).all(wakeId, threadId) as Array<{ text: unknown }>;
    for (const row of rows) {
      const text = typeof row.text === "string" ? row.text.trim() : "";
      if (text) return text;
    }
    return null;
  }

  getMessages(threadId: string): AgentMessage[] {
    const rows = this.db
      .prepare(
        `select ${MESSAGE_COLUMNS}
       from agent_messages m
       left join agent_wakes w on w.id = m.wake_id
       where m.thread_id = ?
       order by m.seq asc, m.created_at asc, m.id asc`
      )
      .all(threadId) as RawMessage[];
    return rows.map(toMessage);
  }

  /** Every message the user wrote in a thread, typed or spoken, with when,
   *  oldest first. What a memory that claims the user's words is checked
   *  against, and dated by. What the global agent sent for them carries its
   *  words, not theirs. */
  userStatements(threadId: string): Array<{ text: string; at: string }> {
    const rows = this.db.prepare(`
      select content, created_at as at from agent_messages
      where thread_id = ? and role = 'user' and source in ('user', 'voice')
      order by seq asc
    `).all(threadId) as Array<{ content: string; at: string }>;
    const said: Array<{ text: string; at: string }> = [];
    for (const row of rows) {
      const content = JSON.parse(row.content) as AgentMessageContent;
      if (content.type === "text" && !content.relay && content.text.trim()) said.push({ text: content.text, at: row.at });
    }
    return said;
  }

  getMessagesPage(
    threadId: string,
    opts: { limit?: number; beforeSeq?: number } = {}
  ): AgentMessage[] {
    const limit = opts.limit ?? 100;
    const stmt =
      opts.beforeSeq !== undefined
        ? this.db.prepare(
            `select ${MESSAGE_COLUMNS}
           from agent_messages m
           left join agent_wakes w on w.id = m.wake_id
           where m.thread_id = ? and m.seq < ?
           order by m.seq desc, m.created_at desc, m.id desc limit ?`
          )
        : this.db.prepare(
            `select ${MESSAGE_COLUMNS}
           from agent_messages m
           left join agent_wakes w on w.id = m.wake_id
           where m.thread_id = ?
           order by m.seq desc, m.created_at desc, m.id desc limit ?`
          );
    const rows = (
      opts.beforeSeq !== undefined
        ? stmt.all(threadId, opts.beforeSeq, limit)
        : stmt.all(threadId, limit)
    ) as RawMessage[];
    return rows.map(toMessage);
  }

  /** UI timeline recovery path: returns full history messages newer than
   *  `seq`, including messages that are no longer active in the LLM prompt. */
  getMessagesSince(threadId: string, seq: number): AgentMessage[] {
    const rows = this.db
      .prepare(
        `select ${MESSAGE_COLUMNS}
       from agent_messages m
       left join agent_wakes w on w.id = m.wake_id
       where m.thread_id = ? and m.seq > ?
       order by m.seq asc, m.created_at asc, m.id asc`
      )
      .all(threadId, seq) as RawMessage[];
    return rows.map(toMessage);
  }

  createWake(input: {
    threadId: string;
    reason: AgentWakeReason;
    triggerMessageId: string | null;
    metadata?: AgentWakeMetadata | null;
  }): AgentWake {
    const recovery = pendingWakeRecovery(this.db, input.threadId);
    if (recovery) {
      const interrupted = this.getWakeById(recovery.wakeIds[recovery.wakeIds.length - 1]!);
      input = { ...input, metadata: { ...interrupted?.metadata, ...input.metadata, recovery } };
      if (input.reason === "user" && input.triggerMessageId === null) {
        input.reason = recovery.originalReason;
        input.triggerMessageId = recovery.originalTriggerMessageId;
      }
    }
    const id = newId("wake");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into agent_wakes
        (id, thread_id, reason, trigger_message_id, status, step_count, started_at, metadata_json)
       values (?, ?, ?, ?, 'running', 0, ?, ?)`
      )
      .run(
        id,
        input.threadId,
        input.reason,
        input.triggerMessageId,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null
      );
    return this.getWakeById(id)!;
  }

  getWakeById(id: string): AgentWake | null {
    const r = this.db
      .prepare(
        `select ${WAKE_COLUMNS}
       from agent_wakes where id = ?`
      )
      .get(id) as RawWake | undefined;
    return r ? toWake(r) : null;
  }

  getRunningWakeForThread(threadId: string): AgentWake | null {
    const r = this.db
      .prepare(
        `select ${WAKE_COLUMNS}
       from agent_wakes
       where thread_id = ? and status = 'running'
       order by started_at desc limit 1`
      )
      .get(threadId) as RawWake | undefined;
    return r ? toWake(r) : null;
  }

  /** The thread's newest wake — the one created last — whatever its status. */
  getLatestWakeForThread(threadId: string): AgentWake | null {
    const r = this.db
      .prepare(
        `select ${WAKE_COLUMNS}
       from agent_wakes
       where thread_id = ?
       order by rowid desc limit 1`
      )
      .get(threadId) as RawWake | undefined;
    return r ? toWake(r) : null;
  }

  /** All running wakes joined with their thread's scope. Powers
   *  GET /api/agents/active-wakes so clients can rebuild live-activity
   *  state at boot and after SSE reconnects. */
  listRunningWakesWithScope(): ActiveWakeDto[] {
    const rows = this.db
      .prepare(
        `select w.id as wake_id, w.thread_id, t.scope, t.scope_id, w.started_at
       from agent_wakes w
       join agent_threads t on t.id = w.thread_id
       where w.status = 'running'
       order by w.started_at asc`
      )
      .all() as Array<{
        wake_id: string;
        thread_id: string;
        scope: string;
        scope_id: string | null;
        started_at: string;
      }>;
    return rows.map((r) => ({
      threadId: r.thread_id,
      wakeId: r.wake_id,
      scope: r.scope as AgentScope,
      scopeId: r.scope_id,
      startedAt: r.started_at
    }));
  }

  recoverInterruptedWakes(errorMessage: string, canRecoverThread: (thread: AgentThread) => boolean = () => true): number {
    return recoverInterruptedWakes(this.db, this, errorMessage, canRecoverThread);
  }

  requestWakeCancellation(wakeId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`update agent_wakes set cancel_requested_at = ? where id = ? and status = 'running'`)
        .run(new Date().toISOString(), wakeId);
      const wake = this.getWakeById(wakeId);
      if (wake) discardRecovery(this.db, wake.threadId);
    }).immediate();
  }

  updateWakeStepCount(wakeId: string, stepCount: number): void {
    this.db.prepare(`update agent_wakes set step_count = ? where id = ?`).run(stepCount, wakeId);
  }

  updateWakeTokenUsage(
    wakeId: string,
    inputTokens: number | null,
    maxInputTokens: number | null
  ): void {
    this.db
      .prepare(`update agent_wakes set last_input_tokens = ?, max_input_tokens = ?, last_input_at = ? where id = ?`)
      .run(positiveIntegerOrNull(inputTokens), positiveIntegerOrNull(maxInputTokens), new Date().toISOString(), wakeId);
  }

  finishWake(wakeId: string, status: AgentWakeStatus, errorMessage: string | null = null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `update agent_wakes set status = ?, finished_at = ?, error_message = ?
       where id = ? and status = 'running'`
      )
      .run(status, now, errorMessage, wakeId);
  }

  enqueueMailboxMessage(input: {
    threadId: string;
    role: AgentRole;
    source: AgentMessageSource;
    content: AgentMessageContent;
    sourceThreadId?: string | null;
    triggerTurn?: boolean;
  }): AgentMailboxItem {
    const id = newId("mbx");
    const now = new Date().toISOString();
    const content = input.content;
    this.db
      .prepare(
        `insert into agent_mailbox
        (id, thread_id, role, source, source_thread_id, content,
         trigger_turn, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
      )
      .run(
        id,
        input.threadId,
        input.role,
        input.source,
        input.sourceThreadId ?? null,
        JSON.stringify(content),
        input.triggerTurn === false ? 0 : 1,
        now
      );
    return this.getMailboxItemById(id)!;
  }

  getMailboxItemById(id: string): AgentMailboxItem | null {
    const r = this.db
      .prepare(
        `select ${MAILBOX_COLUMNS}
       from agent_mailbox where id = ?`
      )
      .get(id) as RawMailbox | undefined;
    return r ? toMailboxItem(r) : null;
  }

  hasQueuedMailboxMessages(threadId: string): boolean {
    const row = this.db
      .prepare(
        `select 1 as ok from agent_mailbox
       where thread_id = ? and status = 'queued' and trigger_turn = 1
       limit 1`
      )
      .get(threadId) as { ok: number } | undefined;
    return Boolean(row);
  }

  /** Distinct sources of the thread's undelivered mailbox messages that start
   *  a turn — the same rows hasQueuedMailboxMessages counts. */
  queuedMailboxSources(threadId: string): AgentMessageSource[] {
    const rows = this.db.prepare(
      `select distinct source from agent_mailbox
        where thread_id = ? and status = 'queued' and trigger_turn = 1`
    ).all(threadId) as Array<{ source: AgentMessageSource }>;
    return rows.map((r) => r.source);
  }

  listThreadIdsWithQueuedMailboxMessages(): string[] {
    const rows = this.db
      .prepare(
        `select distinct m.thread_id
         from agent_mailbox m
         join agent_threads t on t.id = m.thread_id
        where m.status = 'queued'
          and m.trigger_turn = 1
          and t.archived_at is null
        order by m.created_at asc, m.id asc`
      )
      .all() as Array<{ thread_id: string }>;
    return rows.map((row) => row.thread_id);
  }

  listMailboxMessagesDeliveredToWake(wakeId: string): AgentMailboxItem[] {
    const rows = this.db
      .prepare(
        `select ${MAILBOX_COLUMNS}
         from agent_mailbox
        where wake_id = ? and status = 'delivered'
        order by created_at asc, id asc`
      )
      .all(wakeId) as RawMailbox[];
    return rows.map(toMailboxItem);
  }

  drainMailboxToMessages(threadId: string, wakeId: string, limit = 50): AgentMessage[] {
    return this.db.transaction(() => {
      const delivered: AgentMessage[] = [];
      const rows = this.db
        .prepare(
          `select ${MAILBOX_COLUMNS}
         from agent_mailbox
         where thread_id = ? and status = 'queued'
         order by (source = 'restart-recovery') desc, created_at asc, id asc
         limit ?`
        )
        .all(threadId, limit) as RawMailbox[];
      if (rows.length === 0) return delivered;

      const now = new Date().toISOString();
      const markDelivered = this.db.prepare(
        `update agent_mailbox
         set status = 'delivered', wake_id = ?, delivered_message_id = ?, delivered_at = ?
         where id = ? and status = 'queued'`
      );
      for (const row of rows) {
        const item = toMailboxItem(row);
        const message = this.appendMessage({
          threadId: item.threadId,
          role: item.role,
          source: item.source,
          sourceThreadId: item.sourceThreadId,
          wakeId: item.source === "restart-recovery" ? wakeId : null,
          // It waited in the mailbox: the model reads the time it came.
          content: item.content.type === "text" ? { ...item.content, arrivedAt: item.createdAt } : item.content
        });
        markDelivered.run(wakeId, message.id, now, item.id);
        delivered.push(message);
      }
      return delivered;
    }).immediate();
  }

  getMessageIdsForWake(wakeId: string): string[] {
    const triggers = this.db
      .prepare(
        `select trigger_message_id as id from agent_wakes where id = ? and trigger_message_id is not null`
      )
      .all(wakeId) as Array<{ id: string }>;
    const produced = this.db
      .prepare(`select id from agent_messages where wake_id = ?`)
      .all(wakeId) as Array<{ id: string }>;
    return [...triggers.map((r) => r.id), ...produced.map((r) => r.id)];
  }

  getContextUsage(threadId: string, budgetTokens: number): AgentContextUsage {
    const budget = normalizeBudgetTokens(budgetTokens);
    const row = this.db
      .prepare(
        `
      select last_input_tokens as inputTokens,
             coalesce(last_input_at, finished_at, started_at) as updatedAt
      from agent_wakes
      where thread_id = ?
        and last_input_tokens is not null
      order by coalesce(last_input_at, finished_at, started_at) desc, started_at desc, rowid desc
      limit 1
    `
      )
      .get(threadId) as { inputTokens: number | null; updatedAt: string | null } | undefined;
    const latestCompression = this.getLatestCompressionSummary(threadId);
    if (latestCompression && (!row?.updatedAt || latestCompression.created_at >= row.updatedAt)) {
      // Nothing has measured the window since it was compacted, so there is no
      // figure: an estimate here ran well above the provider's count for the
      // same messages, and stayed until the next call.
      return {
        inputTokens: null,
        budgetTokens: budget,
        updatedAt: latestCompression.created_at,
        source: "compression_budget"
      };
    }
    return {
      inputTokens: positiveIntegerOrNull(row?.inputTokens),
      budgetTokens: budget,
      updatedAt: row?.updatedAt ?? null,
      source: "compression_budget"
    };
  }
}

/** Older messages a compression summary says should survive; none for a row
 *  that cannot be read as a summary. */
function retainedFromSummaryRow(
  row: RawCompressionSummaryCursor | null
): Array<{ id: string; truncatedText?: string }> {
  if (!row) return [];
  try {
    const content = JSON.parse(row.content) as AgentMessageContent;
    if (content.type !== "summary" || !Array.isArray(content.retained)) return [];
    return content.retained.filter(
      (entry): entry is { id: string; truncatedText?: string } =>
        Boolean(entry) && typeof entry.id === "string"
    );
  } catch {
    return [];
  }
}

function normalizeBudgetTokens(value: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function parseWakeMetadata(raw: string | null | undefined): AgentWakeMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AgentWakeMetadata;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
