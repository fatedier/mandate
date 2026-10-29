import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../agent/tool-registry.js";
import { VOICE_TOOL_WAKE_ID, type HandoffService } from "./handoff-service.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { ManagerThreadService, threadDisplayTitle } from "../agent/manager-threads.js";
import type { ThreadArchive } from "../agent/thread-archive.js";
import { attentionInputs, listWaitingOnUser, type WaitingOnUserDeps } from "./waiting-on-user.js";
import { threadContextWord, threadStates } from "./thread-status.js";
import { errorText } from "../../../shared/error-text.js";
import { THREAD_NOTICE_LABEL } from "../../../shared/thread-notice.js";

interface GlobalReadToolDeps extends WaitingOnUserDeps {
  agentStore: AgentStore;
  featuresStore: FeaturesStore;
  workStore: WorkItemStore;
  projectsStore: ProjectsStore;
}

/** What the global agent reads that no manager tool gives it: the threads
 *  themselves, and the list Home shows. */
export function buildGlobalReadTools(deps: GlobalReadToolDeps): ToolDefinition[] {
  const threads = new ManagerThreadService({ agentStore: deps.agentStore });

  const listParams = z.object({
    archived: z.boolean().optional().describe("true lists the archived threads instead of the open ones.")
  }).strict();
  const listThreads: ToolDefinition<z.infer<typeof listParams>, unknown> = {
    name: "list_threads",
    description: "List the user's open threads: id, title, last activity, its state as the sidebar shows it (a stop with its reason), and how many workers each owns. With archived: true, the archived threads instead: id, title, and when each was archived.",
    parameters: listParams,
    handler: async ({ archived }) => {
      if (archived) {
        return {
          threads: deps.agentStore.listArchivedManagerThreads().map((t) => ({
            id: t.id, title: threadDisplayTitle(deps.agentStore, t.id), archivedAt: t.archivedAt
          }))
        };
      }
      const features = deps.featuresStore.listAllActive();
      const list = threads.list();
      // The one state each thread shows, read from the facts Home's list is.
      const inputs = attentionInputs(deps, list);
      const states = threadStates(inputs);
      return {
        threads: inputs.threads.map((t, i) => ({
          id: t.id,
          title: t.title,
          lastActivityAt: list[i]!.lastActivityAt,
          state: threadContextWord(t, states.get(t.id) ?? "idle"),
          stopReason: t.failure?.kind === "stopped" ? t.failure.reason : null,
          workerCount: features.filter((f) => f.ownerThreadId === t.id).length
        }))
      };
    }
  };

  const waiting: ToolDefinition<Record<string, never>, unknown> = {
    name: "waiting_on_you",
    description: "List what waits on the user, most urgent first: threads whose own turn failed or stopped, questions asked of them (by a thread's manager, or a worker's question nobody took up), and, when the manager stop check is on, threads whose latest reply waits for their decision or has a result for them to read.",
    parameters: z.object({}).strict(),
    // By the rule Home shows it by, so the agent and the page agree.
    handler: async () => ({ items: listWaitingOnUser(deps, threads.list()) })
  };

  return [listThreads, waiting] as ToolDefinition[];
}

/** A value the model gave, or undefined for a blank or null one. */
function given(value: string | null | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function buildGlobalActionTools(deps: { handoffs: HandoffService }): ToolDefinition[] {
  const spoken = (ctx: ToolContext) => ctx.wakeId === VOICE_TOOL_WAKE_ID;
  const attempt = <T>(fn: () => T): T | { error: string } => {
    try { return fn(); } catch (err) { return { error: errorText(err) }; }
  };

  const messageParams = z.object({
    featureId: z.string().min(1).describe("The worker's feature id, from list_features."),
    text: z.string().trim().min(1).max(20_000).describe("What to tell the worker, written for it. Put the user's own words in quotation marks.")
  });
  const messageFeature: ToolDefinition<z.infer<typeof messageParams>, unknown> = {
    name: "message_feature",
    description: "Send a message to a worker the user named. It arrives in the worker's Chat at once, marked as sent by you. You are woken once when that worker next stops.",
    parameters: messageParams,
    handler: async ({ featureId, text }, ctx) => attempt(() => ({
      handoff: deps.handoffs.sendToFeature({ globalThreadId: ctx.threadId, featureId, text, spoken: spoken(ctx) })
    }))
  };

  // The two ways to name where it goes take a blank or null as not given: a
  // model fills the one it does not mean.
  const sendParams = z.object({
    threadId: z.string().nullable().optional().describe("An open thread from list_threads."),
    newThreadTitle: z.string().max(80).nullable().optional().describe("A short title, to open a new thread for this instead."),
    text: z.string().trim().min(1).max(20_000).describe("The message. Put the user's own words in quotation marks. A thread already on the matter needs only those and what it has not seen; a new one also needs what the user wants. Add no requirements of your own."),
    answers: z.string().trim().min(1).optional().describe("When the message answers a question this thread's manager asked the user: that question, in the words you were given it. Leave it out for anything else, a question you asked the user yourself included: put their answer in the message.")
  });
  /** What the agent hears when it named a question the thread does not have. */
  const ANSWERS_DROPPED = "Sent without `answers`: that thread has no open question to answer.";
  const sendToThread: ToolDefinition<z.infer<typeof sendParams>, unknown> = {
    name: "send_to_thread",
    description: "Send work to a thread at once, or open a new thread for it. Give exactly one of threadId and newThreadTitle. No confirmation: tell the user where it went. You are woken once when that thread next stops.",
    parameters: sendParams,
    handler: async (args, ctx) => attempt(() => {
      const threadId = given(args.threadId);
      // An answer for a thread that asks nothing (most often to the agent's
      // own question) answers nothing there: the message goes as written. A
      // thread that asks something else still refuses it, for the agent to
      // name the right one.
      const dropped = args.answers !== undefined && !deps.handoffs.asksNow(threadId);
      const handoff = deps.handoffs.sendToThread({ globalThreadId: ctx.threadId, threadId, newThreadTitle: given(args.newThreadTitle), text: args.text, spoken: spoken(ctx), answers: dropped ? undefined : args.answers });
      // The note first: a result past what the model is shown is cut from
      // the end, and the handoff carries the whole message.
      return dropped ? { note: ANSWERS_DROPPED, handoff } : { handoff };
    })
  };

  const awaitParams = z.object({
    threadId: z.string().nullable().optional().describe("An open thread from list_threads."),
    featureId: z.string().nullable().optional().describe("A worker's feature id, from list_features.")
  });
  const awaitStop: ToolDefinition<z.infer<typeof awaitParams>, unknown> = {
    name: "await_stop",
    description: "Be woken once when a thread, or a worker, next stops, without sending anything into it. Give exactly one of threadId and featureId. If it has already stopped, nothing is armed and you are told how it stopped.",
    parameters: awaitParams,
    handler: async (args, ctx) => attempt(() => {
      const result = deps.handoffs.awaitStop({ globalThreadId: ctx.threadId, threadId: given(args.threadId), featureId: given(args.featureId) });
      return "stopped" in result
        ? { waiting: false, stopped: result.stopped, label: THREAD_NOTICE_LABEL[result.stopped] }
        : { waiting: true, handoff: result.handoff };
    })
  };

  return [messageFeature, sendToThread, awaitStop] as ToolDefinition[];
}

/** The global agent archives a thread, with its workers, through the same
 *  archive the thread's own dialog uses. Its prompt says when: only on the
 *  user's word. Each worker's cleanup is left to its own kind of workspace. */
export function buildGlobalArchiveTools(deps: { threadArchive: Pick<ThreadArchive, "archive"> }): ToolDefinition[] {
  const params = z.object({
    threadId: z.string().min(1).describe("An open thread from list_threads."),
    confirmedByUser: z.boolean().optional()
  });
  /** The workers each thread's refusals have named, by thread: what the
   *  agent has been able to show the user. Kept while the server runs; a
   *  restart forgets it, and the next call names them again. */
  const shown = new Map<string, string[]>();
  const archiveThread: ToolDefinition<z.infer<typeof params>, unknown> = {
    name: "archive_thread",
    description: "Archive a thread together with its workers, when the user asked for that thread to be archived. It refuses, changing nothing, while a worker has uncommitted files or work that is not in its base, and returns what it found for each worker: tell the user, and pass `confirmedByUser: true` only after they said to archive anyway. The thread moves to Archived in the sidebar, where the user can still read it but nothing more can be sent; the workers' records, chats and plans are kept.",
    parameters: params,
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
