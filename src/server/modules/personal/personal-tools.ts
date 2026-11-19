import type { TaskBoardService } from "../task-board/task-board-service.js";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../agent/tool-registry.js";
import { VOICE_TOOL_WAKE_ID, type HandoffService } from "./handoff-service.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { ManagerThreadService, threadDisplayTitle } from "../agent/manager-threads.js";
import type { ThreadArchive } from "../agent/thread-archive.js";
import { ThreadLabelRefusal, type ThreadLabels } from "../agent/thread-labels.js";
import { attentionInputs, listWaitingOnUser, type WaitingOnUserDeps } from "./waiting-on-user.js";
import { threadContextWord, threadStates } from "./thread-status.js";
import { errorText } from "../../../shared/error-text.js";
import { THREAD_NOTICE_LABEL } from "../../../shared/thread-notice.js";
import { archiveThreadParams, awaitStopParams, labelThreadParams, listThreadsParams, messageWorkerParams, noParams, sendToThreadParams } from "./personal-tools-schema.js";

interface PersonalReadToolDeps extends WaitingOnUserDeps {
  agentStore: AgentStore;
  workersStore: WorkersStore;
  workStore: WorkItemStore;
  projectsStore: ProjectsStore;
}

/** What the personal agent reads that no manager tool gives it: the threads
 *  themselves, and the list Home shows. */
export function buildPersonalReadTools(deps: PersonalReadToolDeps): ToolDefinition[] {
  const threads = new ManagerThreadService({ agentStore: deps.agentStore });
  const labelNames = (threadId: string) => deps.agentStore.threadLabels(threadId).map((label) => label.name);

  const listThreads: ToolDefinition<z.infer<typeof listThreadsParams>, unknown> = {
    name: "list_threads",
    description: "List the user's open threads: id, title, labels, last activity, its state as the sidebar shows it (a stop with its reason), and how many workers each owns. With archived: true, the archived threads instead: id, title, labels, and when each was archived.",
    parameters: listThreadsParams,
    handler: async ({ archived }) => {
      if (archived) {
        return {
          threads: deps.agentStore.listArchivedManagerThreads().map((t) => ({
            id: t.id, title: threadDisplayTitle(deps.agentStore, t.id), labels: labelNames(t.id), archivedAt: t.archivedAt
          }))
        };
      }
      const workers = deps.workersStore.listAllActive();
      const list = threads.list();
      // The one state each thread shows, read from the facts Home's list is.
      const inputs = attentionInputs(deps, list);
      const states = threadStates(inputs);
      return {
        threads: inputs.threads.map((t, i) => ({
          id: t.id,
          title: t.title,
          labels: labelNames(t.id),
          lastActivityAt: list[i]!.lastActivityAt,
          state: threadContextWord(t, states.get(t.id) ?? "idle"),
          stopReason: t.failure?.kind === "stopped" ? t.failure.reason : null,
          workerCount: workers.filter((w) => w.ownerThreadId === t.id).length
        }))
      };
    }
  };

  const waiting: ToolDefinition<Record<string, never>, unknown> = {
    name: "waiting_on_you",
    description: "List what waits on the user, most urgent first: threads whose own turn failed or stopped, questions asked of them (by a thread's manager, or a worker's question nobody took up), and, when the manager stop check is on, threads whose latest reply waits for their decision or has a result for them to read.",
    parameters: noParams,
    // By the rule Home shows it by, so the agent and the page agree.
    handler: async () => ({ items: listWaitingOnUser(deps, threads.list()) })
  };

  return [listThreads, waiting] as ToolDefinition[];
}

/** A value the model gave, or undefined for a blank or null one. */
function given(value: string | null | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function buildPersonalActionTools(deps: { handoffs: HandoffService; taskBoard?: Pick<TaskBoardService, "detail" | "link"> }): ToolDefinition[] {
  const spoken = (ctx: ToolContext) => ctx.wakeId === VOICE_TOOL_WAKE_ID;
  const attempt = <T>(fn: () => T): T | { error: string } => {
    try { return fn(); } catch (err) { return { error: errorText(err) }; }
  };

  const messageWorker: ToolDefinition<z.infer<typeof messageWorkerParams>, unknown> = {
    name: "message_worker",
    description: "Send a message to a worker the user named. It arrives in the worker's Chat at once, marked as sent by you. You are woken once when that worker next stops.",
    parameters: messageWorkerParams,
    handler: async ({ workerId, text }, ctx) => attempt(() => ({
      handoff: deps.handoffs.sendToWorker({ personalThreadId: ctx.threadId, workerId, text, spoken: spoken(ctx) })
    }))
  };

  /** What the agent hears when it named a question the thread does not have. */
  const ANSWERS_DROPPED = "Sent without `answers`: that thread has no open question to answer.";
  const sendToThread: ToolDefinition<z.infer<typeof sendToThreadParams>, unknown> = {
    name: "send_to_thread",
    description: "Send work to a thread at once, or open a new thread for it. Give exactly one of threadId and newThreadTitle. No confirmation: tell the user where it went. You are woken once when that thread next stops.",
    parameters: sendToThreadParams,
    handler: async (args, ctx) => attempt(() => {
      const threadId = given(args.threadId);
      // The task is checked before anything is sent: a send that went out
      // unlinked would leave the thread off its task.
      const taskId = given(args.taskId);
      if (taskId && deps.taskBoard) {
        const task = deps.taskBoard.detail(taskId);
        if (!task || task.deletedAt) return { error: `No such task: ${taskId}.` };
      }
      // An answer for a thread that asks nothing (most often to the agent's
      // own question) answers nothing there: the message goes as written. A
      // thread that asks something else still refuses it, for the agent to
      // name the right one.
      const dropped = args.answers !== undefined && !deps.handoffs.asksNow(threadId);
      const handoff = deps.handoffs.sendToThread({ personalThreadId: ctx.threadId, threadId, newThreadTitle: given(args.newThreadTitle), text: args.text, spoken: spoken(ctx), answers: dropped ? undefined : args.answers, ...(taskId ? { taskId } : {}) });
      if (taskId && deps.taskBoard && handoff.threadId) deps.taskBoard.link(taskId, handoff.threadId, { newThread: handoff.newThreadTitle !== null });
      // The note first: a result past what the model is shown is cut from
      // the end, and the handoff carries the whole message.
      return dropped ? { note: ANSWERS_DROPPED, handoff } : { handoff };
    })
  };

  const awaitStop: ToolDefinition<z.infer<typeof awaitStopParams>, unknown> = {
    name: "await_stop",
    description: "Be woken once when a thread, or a worker, next stops, without sending anything into it. Give exactly one of threadId and workerId. If it has already stopped, nothing is armed and you are told how it stopped.",
    parameters: awaitStopParams,
    handler: async (args, ctx) => attempt(() => {
      const result = deps.handoffs.awaitStop({ personalThreadId: ctx.threadId, threadId: given(args.threadId), workerId: given(args.workerId) });
      return "stopped" in result
        ? { waiting: false, stopped: result.stopped, label: THREAD_NOTICE_LABEL[result.stopped] }
        : { waiting: true, handoff: result.handoff };
    })
  };

  return [messageWorker, sendToThread, awaitStop] as ToolDefinition[];
}

/** The personal agent archives a thread, with its workers, through the same
 *  archive the thread's own dialog uses. Its prompt says when: only on the
 *  user's word. Each worker's cleanup is left to its own kind of workspace. */
export function buildPersonalArchiveTools(deps: { threadArchive: Pick<ThreadArchive, "archive"> }): ToolDefinition[] {
  /** The workers each thread's refusals have named, by thread: what the
   *  agent has been able to show the user. Kept while the server runs; a
   *  restart forgets it, and the next call names them again. */
  const shown = new Map<string, string[]>();
  const archiveThread: ToolDefinition<z.infer<typeof archiveThreadParams>, unknown> = {
    name: "archive_thread",
    description: "Archive a thread together with its workers, when the user asked for that thread to be archived. It refuses, changing nothing, while a worker has uncommitted files or work that is not in its base, and returns what it found for each worker: tell the user, and pass `confirmedByUser: true` only after they said to archive anyway. The thread moves to the Archived tab of the Threads page, where the user can still read it but nothing more can be sent; the workers' records, chats and plans are kept.",
    parameters: archiveThreadParams,
    handler: async (args) => {
      // The user's word is for what the agent could tell them: the workers
      // the refusals of this thread named. Given before any refusal, it
      // confirms nothing, and a worker that appears later is named first.
      const result = await deps.threadArchive.archive({
        threadId: args.threadId,
        confirmed: args.confirmedByUser === true ? shown.get(args.threadId) ?? [] : []
      });
      if (result.ok || result.status === 404) shown.delete(args.threadId);
      else shown.set(args.threadId, [...new Set([...(shown.get(args.threadId) ?? []), ...result.workers.map((worker) => worker.id)])]);
      if (result.ok) {
        return {
          ok: true,
          threadId: args.threadId,
          archivedWorkers: result.workers.map((worker) => worker.name),
          ...(result.cleanupFailures.length > 0 ? { cleanupFailures: result.cleanupFailures } : {})
        };
      }
      if (result.status === 404) return { error: result.error };
      return {
        error: result.error,
        workers: result.workers,
        ...(result.archived.length > 0 ? { archivedWorkers: result.archived.map((worker) => worker.name) } : {}),
        ...(result.cleanupFailures.length > 0 ? { cleanupFailures: result.cleanupFailures } : {})
      };
    }
  };
  return [archiveThread];
}

/** The personal agent labels a thread, as itself: a label it puts on shows
 *  as its own, and the user can take it off. */
export function buildPersonalLabelTools(deps: { threadLabels: Pick<ThreadLabels, "add" | "remove"> }): ToolDefinition[] {
  const labelThread: ToolDefinition<z.infer<typeof labelThreadParams>, unknown> = {
    name: "label_thread",
    description: "Add a label to a thread, or take one off with remove: true. Labels are a word or two the user sorts and filters threads by, shared with the task board's. Use a label already in use when one fits.",
    parameters: labelThreadParams,
    handler: async ({ threadId, label, remove }) => {
      try {
        const labels = remove === true ? deps.threadLabels.remove(threadId, label) : deps.threadLabels.add(threadId, label, "agent");
        return { labels: labels.map((entry) => entry.name) };
      } catch (err) {
        if (err instanceof ThreadLabelRefusal) return { error: err.message };
        throw err;
      }
    }
  };
  return [labelThread];
}
