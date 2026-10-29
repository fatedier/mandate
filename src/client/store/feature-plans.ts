import { create } from "zustand";
import type { FeaturePlanDto, FeaturePlanResponse, FeatureRecordDto, FeatureRecordResponse } from "@shared/api/plans";
import { api } from "@/lib/api-paths";

/** Where a plan came from: pushes arrive in order, a fetch may be older. */
type PlanSource = "push" | "fetch";

interface FeaturePlansState {
  plans: Map<string, FeaturePlanDto>;
  upsert(plan: FeaturePlanDto, source?: PlanSource): void;
  /** Rejects when the plan could not be read, with the server's message. */
  fetchOne(featureId: string): Promise<void>;
}

/** A fetch that started before an SSE update can land after it; the plan
 *  with the later updatedAt wins. Two writes in one millisecond share a
 *  stamp: a push (they arrive in order) still wins such a tie, a fetch does not. */
function isNewer(current: FeaturePlanDto | undefined, next: FeaturePlanDto, source: PlanSource): boolean {
  if (!current) return true;
  const a = next.updatedAt ?? "";
  const b = current.updatedAt ?? "";
  return source === "push" ? a >= b : a > b;
}

export const useFeaturePlansStore = create<FeaturePlansState>((set, get) => ({
  plans: new Map(),
  upsert(plan, source = "push") {
    if (!isNewer(get().plans.get(plan.featureId), plan, source)) return;
    const plans = new Map(get().plans);
    plans.set(plan.featureId, plan);
    set({ plans });
  },
  async fetchOne(featureId) {
    const res = await fetch(api.featurePlan(featureId));
    const body = (await res.json()) as FeaturePlanResponse;
    if (!res.ok || !("plan" in body)) throw new Error("error" in body ? body.error : res.statusText);
    get().upsert(body.plan, "fetch");
  }
}));

/** The whole plan, earlier work included: read when earlier work is opened,
 *  and kept by whoever asked, not in the store, which holds the page's. */
export async function fetchWholePlan(featureId: string): Promise<FeaturePlanDto> {
  const res = await fetch(api.featurePlanWhole(featureId));
  const body = (await res.json()) as FeaturePlanResponse;
  if (!res.ok || !("plan" in body)) throw new Error("error" in body ? body.error : res.statusText);
  return body.plan;
}

/** A worker's task record; null when it has none, or when the worker is
 *  gone (404). Rejects on any other failure, with the server's message. */
export async function fetchFeatureRecord(featureId: string): Promise<FeatureRecordDto | null> {
  const res = await fetch(api.featureRecord(featureId));
  if (res.status === 404) return null;
  const body = (await res.json()) as FeatureRecordResponse;
  if (!res.ok || !("record" in body)) throw new Error("error" in body ? body.error : res.statusText);
  return body.record;
}

export function useFeaturePlan(featureId: string | null | undefined): FeaturePlanDto | null {
  return useFeaturePlansStore((s) => (featureId ? s.plans.get(featureId) ?? null : null));
}
