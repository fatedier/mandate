import { create } from "zustand";
import type { WorkerPlanDto, WorkerPlanResponse, WorkerRecordDto, WorkerRecordResponse } from "@shared/api/plans";
import { api } from "@/lib/api-paths";

/** Where a plan came from: pushes arrive in order, a fetch may be older. */
type PlanSource = "push" | "fetch";

interface WorkerPlansState {
  plans: Map<string, WorkerPlanDto>;
  upsert(plan: WorkerPlanDto, source?: PlanSource): void;
  /** Rejects when the plan could not be read, with the server's message. */
  fetchOne(workerId: string): Promise<void>;
}

/** A fetch that started before an SSE update can land after it; the plan
 *  with the later updatedAt wins. Two writes in one millisecond share a
 *  stamp: a push (they arrive in order) still wins such a tie, a fetch does not. */
function isNewer(current: WorkerPlanDto | undefined, next: WorkerPlanDto, source: PlanSource): boolean {
  if (!current) return true;
  const a = next.updatedAt ?? "";
  const b = current.updatedAt ?? "";
  return source === "push" ? a >= b : a > b;
}

export const useWorkerPlansStore = create<WorkerPlansState>((set, get) => ({
  plans: new Map(),
  upsert(plan, source = "push") {
    if (!isNewer(get().plans.get(plan.workerId), plan, source)) return;
    const plans = new Map(get().plans);
    plans.set(plan.workerId, plan);
    set({ plans });
  },
  async fetchOne(workerId) {
    const res = await fetch(api.workerPlan(workerId));
    const body = (await res.json()) as WorkerPlanResponse;
    if (!res.ok || !("plan" in body)) throw new Error("error" in body ? body.error : res.statusText);
    get().upsert(body.plan, "fetch");
  }
}));

/** The whole plan, earlier work included: read when earlier work is opened,
 *  and kept by whoever asked, not in the store, which holds the page's. */
export async function fetchWholePlan(workerId: string): Promise<WorkerPlanDto> {
  const res = await fetch(api.workerPlanWhole(workerId));
  const body = (await res.json()) as WorkerPlanResponse;
  if (!res.ok || !("plan" in body)) throw new Error("error" in body ? body.error : res.statusText);
  return body.plan;
}

/** A worker's task record; null when it has none, or when the worker is
 *  gone (404). Rejects on any other failure, with the server's message. */
export async function fetchWorkerRecord(workerId: string): Promise<WorkerRecordDto | null> {
  const res = await fetch(api.workerRecord(workerId));
  if (res.status === 404) return null;
  const body = (await res.json()) as WorkerRecordResponse;
  if (!res.ok || !("record" in body)) throw new Error("error" in body ? body.error : res.statusText);
  return body.record;
}

export function useWorkerPlan(workerId: string | null | undefined): WorkerPlanDto | null {
  return useWorkerPlansStore((s) => (workerId ? s.plans.get(workerId) ?? null : null));
}
