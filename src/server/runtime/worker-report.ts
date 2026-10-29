import type { AgentStore } from "../modules/agent/agent-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { WorkItem, WorkItemStore } from "../modules/agent/work-item-store.js";
import type { PlanStore } from "../modules/plans/plan-store.js";
import type { UpwardInbox, UpwardRoute } from "../modules/agent/upward-inbox.js";
import {
  REPORTABLE_KEYS,
  formatWorkerReportText,
  workerReportLine,
  workerReportMetadata,
  workerStateKey,
  type WorkerReport,
  type WorkerReportKey
} from "../../shared/worker-report.js";
import { isAsking } from "../../shared/feature-state.js";
import { OUTPUT_LIMIT_STOPPED } from "../modules/agent/output-limit.js";
import { cutKeepingWhole } from "../modules/agent/tool-output-spool.js";
import { latestAssistantTextForWake } from "./feature-message-relay.js";

/** How much of a worker's last reply its report carries. */
const LAST_REPLY_MAX_CHARS = 4000;

interface WorkerReportDeps {
  agentStore: Pick<AgentStore, "getThreadById" | "getThreadByScope" | "latestManagerThread" | "transaction" | "latestAssistantTextOfWake">;
  featuresStore: Pick<FeaturesStore, "getById" | "setOwner">;
  projectsStore: Pick<ProjectsStore, "getById">;
  workStore: Pick<WorkItemStore, "getByFeature" | "setFailure" | "getReportedState" | "setReportedState">;
  planStore: Pick<PlanStore, "get">;
  /** Where the report goes in, and whose wake it asks for. */
  inbox: Pick<UpwardInbox, "post">;
  /** Broadcast a work item whose failure changed. */
  onWorkItemChanged?: (item: WorkItem) => void;
  /** A worker whose owner was gone now belongs to the thread its report went to. */
  onOwnerChanged?: (featureId: string, threadId: string) => void;
  now?: () => string;
}

/** The owner thread when it is open; otherwise the latest thread, which
 *  becomes the owner (should not happen: a thread with an active worker
 *  cannot be archived). With no thread open at all, the one
 *  opened is named after the worker, as the create route names a thread it
 *  opens for an unowned worker. */
function reportTargetThreadId(
  deps: Pick<WorkerReportDeps, "agentStore" | "featuresStore" | "onOwnerChanged">,
  featureId: string
): string {
  const feature = deps.featuresStore.getById(featureId);
  const owner = feature?.ownerThreadId ?? null;
  const thread = owner ? deps.agentStore.getThreadById(owner) : null;
  if (thread && thread.scope === "manager" && !thread.archivedAt) return thread.id;
  const latest = deps.agentStore.latestManagerThread(feature?.name ?? null).id;
  deps.featuresStore.setOwner(featureId, latest);
  deps.onOwnerChanged?.(featureId, latest);
  return latest;
}

/** What each reported state is to its manager: a final
 *  answer is a report, a question a request, a failure or a stop a
 *  lifecycle event. */
function reportRoute(featureId: string, key: WorkerReportKey): UpwardRoute {
  const route = { key: `feature:${featureId}` };
  if (key === "input") return { ...route, kind: "request" };
  if (key === "failed" || key === "stopped") return { ...route, kind: "lifecycle", lifecycleReason: "failed" };
  if (key === "silent") return { ...route, kind: "lifecycle", lifecycleReason: "stopped_silent" };
  return { ...route, kind: "report" };
}

/** Queues one report for the worker's owner thread and wakes it. Queued and
 *  marked as the last reported state in one write: refused, neither is, so
 *  the next try (or the next wake ending in this state) reports it again,
 *  and it is never queued twice. The wake follows the write. */
function send(
  deps: WorkerReportDeps,
  feature: { id: string; name: string; projectId: string },
  workerThreadId: string | null,
  key: WorkerReportKey,
  line: string,
  /** What the worker last said, for the thread the report reaches. */
  lastReplyFor: (target: string) => string | null = () => null
): WorkerReport {
  const project = deps.projectsStore.getById(feature.projectId);
  const report: WorkerReport = {
    featureId: feature.id,
    featureName: feature.name,
    projectId: feature.projectId,
    projectName: project?.name ?? feature.projectId,
    key,
    line
  };
  const target = reportTargetThreadId(deps, feature.id);
  const lastReply = lastReplyFor(target);
  const { wake } = deps.agentStore.transaction(() => {
    const post = deps.inbox.post({
      to: target,
      ...reportRoute(feature.id, key),
      source: "worker-report",
      sourceThreadId: workerThreadId,
      content: {
        type: "text",
        text: lastReply
          ? `${formatWorkerReportText(report)}\n\nLast reply:\n${cutKeepingWhole(lastReply, LAST_REPLY_MAX_CHARS, { threadId: target })}`
          : formatWorkerReportText(report),
        metadata: workerReportMetadata(report)
      }
    });
    // A state is marked as reported; a silent stop is an event, and leaves
    // the state the turn ended in as it was.
    if ((REPORTABLE_KEYS as readonly string[]).includes(key)) deps.workStore.setReportedState(feature.id, key);
    return post;
  });
  wake();
  return report;
}

/**
 * Runs at the end of every worker main-thread wake:
 * records or clears a failure, computes the state key, and reports it to the
 * target thread when it is reportable and differs from the last key. The key
 * is always stored, so leaving a state and coming back reports again, while
 * repeating one never does — that bounds "nudge, stop at the limit, nudge".
 */
/** How a wake ended, for its report: a finished wake whose replies kept being
 *  cut off at the output token limit ended as `cut_off`. */
export type WakeEndStatus = "finished" | "stuck" | "error" | "canceled" | "cut_off";

/** The status the wake row gives, or `cut_off` for a finished wake that left
 *  a cut-off failure row (written before the wake's end, so it is there by the
 *  time the post-wake hook runs). */
export function wakeEndStatus(
  agentStore: Pick<AgentStore, "wakeFailureStatus">,
  wakeId: string,
  status: Exclude<WakeEndStatus, "cut_off">
): WakeEndStatus {
  return status === "finished" && agentStore.wakeFailureStatus(wakeId) === "cut_off" ? "cut_off" : status;
}

export function reportWorkerWakeEnd(
  deps: WorkerReportDeps,
  input: {
    threadId: string;
    status: WakeEndStatus;
    errorMessage: string | null;
    /** The turn that ended: its last reply goes with the report, unless that
     *  reply already went up, as the answer to a manager's message, to the
     *  thread the report reaches. */
    lastTurn?: { wakeId: string; relayedTo: (threadId: string) => boolean };
  }
): WorkerReport | null {
  if (input.status === "canceled") return null;
  const thread = deps.agentStore.getThreadById(input.threadId);
  if (thread?.scope !== "worker" || !thread.scopeId) return null;
  const feature = deps.featuresStore.getById(thread.scopeId);
  if (!feature || feature.archivedAt) return null;
  if (!deps.workStore.getByFeature(feature.id)) return null;

  const now = deps.now?.() ?? new Date().toISOString();
  const failure = input.status === "error"
    ? { at: now, message: (input.errorMessage ?? "").trim() || "The wake ended in an error.", kind: "error" as const }
    : input.status === "stuck"
      ? { at: now, message: (input.errorMessage ?? "").trim() || "Stopped.", kind: "stopped" as const }
      : input.status === "cut_off"
        ? { at: now, message: OUTPUT_LIMIT_STOPPED, kind: "stopped" as const }
        : null;
  const changed = deps.workStore.setFailure(feature.id, failure);
  if (changed) deps.onWorkItemChanged?.(changed);

  const item = deps.workStore.getByFeature(feature.id)!;
  const plan = deps.planStore.get(feature.id);
  const key = workerStateKey(input.status, plan.updatedAt ? plan : null);
  const previous = deps.workStore.getReportedState(feature.id);
  if (!(REPORTABLE_KEYS as readonly string[]).includes(key) || key === previous) {
    deps.workStore.setReportedState(feature.id, key);
    return null;
  }
  const lastTurn = input.lastTurn;
  const lastReplyFor = (target: string) => lastTurn && !lastTurn.relayedTo(target)
    ? latestAssistantTextForWake(deps.agentStore, thread.id, lastTurn.wakeId)
    : null;
  return send(deps, feature, thread.id, key as WorkerReportKey, workerReportLine(key as WorkerReportKey, plan.updatedAt ? plan : null, item.failedMessage), lastReplyFor);
}

/**
 * A worker wrote a question into its plan: its manager is told now, in the
 * middle of the worker's turn, since the worker may work on for minutes.
 * Always sent, whatever was last reported: the caller knows the question is
 * new. `questions` are the ones just written, so a second question beside an
 * earlier one is what the report says (not the first again); without them,
 * the plan's first. It leaves `input` as the last reported state, so the end
 * of this turn, with the question still open, does not say it again.
 */
export function reportWorkerQuestion(
  deps: Omit<WorkerReportDeps, "onWorkItemChanged" | "now">,
  input: { featureId: string; questions?: readonly string[] }
): WorkerReport | null {
  const feature = deps.featuresStore.getById(input.featureId);
  if (!feature || feature.archivedAt) return null;
  if (!deps.workStore.getByFeature(feature.id)) return null;
  const plan = deps.planStore.get(feature.id);
  if (!isAsking(plan)) return null;
  const thread = deps.agentStore.getThreadByScope("worker", feature.id);
  const [first, ...more] = (input.questions ?? []).map((question) => question.trim()).filter(Boolean);
  const line = first ? (more.length > 0 ? `${first} (+${more.length} more)` : first) : workerReportLine("input", plan, null);
  return send(deps, feature, thread?.id ?? null, "input", line);
}

/**
 * A worker's turn ended with steps left, nothing set to
 * wake it and nothing said to its manager. Its manager hears so now, with the
 * turn's last reply, rather than when a sweep looks; a lifecycle event, which
 * wakes it. The caller decides the turn was one.
 */
export function reportWorkerSilentStop(
  deps: Omit<WorkerReportDeps, "onWorkItemChanged" | "now">,
  input: { threadId: string; wakeId: string }
): WorkerReport | null {
  const thread = deps.agentStore.getThreadById(input.threadId);
  if (thread?.scope !== "worker" || !thread.scopeId) return null;
  const feature = deps.featuresStore.getById(thread.scopeId);
  if (!feature || feature.archivedAt) return null;
  if (!deps.workStore.getByFeature(feature.id)) return null;
  return send(deps, feature, thread.id, "silent", workerReportLine("silent", null, null), () => latestAssistantTextForWake(deps.agentStore, thread.id, input.wakeId));
}
