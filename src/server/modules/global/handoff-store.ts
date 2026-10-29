import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import type { HandoffState } from "../../../shared/api/global-agent.js";
import { threadNoticeOf, type ThreadNoticeStop } from "../../../shared/thread-notice.js";
import type { AgentMessageContent } from "../../../shared/agent-message-types.js";

export interface HandoffRow {
  id: string;
  globalThreadId: string;
  kind: "feature" | "thread";
  state: HandoffState;
  text: string;
  spoken: boolean;
  featureId: string | null;
  targetThreadId: string | null;
  newThreadTitle: string | null;
  messageId: string | null;
  messageSeq: number | null;
  reply: string | null;
  reason: string | null;
  /** How the target stopped, once it has. */
  stop: ThreadNoticeStop | null;
  createdAt: string;
  updatedAt: string;
  repliedAt: string | null;
}

interface Raw {
  id: string; global_thread_id: string; kind: string; state: string; text: string; spoken: number;
  feature_id: string | null; target_thread_id: string | null; new_thread_title: string | null;
  message_id: string | null; message_seq: number | null; reply: string | null; reason: string | null;
  created_at: string; updated_at: string; replied_at: string | null; stop_state: string | null;
}

const COLUMNS = `id, global_thread_id, kind, state, text, spoken, feature_id, target_thread_id,
  new_thread_title, message_id, message_seq, reply, reason, created_at, updated_at, replied_at, stop_state`;

function toRow(r: Raw): HandoffRow {
  return {
    id: r.id, globalThreadId: r.global_thread_id, kind: r.kind as HandoffRow["kind"], state: r.state as HandoffState,
    text: r.text, spoken: r.spoken === 1, featureId: r.feature_id, targetThreadId: r.target_thread_id,
    newThreadTitle: r.new_thread_title, messageId: r.message_id, messageSeq: r.message_seq, reply: r.reply,
    reason: r.reason, stop: r.stop_state as ThreadNoticeStop | null, createdAt: r.created_at, updatedAt: r.updated_at, repliedAt: r.replied_at
  };
}

export class HandoffStore {
  constructor(private readonly db: Database) {}

  insert(input: Pick<HandoffRow, "globalThreadId" | "kind" | "state" | "text" | "spoken" | "featureId" | "targetThreadId" | "newThreadTitle">): HandoffRow {
    const id = newId("hof");
    const now = new Date().toISOString();
    this.db.prepare(
      `insert into global_handoffs (id, global_thread_id, kind, state, text, spoken, feature_id, target_thread_id, new_thread_title, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.globalThreadId, input.kind, input.state, input.text, input.spoken ? 1 : 0,
      input.featureId, input.targetThreadId, input.newThreadTitle, now, now);
    return this.get(id)!;
  }

  get(id: string): HandoffRow | null {
    const r = this.db.prepare(`select ${COLUMNS} from global_handoffs where id = ?`).get(id) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  /** Applies `patch` only while the row is in one of `from`; true when it did. */
  transition(id: string, from: readonly HandoffState[], patch: Partial<Pick<HandoffRow, "state" | "targetThreadId" | "messageId" | "messageSeq" | "reply" | "reason" | "repliedAt" | "newThreadTitle" | "stop">>): boolean {
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | number | null> = [new Date().toISOString()];
    const columns: Record<string, string> = {
      state: "state", targetThreadId: "target_thread_id", messageId: "message_id", messageSeq: "message_seq",
      reply: "reply", reason: "reason", repliedAt: "replied_at", newThreadTitle: "new_thread_title", stop: "stop_state"
    };
    for (const [key, column] of Object.entries(columns)) {
      if (Object.hasOwn(patch, key)) {
        sets.push(`${column} = ?`);
        values.push((patch as Record<string, string | number | null>)[key] ?? null);
      }
    }
    const placeholders = from.map(() => "?").join(", ");
    const res = this.db.prepare(`update global_handoffs set ${sets.join(", ")} where id = ? and state in (${placeholders})`)
      .run(...values, id, ...from);
    return res.changes > 0;
  }

  /** Removes a handoff whose message never went in; true when it did. */
  deleteQueued(id: string): boolean {
    return this.db.prepare(`delete from global_handoffs where id = ? and state = 'queued'`).run(id).changes > 0;
  }

  listByTarget(threadId: string, states: readonly HandoffState[]): HandoffRow[] {
    const placeholders = states.map(() => "?").join(", ");
    return (this.db.prepare(`select ${COLUMNS} from global_handoffs where target_thread_id = ? and state in (${placeholders}) order by created_at asc`)
      .all(threadId, ...states) as Raw[]).map(toRow);
  }

  listByState(states: readonly HandoffState[]): HandoffRow[] {
    const placeholders = states.map(() => "?").join(", ");
    return (this.db.prepare(`select ${COLUMNS} from global_handoffs where state in (${placeholders}) order by created_at asc`)
      .all(...states) as Raw[]).map(toRow);
  }

  listRecent(globalThreadId: string, limit: number): HandoffRow[] {
    return (this.db.prepare(`select ${COLUMNS} from global_handoffs where global_thread_id = ? order by created_at desc, rowid desc limit ?`)
      .all(globalThreadId, limit) as Raw[]).map(toRow);
  }

  /** The given ids of one global thread, in the order given; unknown ones skipped. */
  listByIds(globalThreadId: string, ids: readonly string[]): HandoffRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = (this.db.prepare(`select ${COLUMNS} from global_handoffs where global_thread_id = ? and id in (${placeholders})`)
      .all(globalThreadId, ...ids) as Raw[]).map(toRow);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  /** Each conversation whose message reached `targetThreadId`, and when it
   *  last sent one that did. A wait alone sends none; a send lost before it
   *  went in reached nothing. */
  sendersTo(targetThreadId: string): Array<{ globalThreadId: string; lastSentAt: string }> {
    return (this.db.prepare(
      `select global_thread_id, max(created_at) as last_sent
         from global_handoffs where target_thread_id = ? and message_seq is not null group by global_thread_id`
    ).all(targetThreadId) as Array<{ global_thread_id: string; last_sent: string }>)
      .map((r) => ({ globalThreadId: r.global_thread_id, lastSentAt: r.last_sent }));
  }

  /** What the waits of `globalThreadId` on `targetThreadId` that ended at or
   *  after `at` told of the thread's reply, each as it was kept. */
  repliesToldAfter(globalThreadId: string, targetThreadId: string, at: string): string[] {
    return (this.db.prepare(
      `select reply from global_handoffs
        where global_thread_id = ? and target_thread_id = ? and replied_at >= ? and reply is not null`
    ).all(globalThreadId, targetThreadId, at) as Array<{ reply: string }>).map((r) => r.reply);
  }

  /** The agent's conversations told of question `questionId` of
   *  `targetThreadId`: by a notice there, or one still in the mailbox. */
  toldOfQuestion(targetThreadId: string, questionId: string): string[] {
    const rows = this.db.prepare(
      `select thread_id, content from agent_messages
        where thread_id in (select id from agent_threads where scope = 'global')
          and source = 'thread-notice' and instr(content, ?) > 0
       union all
       select thread_id, content from agent_mailbox
        where thread_id in (select id from agent_threads where scope = 'global')
          and source = 'thread-notice' and status = 'queued' and instr(content, ?) > 0`
    ).all(questionId, questionId) as Array<{ thread_id: string; content: string }>;
    const told = new Set<string>();
    for (const row of rows) {
      const notice = threadNoticeOf(JSON.parse(row.content) as AgentMessageContent);
      if (notice?.targetThreadId === targetThreadId && notice.question?.id === questionId) told.add(row.thread_id);
    }
    return [...told];
  }
}
