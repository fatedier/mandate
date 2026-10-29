import type { ManagerThreadDto } from "../../../shared/api/agents.js";
import { isAsking } from "../../../shared/feature-state.js";
import { WAITING_WORD, type WaitingKind } from "../../../shared/status-words.js";
import { threadStop, type WaitKind } from "../../../shared/thread-dot.js";
import type { CurrentVerdict } from "../../../shared/api/thread-status.js";
import { attentionEntries, type AttentionThread, type AttentionWorker } from "../../../shared/waiting-on-user.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { PlanStore } from "../plans/plan-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { workerSignal } from "./thread-signals.js";

export interface WaitingOnUserDeps {
  agentStore: Pick<AgentStore, "getThreadByScope" | "getLatestWakeForThread">;
  featuresStore: Pick<FeaturesStore, "listAllActive">;
  projectsStore: Pick<ProjectsStore, "listActive">;
  workStore: Pick<WorkItemStore, "getByFeature">;
  planStore: Pick<PlanStore, "get">;
  /** A turn running, or a message waiting to start one. Absent: nothing runs. */
  isBusy?: (threadId: string) => boolean;
  /** What the thread sleeps on (leadWait), if anything. Absent: nothing watches. */
  waitKind?: (threadId: string) => WaitKind | null;
  /** The manager stop check's verdict that shows now (ManagerStopCheck.current), read only
   *  for a thread that has stopped. Absent: none. */
  verdictOf?: (threadId: string) => CurrentVerdict | null;
}

/** One thing that waits on the user, as the global agent is told of it. */
export type WaitingOnUserItem =
  | { kind: "question"; threadId: string; threadTitle: string; label: string; waiting: WaitingKind; question: string }
  | { kind: "worker"; featureId: string; workerName: string; label: string; waiting: WaitingKind; question?: string; threadId: string | null; threadTitle: string | null }
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
  const features = [...deps.featuresStore.listAllActive()]
    .sort((a, b) => (projectOrder.get(a.projectId) ?? Number.MAX_SAFE_INTEGER) - (projectOrder.get(b.projectId) ?? Number.MAX_SAFE_INTEGER));
  const workers = features.map((feature): AttentionWorker => {
    const plan = deps.planStore.get(feature.id);
    const signal = workerSignal({ ...deps, isBusy, waitKind }, feature.id, plan);
    const project = projectById.get(feature.projectId);
    return {
      featureId: feature.id,
      ownerThreadId: feature.ownerThreadId ?? null,
      name: feature.name,
      place: project ? { projectName: project.name, projectSlug: project.tmuxSessionName, featureSlug: feature.tmuxWindowName } : null,
      asking: isAsking(plan),
      question: plan.openQuestions[0] ?? null,
      running: signal.running,
      watching: signal.watching ?? null,
      stepInProgress: signal.stepInProgress,
      waiting: signal.waiting
    };
  });
  return {
    threads: threads.map((thread): AttentionThread => {
      const running = thread.running || isBusy(thread.id);
      const watching = waitKind(thread.id);
      const questions = thread.questions.map((q) => q.question);
      // A verdict shows only while the thread has stopped on its reply:
      // working again, waiting on something, failed or asking, it is that.
      const stop = threadStop(
        { running, failed: thread.failed, watching, asking: questions.length > 0 },
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
        verdict: verdict ? { kind: verdict.verdict, replyText: verdict.replyText } : null
      };
    }),
    workers
  };
}

/** What waits on the user, most urgent first, by the rule Home shows it by
 *  (attentionEntries), without the global agent's own questions: it is the
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
    if (entry.kind === "worker" && entry.featureId) {
      return [{
        kind: "worker", featureId: entry.featureId, workerName: entry.workerName ?? entry.featureId, label, waiting: entry.waiting,
        question: entry.text, threadId: entry.threadId, threadTitle: entry.threadTitle
      }];
    }
    return [];
  });
}
