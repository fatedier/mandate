import type { ThreadStatusSnapshotDto } from "../../../shared/api/thread-status.js";
import { CONTEXT_WORD } from "../../../shared/status-words.js";
import { threadDot, type ThreadDot } from "../../../shared/thread-dot.js";
import { attentionEntries, type AttentionThread, type AttentionWorker } from "../../../shared/waiting-on-user.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { ManagerThreadService } from "../agent/manager-threads.js";
import type { ThreadSignalDeps } from "./thread-signals.js";
import { attentionInputs, type WaitingOnUserDeps } from "./waiting-on-user.js";

/** What the snapshot reads: the stores, the open manager threads, what the
 *  runtime knows of each thread (busy, what it waits on), and the questions
 *  Your agent asked the user. */
export interface ThreadStatusDeps extends Omit<ThreadSignalDeps, "featuresStore">, Omit<WaitingOnUserDeps, "featuresStore" | "agentStore" | "isBusy" | "waitKind"> {
  featuresStore: Pick<FeaturesStore, "listAllActive" | "listActiveOwnedBy">;
  managerThreads: Pick<ManagerThreadService, "list">;
  agentQuestions: () => readonly string[];
}

/** Each open thread's one state, from the facts the attention rule reads:
 *  the sidebar's, and what Your agent reads. */
export function threadStates(inputs: { threads: readonly AttentionThread[]; workers: readonly AttentionWorker[] }): Map<string, ThreadDot> {
  return new Map(inputs.threads.map((thread) => [thread.id, threadDot(
    { running: thread.running, failed: thread.failure !== null, watching: thread.watching, asking: thread.questions.length > 0, verdict: thread.verdict?.kind ?? null },
    inputs.workers.filter((worker) => worker.ownerThreadId === thread.id)
  )]));
}

/** A thread's state in Your agent's words (CONTEXT_WORD): a stop told apart
 *  from a failure. */
export function threadContextWord(thread: Pick<AttentionThread, "failure">, state: ThreadDot): string {
  return CONTEXT_WORD[state === "failed" && thread.failure?.kind === "stopped" ? "stopped" : state];
}

/** Every open manager thread's state and what waits on the user, worked out
 *  once from one set of facts, for every surface that shows them. */
export function threadStatusSnapshot(deps: ThreadStatusDeps): ThreadStatusSnapshotDto {
  const dtos = deps.managerThreads.list();
  const inputs = attentionInputs(deps, dtos);
  const threads = [...threadStates(inputs)].map(([threadId, state]) => ({ threadId, state }));
  return { threads, waiting: attentionEntries(inputs.threads, inputs.workers, deps.agentQuestions()) };
}
