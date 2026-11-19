import { beforeEach, expect, test } from "bun:test";
import { useWorkerPlansStore } from "@/store/worker-plans";
import { emptyPlan } from "@shared/api/plans";
import { mockFetch } from "../helpers/fetch.js";

beforeEach(() => useWorkerPlansStore.setState({ plans: new Map() }));

test("a later plan wins, whichever arrives first", () => {
  const older = { ...emptyPlan("wkr_1"), conclusion: "old", updatedAt: "2026-09-14T10:00:00.000Z" };
  const newer = { ...emptyPlan("wkr_1"), conclusion: "new", updatedAt: "2026-09-14T10:05:00.000Z" };
  useWorkerPlansStore.getState().upsert(newer);
  useWorkerPlansStore.getState().upsert(older);
  expect(useWorkerPlansStore.getState().plans.get("wkr_1")!.conclusion).toBe("new");
  useWorkerPlansStore.getState().upsert({ ...newer, conclusion: "newest", updatedAt: "2026-09-14T10:06:00.000Z" });
  expect(useWorkerPlansStore.getState().plans.get("wkr_1")!.conclusion).toBe("newest");
});

test("on a timestamp tie a push wins and a fetch does not", () => {
  const pushed = { ...emptyPlan("wkr_1"), conclusion: "pushed later", updatedAt: "2026-09-14T10:00:00.000Z" };
  const fetchedEarlier = { ...emptyPlan("wkr_1"), conclusion: "fetched, same millisecond, older", updatedAt: "2026-09-14T10:00:00.000Z" };
  useWorkerPlansStore.getState().upsert(pushed);
  useWorkerPlansStore.getState().upsert(fetchedEarlier, "fetch");
  expect(useWorkerPlansStore.getState().plans.get("wkr_1")!.conclusion).toBe("pushed later");
  // Two pushes in one millisecond arrive in order: the second wins.
  useWorkerPlansStore.getState().upsert({ ...pushed, conclusion: "second push" });
  expect(useWorkerPlansStore.getState().plans.get("wkr_1")!.conclusion).toBe("second push");
});

test("the plan list a connection opens with fills the store, and never replaces a newer plan", async () => {
  const { attachSnapshotSseListeners } = await import("@/lib/snapshot-sse-listeners");
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  const newer = { ...emptyPlan("wkr_1"), conclusion: "pushed while reconnecting", updatedAt: "2026-09-14T10:05:00.000Z" };
  useWorkerPlansStore.getState().upsert(newer);
  const listed = [
    { ...emptyPlan("wkr_1"), conclusion: "listed, older", updatedAt: "2026-09-14T10:00:00.000Z" },
    { ...emptyPlan("wkr_2"), conclusion: "x", updatedAt: "2026-09-14T10:00:00.000Z" }
  ];
  source.dispatchEvent(new MessageEvent("workerPlans", { data: JSON.stringify({ plans: listed }) }));
  expect(useWorkerPlansStore.getState().plans.get("wkr_1")!.conclusion).toBe("pushed while reconnecting");
  expect(useWorkerPlansStore.getState().plans.get("wkr_2")!.conclusion).toBe("x");
});

test("a failed single-plan fetch rejects with the server's message and changes nothing", async () => {
  useWorkerPlansStore.getState().upsert({ ...emptyPlan("wkr_2"), conclusion: "x", updatedAt: "2026-09-14T10:00:00.000Z" });
  mockFetch(() => new Response(JSON.stringify({ error: "nope" }), { status: 404 }));
  // The plan card tells "no plan" from "couldn't read it" by this rejection.
  await expect(useWorkerPlansStore.getState().fetchOne("wkr_2")).rejects.toThrow("nope");
  expect(useWorkerPlansStore.getState().plans.get("wkr_2")!.conclusion).toBe("x");
});

test("a plan pushed over SSE lands in the store", async () => {
  const { attachSnapshotSseListeners } = await import("@/lib/snapshot-sse-listeners");
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  const plan = { ...emptyPlan("wkr_3"), conclusion: "pushed", updatedAt: "2026-09-14T10:00:00.000Z" };
  source.dispatchEvent(new MessageEvent("workerPlanUpdated", { data: JSON.stringify({ plan }) }));
  expect(useWorkerPlansStore.getState().plans.get("wkr_3")!.conclusion).toBe("pushed");
});
