import type { AgentMessageContent } from "./agent-message-types.js";
import type { FeaturePlanDto } from "./api/plans.js";
import { ASKING_LABEL, FEATURE_STATE_LABEL, featureStateFor, isAsking, WAITING_LABEL } from "./feature-state.js";

/** The state a worker's wake ended in. The wake's own
 *  outcome wins over everything the plan says: a failed or cut-off wake is
 *  what happened, whatever the plan claims. */
type WorkerStateKey =
  | "failed" | "stopped" | "input" | "blocked"
  | "planning" | "in_progress" | "paused" | "done";

/** What a report can say. `done`: it finished its plan. `silent`: its turn
 *  ended with steps left, nothing set to wake it and nothing said — an
 *  event, never a state a turn ends in, so not reportable by state. */
export type WorkerReportKey = "failed" | "stopped" | "input" | "done" | "blocked" | "silent";

export const REPORTABLE_KEYS: readonly WorkerReportKey[] = ["failed", "stopped", "input", "done", "blocked"];

export const WORKER_REPORT_LABEL: Record<WorkerReportKey, string> = {
  failed: WAITING_LABEL.failed,
  stopped: WAITING_LABEL.stopped,
  // A worker's question is its manager's first: not "Needs you".
  input: ASKING_LABEL,
  done: FEATURE_STATE_LABEL.done,
  blocked: "Blocked",
  silent: "Went quiet"
};

/** What a silent stop's report says. */
export const SILENT_STOP_LINE = "Its turn ended with steps left and nothing set to wake it, and it told you nothing.";

export interface WorkerReport {
  featureId: string;
  featureName: string;
  projectId: string;
  projectName: string;
  key: WorkerReportKey;
  line: string;
}

const METADATA_KEY = "workerReport";
const KEYS = new Set<string>([...REPORTABLE_KEYS, "silent"]);

export function workerReportMetadata(report: WorkerReport): Record<string, unknown> {
  return { [METADATA_KEY]: { ...report } };
}

export function workerReportOf(content: AgentMessageContent): WorkerReport | null {
  if (content.type !== "text") return null;
  const raw = content.metadata?.[METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
  const key = str("key");
  const featureId = str("featureId");
  if (!key || !KEYS.has(key) || !featureId) return null;
  return {
    featureId,
    featureName: str("featureName") ?? featureId,
    projectId: str("projectId") ?? "",
    projectName: str("projectName") ?? "",
    key: key as WorkerReportKey,
    line: str("line") ?? ""
  };
}

export function formatWorkerReportText(report: WorkerReport): string {
  return `[Worker report] ${report.featureName} (${report.featureId}, project ${report.projectName}): ${report.key} — ${report.line}`;
}

export function workerStateKey(
  status: "finished" | "stuck" | "error" | "cut_off",
  plan: FeaturePlanDto | null
): WorkerStateKey {
  if (status === "error") return "failed";
  if (status === "stuck" || status === "cut_off") return "stopped";
  // What the worker asks is in its plan, and no flag: a question there is
  // what its manager has to hear, whatever else the plan says.
  if (isAsking(plan)) return "input";
  const state = featureStateFor(plan);
  return state === "failed" || state === "stopped" || state === "asking" ? "planning" : state;
}

export function workerReportLine(
  key: WorkerReportKey,
  plan: FeaturePlanDto | null,
  failedMessage: string | null
): string {
  const steps = plan?.steps ?? [];
  switch (key) {
    case "input":
      return plan?.openQuestions[0]?.trim() || "Waiting for your input.";
    case "done":
      return plan?.conclusion?.trim() || "Finished its plan.";
    case "blocked": {
      const s = steps.find((x) => x.status === "blocked");
      if (!s) return "Blocked.";
      const note = s.note?.trim();
      return note ? `#${s.id} ${s.title} — ${note}` : `#${s.id} ${s.title}`;
    }
    case "failed":
      return failedMessage?.trim() || "The wake ended in an error.";
    case "silent":
      return SILENT_STOP_LINE;
    case "stopped": {
      // The repeated call or the output limit says why.
      if (failedMessage?.trim()) return failedMessage.trim();
      const s = steps.find((x) => x.status === "in_progress");
      return s ? `Stopped on #${s.id} ${s.title}.` : "Stopped.";
    }
  }
}
