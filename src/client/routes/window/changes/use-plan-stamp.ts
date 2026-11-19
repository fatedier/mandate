import { useWorkerPlansStore } from "@/store/worker-plans";

/** When a worker's files have likely changed: the worker moved its plan on
 *  (a question it asks, and a finished plan, are part of the plan). The
 *  Changes tab and the Changes summary line both refresh on it, so they
 *  refresh together. */
export function usePlanStamp(workerId: string): string {
  return useWorkerPlansStore((s) => s.plans.get(workerId)?.updatedAt ?? "");
}
