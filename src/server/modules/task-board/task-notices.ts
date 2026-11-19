import type { AgentStore } from "../agent/agent-store.js";
import type { UpwardInbox, UpwardRoute } from "../agent/upward-inbox.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { AgentMessageContent } from "../../../shared/agent-message-types.js";
import type { StopVerdict } from "../../../shared/thread-dot.js";
import type { ThreadStop } from "../../../shared/thread-dot.js";
import { formatThreadNoticeText, threadNoticeMetadata, type ThreadNotice } from "../../../shared/thread-notice.js";
import type { TaskBoardService } from "./task-board-service.js";
import { logError } from "../../platform/logger.js";

/** What the personal agent is given of a linked thread's reply. */
const REPLY_MAX_CHARS = 4000;
const OPEN = new Set(["todo", "progress", "review"]);

/** The open tasks a thread is linked to, as a notice names them. */
export function openTasksOf(taskBoard: Pick<TaskBoardService, "tasksOfThread">): (threadId: string) => Array<{ id: string; title: string }> {
  return (threadId) => taskBoard.tasksOfThread(threadId).filter((t) => OPEN.has(t.status)).map((t) => ({ id: t.id, title: t.title }));
}

export interface TaskNoticesDeps {
  taskBoard: Pick<TaskBoardService, "tasksOfThread" | "detail" | "state">;
  agentStore: Pick<AgentStore, "getThreadById" | "latestReply" | "latestTurnEnd" | "latestPersonMessageSeq" | "latestPersonMessageBefore" | "roundStartSeq" | "getOrCreatePersonalThread" | "lastSeq">;
  workersStore: Pick<WorkersStore, "getById">;
  inbox: Pick<UpwardInbox, "post">;
  /** How a thread stands: null while it or a worker of its still works. */
  stopOf: (threadId: string) => ThreadStop | null;
  /** A hand-off wait on the thread is open: its end tells of the stop, and
   *  its notice names the task. */
  hasOpenWait: (threadId: string) => boolean;
  /** A duty thread reports by its own rule. */
  isDutyThread: (threadId: string) => boolean;
  /** The thread's manager has a question open to the user: the hand-off's
   *  question notice told the agent, naming the task. */
  asksUser: (threadId: string) => boolean;
  /** The owner is in the thread now (a window in use shows it): its stop is
   *  in front of them, as in their own round. */
  ownerInThread?: (threadId: string) => boolean;
  /** The manager stop check's verdict on a stopped thread's latest reply, as
   *  the hand-off waits for it: null when none will come (the check off). A
   *  verdict found is told through noteVerdict. */
  stopVerdict: (threadId: string) => Promise<StopVerdict | null> | null;
  /** Writes the told mark and the notice together. */
  transaction: <T>(work: () => T) => T;
}

/**
 * A linked thread's stop, told to the personal agent where today's rules
 * tell it nothing: a result or a failure wakes it, so it can move the task;
 * a decision or a question is a note it reads on its next turn. A stop in
 * the owner's own round is not told: their direct chat is, once it goes
 * quiet (direct-chats). One notice per reply, keyed by thread, naming the
 * task; what the task needs then is the agent's to judge.
 */
export function createTaskNotices(deps: TaskNoticesDeps): {
  toldByHandoff(threadId: string): void;
  noteSettled(threadId: string): void;
  noteVerdict(threadId: string, judged: { replySeq: number; outcome: StopVerdict }): void;
} {
  /** The manager thread a stop is about: the thread, or a worker's owner. */
  const managerThreadOf = (threadId: string): string | null => {
    const thread = deps.agentStore.getThreadById(threadId);
    if (!thread || thread.archivedAt) return null;
    if (thread.scope === "manager") return thread.id;
    if (thread.scope === "worker" && thread.scopeId) return deps.workersStore.getById(thread.scopeId)?.ownerThreadId ?? null;
    return null;
  };
  const openTasks = openTasksOf(deps.taskBoard);
  /** Not ours to tell: no open task, a duty thread (it reports by its own
   *  rule, naming the task), or a hand-off wait whose end will tell it. */
  const ours = (threadId: string) => {
    const tasks = openTasks(threadId);
    return tasks.length > 0 && !deps.isDutyThread(threadId) && !deps.hasOpenWait(threadId) ? tasks : null;
  };
  const toldKey = (threadId: string) => `told:${threadId}`;
  const toldSeq = (threadId: string) => Number(deps.taskBoard.state().getState(toldKey(threadId)) ?? 0);

  /** One notice per reply: marked told and posted in one write, the wake
   *  after it; refused, neither stays, and the next try tells it. */
  const tell = (target: string, seq: number, notice: ThreadNotice, body: string | null, route: Omit<UpwardRoute, "key">): void => {
    if (seq <= toldSeq(target)) return;
    const personal = deps.agentStore.getOrCreatePersonalThread();
    const text = body ? (body.length > REPLY_MAX_CHARS ? `${body.slice(0, REPLY_MAX_CHARS)}…` : body) : null;
    const wake = deps.transaction(() => {
      deps.taskBoard.state().setState(toldKey(target), String(seq));
      return deps.inbox.post({
        to: personal.id, key: `thread:${target}`, ...route, source: "thread-notice", sourceThreadId: target,
        content: { type: "text", text: formatThreadNoticeText(notice, text), metadata: threadNoticeMetadata(notice) }
      }).wake;
    });
    wake();
  };

  /** The thread's stop told by a hand-off notice: up to here, nothing more. */
  const toldByHandoff = (threadId: string) => {
    if (openTasks(threadId).length === 0) return;
    const seq = deps.agentStore.lastSeq(threadId);
    if (seq > toldSeq(threadId)) deps.taskBoard.state().setState(toldKey(threadId), String(seq));
  };

  const replyText = (message: { content: AgentMessageContent } | null) =>
    message?.content.type === "assistant" ? (message.content.text ?? "").trim() || null : null;
  const base = (target: string, tasks: ThreadNotice["tasks"]): Omit<ThreadNotice, "stop"> => ({
    handoffIds: [], kind: "thread", targetThreadId: target, workerId: null,
    title: deps.agentStore.getThreadById(target)?.title ?? "", reason: null, tasks
  });
  /** A stopped thread's latest reply, told with its verdict, or with none
   *  (the check off, or it gave none): a result wakes the agent; anything
   *  else is a note. The owner's own round is not told, nor a stop while
   *  they are in the thread. */
  const tellStopped = (target: string, tasks: NonNullable<ThreadNotice["tasks"]>, verdict: StopVerdict | null, replySeq?: number) => {
    if (deps.stopOf(target) !== "stopped") return;
    const reply = deps.agentStore.latestReply(target);
    // Moved on since: its own stop is told.
    if (!reply || (replySeq !== undefined && reply.seq !== replySeq) || deps.agentStore.latestPersonMessageSeq(target) > reply.seq) return;
    if (ownersRound(target, reply.seq, reply.wakeId ?? null) || deps.ownerInThread?.(target)) return;
    tell(target, reply.seq, { ...base(target, tasks), stop: "stopped", ...(verdict ? { verdict } : {}) },
      replyText(reply), { kind: verdict === "result" ? "report" : "note" });
  };

  /** The owner started the round the reply ends: they spoke since the
   *  thread's previous turn, and nobody relayed it. */
  const ownersRound = (target: string, replySeq: number, wakeId: string | null) => {
    const latest = deps.agentStore.latestPersonMessageBefore(target, replySeq);
    if (!latest || (latest.content.type === "text" && latest.content.relay)) return false;
    return latest.seq > deps.agentStore.roundStartSeq(target, replySeq, wakeId);
  };

  return {
    toldByHandoff,

    noteSettled(threadId) {
      const target = managerThreadOf(threadId);
      const tasks = target ? ours(target) : null;
      if (!target || !tasks) return;
      const stop = deps.stopOf(target);
      if (stop === "failed") {
        const reply = deps.agentStore.latestTurnEnd(target);
        tell(target, deps.agentStore.lastSeq(target), { ...base(target, tasks), stop: "failed" }, replyText(reply), { kind: "lifecycle", lifecycleReason: "failed" });
      } else if (stop === "needs_you") {
        // A question of its manager's was told when it was asked.
        if (deps.asksUser(target)) return;
        const reply = deps.agentStore.latestTurnEnd(target);
        if (reply) tell(target, reply.seq, { ...base(target, tasks), stop: "needs_you" }, replyText(reply), { kind: "note" });
      } else if (stop === "stopped") {
        // Its verdict tells it (noteVerdict); none to wait for, or none came
        // in time: what it said is a note.
        const reply = deps.agentStore.latestReply(target);
        const pending = deps.stopVerdict(target);
        if (!pending) {
          tellStopped(target, tasks, null);
          return;
        }
        void pending.then((found) => {
          if (found !== null) return;
          const now = ours(target);
          if (now) tellStopped(target, now, null, reply?.seq);
        }).catch((err: unknown) => logError("task-board-notice", err));
      }
    },

    noteVerdict(threadId, judged) {
      const tasks = ours(threadId);
      if (tasks) tellStopped(threadId, tasks, judged.outcome, judged.replySeq);
    }
  };
}
