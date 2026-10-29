import type { ManagerThreadDto, WorkerFindingsDto, WorkerRefDto } from "../../../shared/api-contracts.js";
import type { LifecyclePublisher } from "../../runtime/events.js";
import type { ArchiveFeatureCleanupFailure } from "../features/feature-service.js";
import type { FeaturesStore } from "../features/features-store.js";
import { errorText } from "../../../shared/error-text.js";
import type { AgentStore } from "./agent-store.js";

type WorkerRef = WorkerRefDto;
type WorkerFindings = WorkerFindingsDto;

export type ThreadArchiveResult =
  | { ok: true; thread: ManagerThreadDto; workers: WorkerRef[]; cleanupFailures: ArchiveFeatureCleanupFailure[] }
  | { ok: false; status: 404; error: string }
  /** Refused over work that would be lost. `archived` are the workers that
   *  had already gone when a later one refused, with what their cleanup
   *  could not do; both empty when the checks refused, which changes nothing. */
  | { ok: false; status: 409; error: string; workers: WorkerFindings[]; archived: WorkerRef[]; cleanupFailures: ArchiveFeatureCleanupFailure[] };

export interface ThreadArchiveInput {
  threadId: string;
  /** The workers whose findings the user was shown, and said to archive
   *  anyway. The word is for those workers: every other one is checked, so
   *  one that appeared or picked up work since is shown before it goes. */
  confirmed?: readonly string[];
  /** Keep every worker's worktree, or branch. Without them each worker is
   *  left to what its own kind of workspace calls for: a cleanup can be held
   *  back here, never ordered (that would take a worktree a worker only
   *  borrowed). */
  keepWorktrees?: boolean;
  keepBranches?: boolean;
}

export interface ThreadArchiveDeps {
  agentStore: AgentStore;
  features: Pick<FeaturesStore, "listActiveOwnedBy">;
  /** One worker's check and archive (FeatureService). */
  workers: {
    archiveCheck(id: string): { findings: string[] } | null;
    archive(input: { id: string; confirmed?: boolean; cleanup?: { removeWorktree?: boolean; deleteBranch?: boolean } }): Promise<
      | { ok: true; feature: { projectId: string }; cleanupFailures?: ArchiveFeatureCleanupFailure[] }
      | { ok: false; error: string; check?: { findings: string[] } }
    >;
  };
  wakes: {
    getRunningWakeForThread(threadId: string): { id: string } | null;
    cancelWake(wakeId: string): unknown;
  };
  /** Frees what the thread holds: handoffs, its subagents (stopped without a
   *  result), queued messages, watches, alarms. */
  releaseThreadResources(threadId: string): void;
  /** Takes the thread's memory before it goes. */
  beforeThreadArchive(threadId: string): void;
  broadcast: LifecyclePublisher;
  publishThread(threadId: string): ManagerThreadDto | null;
}

/**
 * Archives a manager thread together with its workers: the one way a thread
 * is archived, from its dialog and by the global agent alike.
 *
 * A worker reports to its thread, so a thread cannot go while it has any;
 * they go first. Every worker is checked before anything is touched, and a
 * check that finds uncommitted or unmerged work refuses the whole archive
 * unless the user confirmed that worker. A turn still running, in a worker or in the
 * thread, is stopped, and a worker started while the others went goes too:
 * nothing is left at work, or left behind, under an archived thread.
 */
export class ThreadArchive {
  constructor(private readonly deps: ThreadArchiveDeps) {}

  async archive(input: ThreadArchiveInput): Promise<ThreadArchiveResult> {
    const { agentStore } = this.deps;
    const thread = agentStore.getThreadById(input.threadId);
    if (!thread || thread.scope !== "manager" || thread.archivedAt) {
      return { ok: false, status: 404, error: "thread not found" };
    }
    const workers = this.activeWorkers(thread.id);

    const confirmed = new Set(input.confirmed ?? []);
    const found = workers
      .filter((worker) => !confirmed.has(worker.id))
      .map((worker): WorkerFindings => ({ ...worker, findings: this.deps.workers.archiveCheck(worker.id)?.findings ?? [] }))
      .filter((worker) => worker.findings.length > 0);
    if (found.length > 0) return refusal(found, [], []);

    const cleanup = {
      removeWorktree: input.keepWorktrees ? false : undefined,
      deleteBranch: input.keepBranches ? false : undefined
    };
    const archived: WorkerRef[] = [];
    const cleanupFailures: ArchiveFeatureCleanupFailure[] = [];
    // Round after round, until the thread's own turn is stopped and it has no
    // worker left. Its turn first: left running, its manager could start
    // another worker while these go, and a worker's stop, reported to the
    // thread, can wake it again. Nothing after the last round waits, so
    // nothing can start between it and the thread's own archive.
    for (;;) {
      this.stopTurn(thread.id);
      const round = this.activeWorkers(thread.id);
      if (round.length === 0) break;
      for (const worker of round) {
        // Its archive said it went and it is still here: asking again would never end.
        if (archived.some((gone) => gone.id === worker.id)) {
          return refusal([{ ...worker, findings: ["It is still active after its archive."] }], archived, cleanupFailures);
        }
        const conversation = agentStore.getThreadByScope("worker", worker.id);
        if (conversation) this.stopTurn(conversation.id);
        // The worker's own archive checks again unless the user confirmed that
        // worker: it may have picked up work since the check above, or have
        // been started since. One that fails outright (git not answering)
        // stops the archive like a refusal: workers have gone by now, and the
        // answer has to say which.
        const result = await this.deps.workers.archive({ id: worker.id, confirmed: confirmed.has(worker.id), cleanup })
          .catch((error: unknown) => ({ ok: false as const, error: errorText(error), check: undefined }));
        if (!result.ok) return refusal([{ ...worker, findings: result.check?.findings ?? [result.error] }], archived, cleanupFailures);
        this.deps.broadcast({ type: "featureArchived", data: { id: worker.id, projectId: result.feature.projectId } });
        archived.push(worker);
        cleanupFailures.push(...(result.cleanupFailures ?? []));
      }
    }

    this.deps.releaseThreadResources(thread.id);
    this.deps.beforeThreadArchive(thread.id);
    agentStore.archiveThread(thread.id);
    return { ok: true, thread: this.deps.publishThread(thread.id)!, workers: archived, cleanupFailures };
  }

  private activeWorkers(threadId: string): WorkerRef[] {
    return this.deps.features.listActiveOwnedBy(threadId).map((row) => ({ id: row.id, name: row.name }));
  }

  private stopTurn(threadId: string): void {
    const running = this.deps.wakes.getRunningWakeForThread(threadId);
    if (running) this.deps.wakes.cancelWake(running.id);
  }
}

function refusal(workers: WorkerFindings[], archived: WorkerRef[], cleanupFailures: ArchiveFeatureCleanupFailure[]): ThreadArchiveResult {
  return {
    ok: false, status: 409,
    error: `Archiving would lose work in: ${workers.map((worker) => worker.name).join(", ")}.`,
    workers, archived, cleanupFailures
  };
}
