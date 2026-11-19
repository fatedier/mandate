import type { Database } from "bun:sqlite";
import type { AgentStore } from "../agent/agent-store.js";
import { threadDisplayTitle } from "../agent/manager-threads.js";
import { cutKeepingWhole } from "../agent/tool-output-spool.js";
import type { AgentMessageContent } from "../../../shared/agent-message-types.js";
import type { StopVerdict, ThreadStop } from "../../../shared/thread-dot.js";
import { sentByControl } from "../../../shared/questions.js";
import type { ThreadNotice } from "../../../shared/thread-notice.js";
import { logError } from "../../platform/logger.js";

/** How long the user is quiet in a thread before their direct chat with it is
 *  told to the personal agent. */
export const DIRECT_CHAT_QUIET_MS = 15 * 60_000;
/** Words older than this are no chat to tell: after a long outage, or a
 *  thread that worked on for hours, they are old news. */
export const DIRECT_CHAT_LOOKBACK_MS = 6 * 3_600_000;
/** What the agent is given of what the user said, and of the latest reply. */
const CHAT_TEXT_MAX_CHARS = 1500;

export interface DirectChatsDeps {
  db: Database;
  agentStore: Pick<AgentStore, "getThreadById" | "firstUserLine" | "openPersonalThread" | "latestReply">;
  /** A duty thread tells the user's rounds with it by its own rule. */
  isDutyThread: (threadId: string) => boolean;
  /** How the thread stands: null while it or a worker of its still works. */
  stopOf: (threadId: string) => ThreadStop | null;
  /** The manager stop check's verdict on the thread's latest reply, as the
   *  hand-off waits for it; null when none will come. */
  verdictOf: (threadId: string) => Promise<StopVerdict | null> | null;
  /** The owner's open tasks the thread is linked to. */
  tasksOf?: (threadId: string) => Array<{ id: string; title: string }>;
  /** Writes the notice to the personal agent; what it returns wakes it, once
   *  the write has committed. */
  post: (personalThreadId: string, notice: ThreadNotice, lastReply: string | null) => () => void;
  now?: () => number;
}

interface Words { threadId: string; seq: number; saidAt: string; text: string }

/**
 * The user's direct chats with manager threads. While they talk with a
 * thread themselves, the personal agent is not told round by round; once
 * they have been quiet there for DIRECT_CHAT_QUIET_MS and the thread has
 * stopped working, it is told once, and woken: what they said, where the
 * thread stands. The words told are marked in the database, so a restart
 * tells nothing twice.
 */
export function createDirectChats(deps: DirectChatsDeps): { tick(): Promise<void> } {
  const now = deps.now ?? Date.now;
  const toldSeq = (threadId: string): number => {
    const row = deps.db.prepare("select told_seq from personal_direct_chats where thread_id = ?").get(threadId) as { told_seq: number } | undefined;
    return row?.told_seq ?? 0;
  };
  let running: Promise<void> | null = null;

  /** The user's own words in `threadId` after `afterSeq`, none said before
   *  `since`, oldest first, each with when it was said: typed or spoken, not
   *  what the personal agent passed on. */
  const wordsOf = (threadId: string, afterSeq: number, since: string): Words[] => {
    const rows = deps.db.prepare(
      `select seq, created_at, content from agent_messages
        where thread_id = ? and role = 'user' and source in ('user', 'voice') and seq > ? and created_at >= ?
        order by seq`
    ).all(threadId, afterSeq, since) as Array<{ seq: number; created_at: string; content: string }>;
    return rows.flatMap((row): Words[] => {
      let content: AgentMessageContent;
      try {
        content = JSON.parse(row.content) as AgentMessageContent;
      } catch {
        return [];
      }
      // Continue pressed under a stopped turn is the user's, but no words.
      if (content.type !== "text" || content.relay || sentByControl(content)) return [];
      // Sent while the thread worked, it waited before the thread took it
      // in: it was said when it reached Mandate.
      const said = content.arrivedAt && Number.isFinite(Date.parse(content.arrivedAt)) ? content.arrivedAt : row.created_at;
      if (said < since) return [];
      return [{ threadId, seq: row.seq, saidAt: said, text: content.text.trim() }];
    });
  };

  /** The chat of `threadId` due to be told at `at`, or null: an open manager
   *  thread that is no duty thread, with words not told yet, the user quiet
   *  there for DIRECT_CHAT_QUIET_MS, and the thread not working. With it, the
   *  reply it would carry. */
  const dueChat = (threadId: string, at: number): { words: Words[]; reply: ReturnType<DirectChatsDeps["agentStore"]["latestReply"]> } | null => {
    const thread = deps.agentStore.getThreadById(threadId);
    if (!thread || thread.scope !== "manager" || thread.archivedAt || deps.isDutyThread(threadId)) return null;
    const words = wordsOf(threadId, toldSeq(threadId), new Date(at - DIRECT_CHAT_LOOKBACK_MS).toISOString());
    const last = words.at(-1);
    if (!last || at - Date.parse(last.saidAt) < DIRECT_CHAT_QUIET_MS) return null;
    if (deps.stopOf(threadId) === null) return null;
    return { words, reply: deps.agentStore.latestReply(threadId) };
  };

  const tellOne = async (threadId: string): Promise<void> => {
    const asked = dueChat(threadId, now());
    if (!asked || !deps.agentStore.openPersonalThread()) return;
    const verdict = await (deps.verdictOf(threadId) ?? Promise.resolve(null));
    // The mark and the notice are written together: refused, neither stays,
    // and the next round tells it. The wake comes after the commit.
    const wake = deps.db.transaction(() => {
      // Read again: what changed while the verdict was awaited decides. A word
      // since waits on; a newer reply than the one judged waits for a round
      // that judges it.
      const at = now();
      const chat = dueChat(threadId, at);
      const personal = deps.agentStore.openPersonalThread();
      const last = chat?.words.at(-1);
      if (!chat || !last || !personal || last.seq !== asked.words.at(-1)!.seq || chat.reply?.seq !== asked.reply?.seq) return null;
      const said = chat.words.map((w) => w.text).filter(Boolean).join("\n\n");
      const replyText = chat.reply?.content.type === "assistant" ? chat.reply.content.text?.trim() ?? "" : "";
      const tasks = deps.tasksOf?.(threadId) ?? [];
      const notice: ThreadNotice = {
        handoffIds: [],
        kind: "thread",
        targetThreadId: threadId,
        workerId: null,
        title: threadDisplayTitle(deps.agentStore, threadId),
        stop: "chat",
        reason: null,
        chat: { from: chat.words[0]!.saidAt, to: last.saidAt, messages: chat.words.length },
        words: cutKeepingWhole(said, CHAT_TEXT_MAX_CHARS, { threadId: personal.id }),
        ...(verdict === "decision" ? { verdict } : {}),
        ...(tasks.length > 0 ? { tasks } : {})
      };
      const lastReply = replyText ? cutKeepingWhole(replyText, CHAT_TEXT_MAX_CHARS, { threadId: personal.id }) : null;
      deps.db.prepare(
        `insert into personal_direct_chats (thread_id, told_seq, told_at) values (?, ?, ?)
          on conflict(thread_id) do update set told_seq = excluded.told_seq, told_at = excluded.told_at`
      ).run(threadId, last.seq, new Date(at).toISOString());
      return deps.post(personal.id, notice, lastReply);
    }).immediate();
    wake?.();
  };

  /** The threads the user wrote in lately: each may hold a chat gone quiet. */
  const threadsWrittenIn = (at: number): string[] => (deps.db.prepare(
    `select distinct thread_id from agent_messages
      where role = 'user' and source in ('user', 'voice') and created_at >= ?`
  ).all(new Date(at - DIRECT_CHAT_LOOKBACK_MS).toISOString()) as Array<{ thread_id: string }>).map((row) => row.thread_id);

  const round = async (): Promise<void> => {
    for (const threadId of threadsWrittenIn(now())) {
      try {
        await tellOne(threadId);
      } catch (err) {
        logError(`direct chat of thread ${threadId}`, err);
      }
    }
  };

  return {
    /** One round over the chats gone quiet; a round asked for while one runs
     *  is that one. */
    tick() {
      running ??= round().finally(() => { running = null; });
      return running;
    }
  };
}
