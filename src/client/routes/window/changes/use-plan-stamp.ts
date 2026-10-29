import { useFeaturePlansStore } from "@/store/feature-plans";

/** When a feature's files have likely changed: the worker moved its plan on
 *  (a question it asks, and a finished plan, are part of the plan). The
 *  Changes tab and the Changes summary line both refresh on it, so they
 *  refresh together. */
export function usePlanStamp(featureId: string): string {
  return useFeaturePlansStore((s) => s.plans.get(featureId)?.updatedAt ?? "");
}
