import type { ManagerThreadDto } from "../../../shared/api/agents.js";
import { isAsking } from "../../../shared/worker-state.js";
import { WAITING_WORD, type WaitingKind } from "../../../shared/status-words.js";
import { threadStop, type HeldBackSignal, type WaitKind } from "../../../shared/thread-dot.js";
import type { CurrentVerdict } from "../../../shared/api/thread-status.js";
import { attentionEntries, type AttentionThread, type AttentionWorker } from "../../../shared/waiting-on-user.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { PlanStateView, PlanStore } from "../plans/plan-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { workerSignal } from "./thread-signals.js";

export interface WaitingOnUserDeps {
  agentStore: Pick<AgentStore, "getThreadByScope" | "getLatestWakeForThread">;
  workersStore: Pick<WorkersStore, "listAllActive">;
  projectsStore: Pick<ProjectsStore, "listActive">;
  workStore: Pick<WorkItemStore, "getByWorker">;
  /** Every active worker's plan, as its state reads it. */
  planStore: Pick<PlanStore, "statesOfActive">;
  /** A turn running, or a message waiting to start one. Absent: nothing runs. */
  isBusy?: (threadId: string) => boolean;
  /** What the thread sleeps on (leadWait), if anything. Absent: nothing watches. */
  waitKind?: (threadId: string) => WaitKind | null;
  /** The manager stop check's verdict that shows now (ManagerStopCheck.current), read only
   *  for a thread that has stopped. Absent: none. */
  verdictOf?: (threadId: string) => CurrentVerdict | null;
  /** The tool-call review's mark on a thread, if any. Absent: none. */
  heldBack?: (threadId: string) => HeldBackSignal | null;
}

/** A worker that has written no plan yet. */
function noPlan(workerId: string): PlanStateView {
  return { workerId, openQuestions: [], conclusion: null, steps: [] };
}

/** One thing that waits on the user, as the personal agent is told of it. */
export type WaitingOnUserItem =
  | { kind: "question"; threadId: string; threadTitle: string; label: string; waiting: WaitingKind; question: string }
  | { kind: "worker"; workerId: string; workerName: string; label: string; waiting: WaitingKind; question?: string; threadId: string | null; threadTitle: string | null }
  | { kind: "thread"; threadId: string; threadTitle: string; label: string; waiting: WaitingKind; reason: string };

/** The facts the attention rule reads, gathered once for every reader: each
 *  open thread, and every active worker in the user's project order (each
 *  project's workers oldest first). */
export function attentionInputs(
  deps: WaitingOnUserDeps,
  threads: readonly ManagerThreadDto[]
): { threads: AttentionThread[]; workers: AttentionWorker[] } {
  const isBusy = deps.isBusy ?? (() => false);
  const waitKind = deps.waitKind ?? (() => null);
  const projects = deps.projectsStore.listActive();
  const projectOrder = new Map(projects.map((project, index) => [project.id, index]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const activeWorkers = [...deps.workersStore.listAllActive()]
    .sort((a, b) => (projectOrder.get(a.projectId) ?? Number.MAX_SAFE_INTEGER) - (projectOrder.get(b.projectId) ?? Number.MAX_SAFE_INTEGER));
  const plans = deps.planStore.statesOfActive();
  const workers = activeWorkers.map((worker): AttentionWorker => {
    const plan = plans.get(worker.id) ?? noPlan(worker.id);
    const signal = workerSignal({ ...deps, isBusy, waitKind }, worker.id, plan);
    const project = projectById.get(worker.projectId);
    return {
      workerId: worker.id,
      ownerThreadId: worker.ownerThreadId ?? null,
      name: worker.name,
      place: project ? { projectName: project.name, projectSlug: project.tmuxSessionName, workerSlug: worker.tmuxWindowName } : null,
      asking: isAsking(plan),
      question: plan.openQuestions[0] ?? null,
      running: signal.running,
      watching: signal.watching ?? null,
      stepInProgress: signal.stepInProgress,
      waiting: signal.waiting,
      heldBack: signal.heldBack ?? null
    };
  });
  return {
    threads: threads.map((thread): AttentionThread => {
      const running = thread.running || isBusy(thread.id);
      const watching = waitKind(thread.id);
      const questions = thread.questions.map((q) => q.question);
      const heldBack = deps.heldBack?.(thread.id) ?? null;
      // A verdict shows only while the thread has stopped on its reply:
      // working again, waiting on something, failed or asking, it is that.
      const stop = threadStop(
        { running, failed: thread.failed, watching, asking: questions.length > 0, heldBack },
        workers.filter((worker) => worker.ownerThreadId === thread.id)
      );
      const verdict = stop === "stopped" ? deps.verdictOf?.(thread.id) ?? null : null;
      return {
        id: thread.id,
        title: thread.title,
        running,
        watching,
        // The last turn failed until another one starts (the DTO reads the
        // latest wake): what is queued or due behind it may never run.
        failure: thread.failed
          ? thread.stopReason !== null
            ? { kind: "stopped", reason: thread.stopReason }
            : { kind: "error", reason: deps.agentStore.getLatestWakeForThread(thread.id)?.errorMessage ?? "" }
          : null,
        questions,
        verdict: verdict ? { kind: verdict.verdict, replyText: verdict.replyText } : null,
        heldBack
      };
    }),
    workers
  };
}

/** What waits on the user, most urgent first, by the rule Home shows it by
 *  (attentionEntries), without the personal agent's own questions: it is the
 *  one asking them. */
export function listWaitingOnUser(
  deps: WaitingOnUserDeps,
  threads: readonly ManagerThreadDto[],
  inputs: ReturnType<typeof attentionInputs> = attentionInputs(deps, threads)
): WaitingOnUserItem[] {
  return attentionEntries(inputs.threads, inputs.workers).flatMap((entry): WaitingOnUserItem[] => {
    const label = WAITING_WORD[entry.waiting];
    if (entry.kind === "question" && entry.threadId) {
      return [{ kind: "question", threadId: entry.threadId, threadTitle: entry.threadTitle ?? "", label, waiting: entry.waiting, question: entry.text }];
    }
    if (entry.kind === "thread" && entry.threadId) {
      return [{ kind: "thread", threadId: entry.threadId, threadTitle: entry.threadTitle ?? "", label, waiting: entry.waiting, reason: entry.text }];
    }
    if (entry.kind === "worker" && entry.workerId) {
      return [{
        kind: "worker", workerId: entry.workerId, workerName: entry.workerName ?? entry.workerId, label, waiting: entry.waiting,
        question: entry.text, threadId: entry.threadId, threadTitle: entry.threadTitle
      }];
    }
    return [];
  });
}
