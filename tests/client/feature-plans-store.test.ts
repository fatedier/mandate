import { beforeEach, expect, test } from "bun:test";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { emptyPlan } from "@shared/api/plans";
import { mockFetch } from "../helpers/fetch.js";

beforeEach(() => useFeaturePlansStore.setState({ plans: new Map() }));

test("a later plan wins, whichever arrives first", () => {
  const older = { ...emptyPlan("feat_1"), conclusion: "old", updatedAt: "2026-09-14T10:00:00.000Z" };
  const newer = { ...emptyPlan("feat_1"), conclusion: "new", updatedAt: "2026-09-14T10:05:00.000Z" };
  useFeaturePlansStore.getState().upsert(newer);
  useFeaturePlansStore.getState().upsert(older);
  expect(useFeaturePlansStore.getState().plans.get("feat_1")!.conclusion).toBe("new");
  useFeaturePlansStore.getState().upsert({ ...newer, conclusion: "newest", updatedAt: "2026-09-14T10:06:00.000Z" });
  expect(useFeaturePlansStore.getState().plans.get("feat_1")!.conclusion).toBe("newest");
});

test("on a timestamp tie a push wins and a fetch does not", () => {
  const pushed = { ...emptyPlan("feat_1"), conclusion: "pushed later", updatedAt: "2026-09-14T10:00:00.000Z" };
  const fetchedEarlier = { ...emptyPlan("feat_1"), conclusion: "fetched, same millisecond, older", updatedAt: "2026-09-14T10:00:00.000Z" };
  useFeaturePlansStore.getState().upsert(pushed);
  useFeaturePlansStore.getState().upsert(fetchedEarlier, "fetch");
  expect(useFeaturePlansStore.getState().plans.get("feat_1")!.conclusion).toBe("pushed later");
  // Two pushes in one millisecond arrive in order: the second wins.
  useFeaturePlansStore.getState().upsert({ ...pushed, conclusion: "second push" });
  expect(useFeaturePlansStore.getState().plans.get("feat_1")!.conclusion).toBe("second push");
});

test("the plan list a connection opens with fills the store, and never replaces a newer plan", async () => {
  const { attachSnapshotSseListeners } = await import("@/lib/snapshot-sse-listeners");
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  const newer = { ...emptyPlan("feat_1"), conclusion: "pushed while reconnecting", updatedAt: "2026-09-14T10:05:00.000Z" };
  useFeaturePlansStore.getState().upsert(newer);
  const listed = [
    { ...emptyPlan("feat_1"), conclusion: "listed, older", updatedAt: "2026-09-14T10:00:00.000Z" },
    { ...emptyPlan("feat_2"), conclusion: "x", updatedAt: "2026-09-14T10:00:00.000Z" }
  ];
  source.dispatchEvent(new MessageEvent("featurePlans", { data: JSON.stringify({ plans: listed }) }));
  expect(useFeaturePlansStore.getState().plans.get("feat_1")!.conclusion).toBe("pushed while reconnecting");
  expect(useFeaturePlansStore.getState().plans.get("feat_2")!.conclusion).toBe("x");
});

test("a failed single-plan fetch rejects with the server's message and changes nothing", async () => {
  useFeaturePlansStore.getState().upsert({ ...emptyPlan("feat_2"), conclusion: "x", updatedAt: "2026-09-14T10:00:00.000Z" });
  mockFetch(() => new Response(JSON.stringify({ error: "nope" }), { status: 404 }));
  // The plan card tells "no plan" from "couldn't read it" by this rejection.
  await expect(useFeaturePlansStore.getState().fetchOne("feat_2")).rejects.toThrow("nope");
  expect(useFeaturePlansStore.getState().plans.get("feat_2")!.conclusion).toBe("x");
});

test("a plan pushed over SSE lands in the store", async () => {
  const { attachSnapshotSseListeners } = await import("@/lib/snapshot-sse-listeners");
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  const plan = { ...emptyPlan("feat_3"), conclusion: "pushed", updatedAt: "2026-09-14T10:00:00.000Z" };
  source.dispatchEvent(new MessageEvent("featurePlanUpdated", { data: JSON.stringify({ plan }) }));
  expect(useFeaturePlansStore.getState().plans.get("feat_3")!.conclusion).toBe("pushed");
});
