import type { Database } from "bun:sqlite";
import type {
  ActiveWakeDto,
  AgentContextUsageDto,
  AgentMessageDto,
  AgentScope,
  AgentSideTransferDto,
  AgentThreadDto,
  AgentThreadKind,
  AgentWakeDto,
  AgentWakeMetadata,
  AgentWakeReason,
  AgentWakeStatus
} from "../../../shared/api-contracts.js";
import type {
  AgentRole,
  AgentMessageSource,
  AgentMessageContent,
  FeatureEventContent
} from "../../../shared/agent-message-types.js";
import { newId } from "../../platform/ids.js";
import { estimateMessagesTokens } from "./compression.js";
import { isFeatureTaskDispatchContent } from "./feature-task-dispatch-message.js";
import { indexAgentHistoryMessage } from "./history-store.js";
import { discardRecovery, pendingWakeRecovery, recoverInterruptedWakes } from "./wake-recovery.js";

export type {
  AgentScope,
  AgentWakeReason,
  AgentWakeStatus
} from "../../../shared/api-contracts.js";
export type AgentThread = AgentThreadDto;
export type AgentSideTransfer = AgentSideTransferDto;
export type AgentMessage = AgentMessageDto;
export type AgentWake = AgentWakeDto;
export type AgentContextUsage = AgentContextUsageDto;
export type AgentTaskStatus = "queued" | "active" | "waiting" | "blocked" | "done" | "canceled";
export type AgentTaskSource = "user" | "agent" | "system";
export type AgentTaskChannel = "chat" | "voice" | "manager" | "canvas" | "watch";
type AgentMailboxStatus = "queued" | "delivered";

export interface MailboxEventRow {
  id: string;
  threadId: string;
  content: FeatureEventContent;
  createdAt: string;
}

export interface FeatureDigest {
  featureId: string;
  summary: string;
  decisions: string[];
  openQuestions: string[];
  constraints: string[];
  lastSeqCovered: number;
  updatedByThreadId: string;
  updatedAt: string;
}

export interface AgentTask {
  id: string;
  featureId: string;
  threadId: string;
  source: AgentTaskSource;
  channel: AgentTaskChannel;
  title: string;
  message: string;
  status: AgentTaskStatus;
  priority: number;
  callerThreadId: string | null;
  createdByThreadId: string | null;
  lastNote: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

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
  kind: string;
  parent_thread_id: string | null;
  ephemeral: number;
  fork_context_start_seq: number | null;
  fork_context_end_seq: number | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function toThread(r: RawThread): AgentThread {
  return {
    id: r.id,
    scope: r.scope as AgentScope,
    scopeId: r.scope_id,
    kind: r.kind as AgentThreadKind,
    parentThreadId: r.parent_thread_id,
    ephemeral: r.ephemeral === 1,
    forkContextStartSeq: r.fork_context_start_seq,
    forkContextEndSeq: r.fork_context_end_seq,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at
  };
}

export type {
  AgentRole,
  AgentMessageSource,
  AgentMessageContent,
  AgentMessageAttachment,
  AssistantContent,
  ToolCall,
  FeatureEventArtifact,
  FeatureEventContent
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

interface RawTask {
  id: string;
  feature_id: string;
  thread_id: string;
  source: string;
  channel: string;
  title: string;
  message: string;
  status: string;
  priority: number;
  caller_thread_id: string | null;
  created_by_thread_id: string | null;
  last_note: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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

interface RawFeatureDigest {
  feature_id: string;
  summary: string;
  decisions: string;
  open_questions: string;
  constraints: string;
  last_seq_covered: number;
  updated_by_thread_id: string;
  updated_at: string;
}

interface RawCompressionSummaryCursor {
  seq: number;
  content: string;
  created_at: string;
}

interface RawSideTransfer {
  id: string;
  source_thread_id: string;
  target_thread_id: string;
  client_request_id: string;
  content: string;
  status: string;
  delivered_message_id: string | null;
  created_at: string;
  delivered_at: string | null;
}

function toSideTransfer(r: RawSideTransfer): AgentSideTransfer {
  return {
    id: r.id,
    sourceThreadId: r.source_thread_id,
    targetThreadId: r.target_thread_id,
    clientRequestId: r.client_request_id,
    content: r.content,
    status: r.status as AgentSideTransfer["status"],
    deliveredMessageId: r.delivered_message_id,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at
  };
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

function toTask(r: RawTask): AgentTask {
  return {
    id: r.id,
    featureId: r.feature_id,
    threadId: r.thread_id,
    source: r.source as AgentTaskSource,
    channel: r.channel as AgentTaskChannel,
    title: r.title,
    message: r.message,
    status: r.status as AgentTaskStatus,
    priority: r.priority,
    callerThreadId: r.caller_thread_id,
    createdByThreadId: r.created_by_thread_id,
    lastNote: r.last_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at
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

function toFeatureDigest(r: RawFeatureDigest): FeatureDigest {
  return {
    featureId: r.feature_id,
    summary: r.summary,
    decisions: parseStringArray(r.decisions),
    openQuestions: parseStringArray(r.open_questions),
    constraints: parseStringArray(r.constraints),
    lastSeqCovered: r.last_seq_covered,
    updatedByThreadId: r.updated_by_thread_id,
    updatedAt: r.updated_at
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
    content: JSON.parse(r.content) as AgentMessageContent,
    createdAt: r.created_at
  };
}

export class AgentStore {
  constructor(private db: Database) {}

  getThreadById(id: string): AgentThread | null {
    const r = this.db
      .prepare(
        `select id, scope, scope_id, kind, parent_thread_id, ephemeral,
                fork_context_start_seq, fork_context_end_seq, closed_at,
                created_at, updated_at, archived_at
       from agent_threads where id = ?`
      )
      .get(id) as RawThread | undefined;
    return r ? toThread(r) : null;
  }

  getThreadByScope(scope: AgentScope, scopeId: string | null): AgentThread | null {
    const r = this.db
      .prepare(
        `select id, scope, scope_id, kind, parent_thread_id, ephemeral,
                fork_context_start_seq, fork_context_end_seq, closed_at,
                created_at, updated_at, archived_at
       from agent_threads
       where scope = ? and scope_id is ?
         and kind = 'main' and archived_at is null`
      )
      .get(scope, scopeId) as RawThread | undefined;
    return r ? toThread(r) : null;
  }

  getOrCreateThread(scope: AgentScope, scopeId: string | null): AgentThread {
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

  getOpenSideThread(parentThreadId: string): AgentThread | null {
    const r = this.db.prepare(
      `select id, scope, scope_id, kind, parent_thread_id, ephemeral,
              fork_context_start_seq, fork_context_end_seq, closed_at,
              created_at, updated_at, archived_at
       from agent_threads
       where kind = 'side' and parent_thread_id = ? and closed_at is null
       order by created_at desc limit 1`
    ).get(parentThreadId) as RawThread | undefined;
    return r ? toThread(r) : null;
  }

  createSideThread(parentThreadId: string): AgentThread {
    const parent = this.getThreadById(parentThreadId);
    if (!parent || parent.kind !== "main" || parent.archivedAt || parent.closedAt) {
      throw new Error("side conversations require an active main thread");
    }
    const existing = this.getOpenSideThread(parentThreadId);
    if (existing) return existing;

    const endSeq = this.captureForkEndSeq(parentThreadId);
    if (endSeq === null) throw new Error("send a message before starting a side conversation");
    const summary = this.getLatestCompressionSummary(parentThreadId, endSeq);
    const startSeq = summary?.seq ?? this.firstPromptMessageSeq(parentThreadId, endSeq);
    if (startSeq === null) throw new Error("no conversation context is available to fork");

    const id = newId("thr");
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        `insert into agent_threads
          (id, scope, scope_id, kind, parent_thread_id, ephemeral,
           fork_context_start_seq, fork_context_end_seq, created_at, updated_at)
         values (?, ?, ?, 'side', ?, 1, ?, ?, ?, ?)`
      ).run(id, parent.scope, parent.scopeId, parent.id, startSeq, endSeq, now, now);
    } catch {
      const winner = this.getOpenSideThread(parentThreadId);
      if (winner) return winner;
      throw new Error("failed to create side conversation");
    }
    return this.getThreadById(id)!;
  }

  closeSideThread(threadId: string): AgentThread | null {
    const thread = this.getThreadById(threadId);
    if (!thread || thread.kind !== "side") return null;
    if (!thread.closedAt) {
      const now = new Date().toISOString();
      this.db.prepare(
        `update agent_threads set closed_at = ?, updated_at = ? where id = ? and closed_at is null`
      ).run(now, now, threadId);
    }
    return this.getThreadById(threadId);
  }

  lineageThreadId(threadId: string): string {
    const thread = this.getThreadById(threadId);
    return thread?.kind === "side" && thread.parentThreadId ? thread.parentThreadId : threadId;
  }

  createSideTransfer(input: {
    sourceThreadId: string;
    targetThreadId?: string;
    clientRequestId: string;
    content: string;
  }): AgentSideTransfer {
    const source = this.getThreadById(input.sourceThreadId);
    if (!source || source.kind !== "side" || !source.parentThreadId) {
      throw new Error("side conversation not found");
    }
    const content = input.content.trim();
    if (!content) throw new Error("summary content is required");
    const clientRequestId = input.clientRequestId.trim();
    if (!clientRequestId) throw new Error("clientRequestId is required");
    const targetThreadId = input.targetThreadId ?? source.parentThreadId;
    const existing = this.getSideTransferByRequest(input.sourceThreadId, clientRequestId);
    if (existing) return existing;
    const id = newId("xfer");
    const now = new Date().toISOString();
    this.db.prepare(
      `insert into agent_side_transfers
        (id, source_thread_id, target_thread_id, client_request_id, content, status, created_at)
       values (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(id, input.sourceThreadId, targetThreadId, clientRequestId, content, now);
    return this.getSideTransferById(id)!;
  }

  getSideTransferById(id: string): AgentSideTransfer | null {
    const row = this.db.prepare(
      `select id, source_thread_id, target_thread_id, client_request_id, content,
              status, delivered_message_id, created_at, delivered_at
       from agent_side_transfers where id = ?`
    ).get(id) as RawSideTransfer | undefined;
    return row ? toSideTransfer(row) : null;
  }

  getSideTransferByRequest(sourceThreadId: string, clientRequestId: string): AgentSideTransfer | null {
    const row = this.db.prepare(
      `select id, source_thread_id, target_thread_id, client_request_id, content,
              status, delivered_message_id, created_at, delivered_at
       from agent_side_transfers where source_thread_id = ? and client_request_id = ?`
    ).get(sourceThreadId, clientRequestId) as RawSideTransfer | undefined;
    return row ? toSideTransfer(row) : null;
  }

  listPendingSideTransfers(targetThreadId: string): AgentSideTransfer[] {
    const rows = this.db.prepare(
      `select id, source_thread_id, target_thread_id, client_request_id, content,
              status, delivered_message_id, created_at, delivered_at
       from agent_side_transfers
       where target_thread_id = ? and status = 'pending'
       order by created_at asc, id asc`
    ).all(targetThreadId) as RawSideTransfer[];
    return rows.map(toSideTransfer);
  }

  listPendingSideTransferTargetThreadIds(): string[] {
    const rows = this.db.prepare(
      `select distinct target_thread_id from agent_side_transfers
       where status = 'pending' order by created_at asc`
    ).all() as Array<{ target_thread_id: string }>;
    return rows.map((row) => row.target_thread_id);
  }

  markSideTransferNeedsRetarget(id: string): AgentSideTransfer | null {
    this.db.prepare(
      `update agent_side_transfers set status = 'needs_retarget'
       where id = ? and status = 'pending'`
    ).run(id);
    return this.getSideTransferById(id);
  }

  retargetSideTransfer(id: string, targetThreadId: string): AgentSideTransfer | null {
    const target = this.getThreadById(targetThreadId);
    if (!target || target.kind !== "main" || target.archivedAt) return null;
    this.db.prepare(
      `update agent_side_transfers set target_thread_id = ?, status = 'pending'
       where id = ? and status = 'needs_retarget'`
    ).run(targetThreadId, id);
    return this.getSideTransferById(id);
  }

  deliverSideTransfer(id: string): { transfer: AgentSideTransfer; message: AgentMessage } | null {
    const transfer = this.getSideTransferById(id);
    if (!transfer || transfer.status !== "pending") return null;
    const target = this.getThreadById(transfer.targetThreadId);
    if (!target || target.kind !== "main" || target.archivedAt) {
      this.markSideTransferNeedsRetarget(id);
      return null;
    }
    const message = this.appendMessage({
      threadId: target.id,
      role: "user",
      source: "side-summary",
      sourceThreadId: transfer.sourceThreadId,
      content: { type: "text", text: transfer.content }
    });
    const now = new Date().toISOString();
    this.db.prepare(
      `update agent_side_transfers
       set status = 'delivered', delivered_message_id = ?, delivered_at = ?
       where id = ? and status = 'pending'`
    ).run(message.id, now, id);
    return { transfer: this.getSideTransferById(id)!, message };
  }

  closeOpenEphemeralSideThreads(): string[] {
    const rows = this.db.prepare(
      `select id from agent_threads
       where kind = 'side' and ephemeral = 1 and closed_at is null`
    ).all() as Array<{ id: string }>;
    const now = new Date().toISOString();
    this.db.prepare(
      `update agent_threads set closed_at = ?, updated_at = ?
       where kind = 'side' and ephemeral = 1 and closed_at is null`
    ).run(now, now);
    return rows.map((row) => row.id);
  }

  getSystemMessage(threadId: string): AgentMessage | null {
    const r = this.db
      .prepare(
        `select m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id, m.wake_id,
              w.reason as wake_reason, w.metadata_json as wake_metadata_json,
              m.content, m.created_at
       from agent_messages m
       left join agent_wakes w on w.id = m.wake_id
       where m.thread_id = ? and m.role = 'system'
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
        `select id, scope, scope_id, kind, parent_thread_id, ephemeral,
                fork_context_start_seq, fork_context_end_seq, closed_at,
                created_at, updated_at, archived_at
       from agent_threads
       where scope = ? and scope_id is ?
         and kind = 'main' and archived_at is not null
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

  /** Returns the main (user-facing) thread for a scope+scopeId, or null. */
  getMainThread(scope: AgentScope, scopeId: string | null): AgentThread | null {
    return this.getThreadByScope(scope, scopeId);
  }

  upsertFeatureDigest(input: {
    featureId: string;
    summary: string;
    decisions?: string[];
    openQuestions?: string[];
    constraints?: string[];
    lastSeqCovered?: number;
    updatedByThreadId: string;
  }): FeatureDigest {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into feature_digests
        (feature_id, summary, decisions, open_questions, constraints,
         last_seq_covered, updated_by_thread_id, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(feature_id) do update set
         summary = excluded.summary,
         decisions = excluded.decisions,
         open_questions = excluded.open_questions,
         constraints = excluded.constraints,
         last_seq_covered = excluded.last_seq_covered,
         updated_by_thread_id = excluded.updated_by_thread_id,
         updated_at = excluded.updated_at`
      )
      .run(
        input.featureId,
        input.summary,
        JSON.stringify(input.decisions ?? []),
        JSON.stringify(input.openQuestions ?? []),
        JSON.stringify(input.constraints ?? []),
        positiveIntegerOrZero(input.lastSeqCovered),
        input.updatedByThreadId,
        now
      );
    return this.getFeatureDigest(input.featureId)!;
  }

  getFeatureDigest(featureId: string): FeatureDigest | null {
    const r = this.db
      .prepare(
        `select feature_id, summary, decisions, open_questions, constraints,
              last_seq_covered, updated_by_thread_id, updated_at
       from feature_digests
       where feature_id = ?`
      )
      .get(featureId) as RawFeatureDigest | undefined;
    return r ? toFeatureDigest(r) : null;
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
        `select m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id, m.wake_id,
              w.reason as wake_reason, w.metadata_json as wake_metadata_json,
              m.content, m.created_at
       from agent_messages m
       left join agent_wakes w on w.id = m.wake_id
       where m.id = ?`
      )
      .get(id) as RawMessage | undefined;
    return r ? toMessage(r) : null;
  }

  getActiveMessages(threadId: string): AgentMessage[] {
    const thread = this.getThreadById(threadId);
    const ownSummary = this.getLatestCompressionSummary(threadId);
    const own = this.getOwnActiveMessages(
      threadId,
      ownSummary?.seq ?? null,
      retainedFromSummaryRow(ownSummary)
    );
    if (
      thread?.kind !== "side"
      || ownSummary
      || !thread.parentThreadId
      || thread.forkContextStartSeq === null
      || thread.forkContextEndSeq === null
    ) return own;

    const inherited = this.getMessagesInRange(
      thread.parentThreadId,
      thread.forkContextStartSeq,
      thread.forkContextEndSeq
    ).filter((message) => message.source !== "runtime-context");
    const remappedInherited = inherited.map((message, index) => ({
      ...message,
      threadId,
      seq: index + 1
    }));
    const boundarySeq = remappedInherited.length + 1;
    const boundary: AgentMessage = {
      id: `side-boundary:${threadId}`,
      threadId,
      seq: boundarySeq,
      role: "user",
      source: "side-boundary",
      sourceThreadId: thread.parentThreadId,
      wakeId: null,
      wakeReason: null,
      wakeMetadata: null,
      content: {
        type: "text",
        text: "Side conversation boundary. Everything before this message is inherited reference context. Only instructions after this boundary are active for this side conversation."
      },
      createdAt: thread.createdAt
    };
    const remappedOwn = own.map((message, index) => ({
      ...message,
      seq: boundarySeq + index + 1
    }));
    return [...remappedInherited, boundary, ...remappedOwn];
  }

  private getOwnActiveMessages(
    threadId: string,
    lastSummarySeq: number | null,
    retained: Array<{ id: string; truncatedText?: string }> = []
  ): AgentMessage[] {
    const columns = `m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id, m.wake_id,
                  w.reason as wake_reason, w.metadata_json as wake_metadata_json,
                  m.content, m.created_at`;
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

  private captureForkEndSeq(threadId: string): number | null {
    const running = this.getRunningWakeForThread(threadId);
    if (running?.triggerMessageId) {
      const trigger = this.getMessageById(running.triggerMessageId);
      if (trigger?.threadId === threadId) return trigger.seq;
    }
    if (running) {
      const firstWakeMessage = this.db.prepare(
        `select min(seq) as seq from agent_messages where thread_id = ? and wake_id = ?`
      ).get(threadId, running.id) as { seq: number | null };
      if (firstWakeMessage.seq !== null) {
        const previous = firstWakeMessage.seq - 1;
        return previous > 0 ? previous : null;
      }
    }
    const row = this.db.prepare(
      `select max(seq) as seq from agent_messages where thread_id = ? and role != 'system'`
    ).get(threadId) as { seq: number | null };
    return row.seq;
  }

  private firstPromptMessageSeq(threadId: string, endSeq: number): number | null {
    const row = this.db.prepare(
      `select min(seq) as seq from agent_messages
       where thread_id = ? and role != 'system' and seq <= ?`
    ).get(threadId, endSeq) as { seq: number | null };
    return row.seq;
  }

  private getMessagesInRange(threadId: string, startSeq: number, endSeq: number): AgentMessage[] {
    const rows = this.db.prepare(
      `select m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id, m.wake_id,
              w.reason as wake_reason, w.metadata_json as wake_metadata_json,
              m.content, m.created_at
       from agent_messages m
       left join agent_wakes w on w.id = m.wake_id
       where m.thread_id = ? and m.role != 'system' and m.seq between ? and ?
       order by m.seq asc, m.created_at asc, m.id asc`
    ).all(threadId, startSeq, endSeq) as RawMessage[];
    return rows.map(toMessage);
  }

  getMessages(threadId: string): AgentMessage[] {
    const rows = this.db
      .prepare(
        `select m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id, m.wake_id,
              w.reason as wake_reason, w.metadata_json as wake_metadata_json,
              m.content, m.created_at
       from agent_messages m
       left join agent_wakes w on w.id = m.wake_id
       where m.thread_id = ?
       order by m.seq asc, m.created_at asc, m.id asc`
      )
      .all(threadId) as RawMessage[];
    return rows.map(toMessage);
  }

  getMessageCount(threadId: string): number {
    const row = this.db
      .prepare(`select count(*) as count from agent_messages where thread_id = ?`)
      .get(threadId) as { count: number };
    return row.count;
  }

  getMessagesPage(
    threadId: string,
    opts: { limit?: number; beforeSeq?: number } = {}
  ): AgentMessage[] {
    const limit = opts.limit ?? 100;
    const stmt =
      opts.beforeSeq !== undefined
        ? this.db.prepare(
            `select m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id, m.wake_id,
                  w.reason as wake_reason, w.metadata_json as wake_metadata_json,
                  m.content, m.created_at
           from agent_messages m
           left join agent_wakes w on w.id = m.wake_id
           where m.thread_id = ? and m.seq < ?
           order by m.seq desc, m.created_at desc, m.id desc limit ?`
          )
        : this.db.prepare(
            `select m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id, m.wake_id,
                  w.reason as wake_reason, w.metadata_json as wake_metadata_json,
                  m.content, m.created_at
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
        `select m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id, m.wake_id,
              w.reason as wake_reason, w.metadata_json as wake_metadata_json,
              m.content, m.created_at
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
        `select id, thread_id, reason, trigger_message_id, status, step_count,
              error_message, metadata_json, started_at, finished_at
       from agent_wakes where id = ?`
      )
      .get(id) as RawWake | undefined;
    return r ? toWake(r) : null;
  }

  getRunningWakeForThread(threadId: string): AgentWake | null {
    const r = this.db
      .prepare(
        `select id, thread_id, reason, trigger_message_id, status, step_count,
              error_message, metadata_json, started_at, finished_at
       from agent_wakes
       where thread_id = ? and status = 'running'
       order by started_at desc limit 1`
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
        `select w.id as wake_id, w.thread_id, t.scope, t.scope_id
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
      }>;
    return rows.map((r) => ({
      threadId: r.thread_id,
      wakeId: r.wake_id,
      scope: r.scope as AgentScope,
      scopeId: r.scope_id
    }));
  }

  recoverInterruptedWakes(errorMessage: string, canRecoverThread: (thread: AgentThread) => boolean = () => true): number {
    return recoverInterruptedWakes(this.db, this, errorMessage, canRecoverThread);
  }

  requestWakeCancellation(wakeId: string): void {
    this.db.exec("begin immediate");
    try {
      this.db.prepare(`update agent_wakes set cancel_requested_at = ? where id = ? and status = 'running'`)
        .run(new Date().toISOString(), wakeId);
      const wake = this.getWakeById(wakeId);
      if (wake) discardRecovery(this.db, wake.threadId);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
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
      .prepare(`update agent_wakes set last_input_tokens = ?, max_input_tokens = ? where id = ?`)
      .run(positiveIntegerOrNull(inputTokens), positiveIntegerOrNull(maxInputTokens), wakeId);
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

  createTask(input: {
    featureId: string;
    threadId: string;
    source: AgentTaskSource;
    channel: AgentTaskChannel;
    title: string;
    message: string;
    priority?: number;
    callerThreadId?: string | null;
    createdByThreadId?: string | null;
    status?: AgentTaskStatus;
    lastNote?: string | null;
  }): AgentTask {
    const id = newId("task");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into agent_tasks
        (id, feature_id, thread_id, source, channel, title, message, status,
         priority, caller_thread_id, created_by_thread_id, last_note,
         created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.featureId,
        input.threadId,
        input.source,
        input.channel,
        input.title,
        input.message,
        input.status ?? "queued",
        input.priority ?? 0,
        input.callerThreadId ?? null,
        input.createdByThreadId ?? null,
        input.lastNote ?? null,
        now,
        now
      );
    return this.getTaskById(id)!;
  }

  getTaskById(id: string): AgentTask | null {
    const r = this.db
      .prepare(
        `select id, feature_id, thread_id, source, channel, title, message, status,
              priority, caller_thread_id, created_by_thread_id, last_note,
              created_at, updated_at, completed_at
       from agent_tasks where id = ?`
      )
      .get(id) as RawTask | undefined;
    return r ? toTask(r) : null;
  }

  listTasksForThread(
    threadId: string,
    opts: { statuses?: AgentTaskStatus[]; includeDone?: boolean; limit?: number } = {}
  ): AgentTask[] {
    const limit = opts.limit ?? 20;
    const statuses =
      opts.statuses && opts.statuses.length > 0
        ? opts.statuses
        : opts.includeDone
          ? []
          : ["queued", "active", "waiting", "blocked"];
    const base = `select id, feature_id, thread_id, source, channel, title, message, status,
              priority, caller_thread_id, created_by_thread_id, last_note,
              created_at, updated_at, completed_at
       from agent_tasks
       where thread_id = ?`;
    const rows =
      statuses.length > 0
        ? (this.db
            .prepare(
              `${base} and status in (${statuses.map(() => "?").join(",")})
           order by priority desc, updated_at asc limit ?`
            )
            .all(threadId, ...statuses, limit) as RawTask[])
        : (this.db
            .prepare(
              `${base}
           order by priority desc, updated_at asc limit ?`
            )
            .all(threadId, limit) as RawTask[]);
    return rows.map(toTask);
  }

  updateTask(input: {
    id: string;
    status?: AgentTaskStatus;
    title?: string;
    lastNote?: string | null;
  }): AgentTask | null {
    const existing = this.getTaskById(input.id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const status = input.status ?? existing.status;
    const completedAt =
      status === "done" || status === "canceled" ? (existing.completedAt ?? now) : null;
    this.db
      .prepare(
        `update agent_tasks
       set status = ?, title = ?, last_note = ?, updated_at = ?, completed_at = ?
       where id = ?`
      )
      .run(
        status,
        input.title ?? existing.title,
        input.lastNote === undefined ? existing.lastNote : input.lastNote,
        now,
        completedAt,
        input.id
      );
    return this.getTaskById(input.id);
  }

  hasOpenTasksForThread(threadId: string): boolean {
    const row = this.db
      .prepare(
        `select 1 as ok from agent_tasks
       where thread_id = ? and status in ('queued', 'active', 'waiting', 'blocked')
       limit 1`
      )
      .get(threadId) as { ok: number } | undefined;
    return Boolean(row);
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
    this.db
      .prepare(
        `insert into agent_mailbox
        (id, thread_id, role, source, source_thread_id, content,
         trigger_turn, status, event_kind, created_at)
       values (?, ?, ?, ?, ?, ?, ?, 'queued', 'message', ?)`
      )
      .run(
        id,
        input.threadId,
        input.role,
        input.source,
        input.sourceThreadId ?? null,
        JSON.stringify(input.content),
        input.triggerTurn === false ? 0 : 1,
        now
      );
    return this.getMailboxItemById(id)!;
  }

  enqueueMailboxEvent(input: {
    threadId: string;
    role: AgentRole;
    source: AgentMessageSource;
    sourceThreadId: string | null;
    content: FeatureEventContent;
  }): void {
    const id = newId("mbx");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into agent_mailbox
        (id, thread_id, role, source, source_thread_id, content,
         trigger_turn, status, event_kind, created_at)
       values (?, ?, ?, ?, ?, ?, 1, 'queued', 'feature_event', ?)`
      )
      .run(
        id,
        input.threadId,
        input.role,
        input.source,
        input.sourceThreadId,
        JSON.stringify(input.content),
        now
      );
  }

  listPendingFeatureEvents(threadId: string, limit = 50): MailboxEventRow[] {
    const rows = this.db
      .prepare(
        `select id, thread_id, content, created_at
         from agent_mailbox
        where thread_id = ? and event_kind = 'feature_event' and status = 'queued'
        order by created_at asc
        limit ?`
      )
      .all(threadId, limit) as Array<{
      id: string;
      thread_id: string;
      content: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      content: JSON.parse(r.content) as FeatureEventContent,
      createdAt: r.created_at
    }));
  }

  markFeatureEventsProcessed(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `update agent_mailbox set status = 'delivered', delivered_at = ? where id = ?`
    );
    this.db.exec("begin immediate");
    try {
      for (const id of ids) stmt.run(now, id);
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  getMailboxItemById(id: string): AgentMailboxItem | null {
    const r = this.db
      .prepare(
        `select id, thread_id, role, source, source_thread_id, content,
              trigger_turn, status, wake_id, delivered_message_id,
              created_at, delivered_at
       from agent_mailbox where id = ?`
      )
      .get(id) as RawMailbox | undefined;
    return r ? toMailboxItem(r) : null;
  }

  hasQueuedMailboxMessages(threadId: string): boolean {
    const row = this.db
      .prepare(
        `select 1 as ok from agent_mailbox
       where thread_id = ? and status = 'queued' and trigger_turn = 1 and event_kind = 'message'
       limit 1`
      )
      .get(threadId) as { ok: number } | undefined;
    return Boolean(row);
  }

  listThreadIdsWithQueuedMailboxMessages(): string[] {
    const rows = this.db
      .prepare(
        `select distinct m.thread_id
         from agent_mailbox m
         join agent_threads t on t.id = m.thread_id
        where m.status = 'queued'
          and m.trigger_turn = 1
          and m.event_kind = 'message'
          and t.archived_at is null
          and t.closed_at is null
        order by m.created_at asc, m.id asc`
      )
      .all() as Array<{ thread_id: string }>;
    return rows.map((row) => row.thread_id);
  }

  listMailboxMessagesDeliveredToWake(wakeId: string): AgentMailboxItem[] {
    const rows = this.db
      .prepare(
        `select id, thread_id, role, source, source_thread_id, content,
              trigger_turn, status, wake_id, delivered_message_id,
              created_at, delivered_at
         from agent_mailbox
        where wake_id = ? and status = 'delivered' and event_kind = 'message'
        order by created_at asc, id asc`
      )
      .all(wakeId) as RawMailbox[];
    return rows.map(toMailboxItem);
  }

  hasQueuedFeatureTaskDispatchMailboxMessages(threadId: string): boolean {
    return this.listThreadIdsWithQueuedFeatureTaskDispatchMailboxMessages(threadId).length > 0;
  }

  listThreadIdsWithQueuedFeatureTaskDispatchMailboxMessages(threadId?: string): string[] {
    const rows = this.db
      .prepare(
        `select distinct m.thread_id, m.content
         from agent_mailbox m
         join agent_threads t on t.id = m.thread_id
        where m.status = 'queued'
          and m.event_kind = 'message'
          and t.archived_at is null
          ${threadId ? "and m.thread_id = ?" : ""}
        order by m.created_at asc, m.id asc`
      )
      .all(...(threadId ? [threadId] : [])) as Array<{
      thread_id: string;
      content: string;
    }>;
    const threadIds: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.thread_id)) continue;
      let content: AgentMessageContent;
      try {
        content = JSON.parse(row.content) as AgentMessageContent;
      } catch {
        continue;
      }
      if (!isFeatureTaskDispatchContent(content)) continue;
      seen.add(row.thread_id);
      threadIds.push(row.thread_id);
    }
    return threadIds;
  }

  hasQueuedFeatureEvents(threadId: string): boolean {
    const row = this.db
      .prepare(
        `select 1 as ok from agent_mailbox
       where thread_id = ? and status = 'queued' and event_kind = 'feature_event'
       limit 1`
      )
      .get(threadId) as { ok: number } | undefined;
    return Boolean(row);
  }

  drainMailboxToMessages(threadId: string, wakeId: string, limit = 50): AgentMessage[] {
    const delivered: AgentMessage[] = [];
    this.db.exec("begin immediate");
    try {
      const rows = this.db
        .prepare(
          `select id, thread_id, role, source, source_thread_id, content,
                trigger_turn, status, wake_id, delivered_message_id,
                created_at, delivered_at
         from agent_mailbox
         where thread_id = ? and status = 'queued' and event_kind = 'message'
         order by (source = 'restart-recovery') desc, created_at asc, id asc
         limit ?`
        )
        .all(threadId, limit) as RawMailbox[];
      if (rows.length === 0) {
        this.db.exec("commit");
        return delivered;
      }

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
          content: item.content
        });
        markDelivered.run(wakeId, message.id, now, item.id);
        delivered.push(message);
      }
      this.db.exec("commit");
      return delivered;
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
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
             coalesce(finished_at, started_at) as updatedAt
      from agent_wakes
      where thread_id = ?
        and last_input_tokens is not null
      order by coalesce(finished_at, started_at) desc, started_at desc, rowid desc
      limit 1
    `
      )
      .get(threadId) as { inputTokens: number | null; updatedAt: string | null } | undefined;
    const latestCompression = this.getLatestCompressionSummary(threadId);
    if (latestCompression && (!row?.updatedAt || latestCompression.created_at >= row.updatedAt)) {
      return {
        inputTokens: estimateMessagesTokens(this.getActiveMessages(threadId)),
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

/** Older messages a compression summary says should survive. Absent on rows
 *  written before the field existed, and on anything malformed — both derive
 *  as if nothing was retained, which is exactly the pre-field behaviour. */
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

function positiveIntegerOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
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

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}
