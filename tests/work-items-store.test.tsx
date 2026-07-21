import { expect, test, beforeEach, afterEach } from "bun:test";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";

function makeItem(over: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1", title: "T", summary: null, canvasId: null, needsUser: null as null | "review" | "input",
    phase: "working" as const,
    phaseDetail: null, featureId: "feat-1", projectId: "proj-1",
    lastActivityAt: "2026-05-15T00:00:00Z",
    summaryUpdatedAt: null,
    summaryUpdatedBy: null,
    createdAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    ...over
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map(),
    paginationByStatus: new Map()
  }, true);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("upsert stores the item", () => {
  useWorkItemsStore.getState().upsert(makeItem({ id: "wi-1", title: "A" }));
  const item = useWorkItemsStore.getState().items.get("wi-1");
  expect(item?.title).toBe("A");
});

test("patchNeedsUser applies the returned item", async () => {
  useWorkItemsStore.getState().upsert(makeItem({ id: "wi-ack", needsUser: "review" }));
  globalThis.fetch = (async () => new Response(JSON.stringify({
    item: makeItem({ id: "wi-ack", needsUser: null, title: "Acked" })
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  await useWorkItemsStore.getState().patchNeedsUser("wi-ack", null);

  const state = useWorkItemsStore.getState();
  expect(state.items.get("wi-ack")?.title).toBe("Acked");
  expect(state.items.get("wi-ack")?.needsUser).toBeNull();
});

const requestCases = [
  {
    name: "list",
    start: () => useWorkItemsStore.getState().fetchList(),
    body: (item: WorkItemDto) => ({ items: [item], nextCursor: "older-page" })
  },
  {
    name: "detail",
    start: () => useWorkItemsStore.getState().fetchDetail("wi-1"),
    body: (item: WorkItemDto) => ({ item })
  },
  {
    name: "feature",
    start: () => useWorkItemsStore.getState().fetchByFeature("feat-1"),
    body: (item: WorkItemDto) => ({ items: [item], nextCursor: null })
  },
  {
    name: "patch",
    start: () => useWorkItemsStore.getState().patchNeedsUser("wi-1", null),
    body: (item: WorkItemDto) => ({ item })
  }
];

function deferResponses() {
  const pending: Array<(body: unknown) => void> = [];
  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    pending.push((body) => resolve(Response.json(body)));
  })) as typeof fetch;
  return pending;
}

const earlier = "2026-09-15T00:00:00.000Z";
const later = "2026-09-15T00:00:00.001Z";

for (const request of requestCases) {
  for (const stamp of [earlier, later]) {
    test(`${request.name} preserves an intervening SSE update stamped ${stamp}`, async () => {
      const responses = deferResponses();
      const old = makeItem({ summary: "Old summary", updatedAt: earlier });
      useWorkItemsStore.getState().upsert(old);
      const inFlight = request.start();
      const live = makeItem({
        title: "Finished task", summary: "Final summary", phase: "done",
        needsUser: "review", canvasId: "canvas-new", summaryUpdatedBy: "worker",
        summaryUpdatedAt: stamp, updatedAt: stamp
      });
      useWorkItemsStore.getState().upsert(live);
      const held = useWorkItemsStore.getState().items;

      responses[0]!(request.body(old));
      await inFlight;

      expect(useWorkItemsStore.getState().items).toBe(held);
      expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(live);
      if (request.name === "list") {
        expect(useWorkItemsStore.getState().paginationByStatus.get("review")).toEqual({
          nextCursor: "older-page", hasMore: true
        });
      }
    });
  }

  test(`${request.name} accepts a same-millisecond result when only another item changed`, async () => {
    const responses = deferResponses();
    useWorkItemsStore.getState().upsert(makeItem({ needsUser: "review", updatedAt: earlier }));
    const inFlight = request.start();
    const neighbour = makeItem({ id: "wi-2", featureId: "feat-2", updatedAt: later });
    useWorkItemsStore.getState().upsert(neighbour);
    const result = makeItem({ summary: "Acknowledged", needsUser: null, updatedAt: earlier });

    responses[0]!(request.body(result));
    await inFlight;

    expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(result);
    expect(useWorkItemsStore.getState().items.get("wi-2")).toEqual(neighbour);
  });

  test(`${request.name} accepts a response newer than an intervening SSE update`, async () => {
    const responses = deferResponses();
    const inFlight = request.start();
    useWorkItemsStore.getState().upsert(makeItem({ updatedAt: earlier }));
    const result = makeItem({ summary: "Latest result", updatedAt: later });

    responses[0]!(request.body(result));
    await inFlight;

    expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(result);
  });

  test(`${request.name} replaces an earlier overlapping HTTP result with the same timestamp`, async () => {
    const responses = deferResponses();
    const fallback = useWorkItemsStore.getState().fetchByFeature("feat-1");
    const refresh = request.start();
    responses[0]!({ items: [makeItem({ updatedAt: earlier })], nextCursor: null });
    await fallback;
    const result = makeItem({
      summary: "Completed before reconnect", phase: "done", needsUser: "review", updatedAt: earlier
    });
    responses[1]!(request.body(result));
    await refresh;

    expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(result);
  });

  for (const stamp of [earlier, later]) {
    test(`${request.name} preserves a newer HTTP result stamped ${stamp} when responses arrive in reverse`, async () => {
      const responses = deferResponses();
      const first = request.start();
      const second = request.start();
      const result = makeItem({ summary: "Latest result", updatedAt: stamp });
      responses[1]!(request.body(result));
      await second;
      const held = useWorkItemsStore.getState().items;
      responses[0]!(request.body(makeItem({ summary: "Old result", updatedAt: earlier })));
      await first;

      expect(useWorkItemsStore.getState().items).toBe(held);
      expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(result);
    });
  }
}

test("a delayed older SSE event cannot replace a newer HTTP result", async () => {
  const responses = deferResponses();
  const inFlight = useWorkItemsStore.getState().fetchDetail("wi-1");
  const result = makeItem({ summary: "Latest result", updatedAt: later });
  responses[0]!({ item: result });
  await inFlight;
  const held = useWorkItemsStore.getState().items;

  useWorkItemsStore.getState().upsert(makeItem({ summary: "Old event", updatedAt: earlier }));

  expect(useWorkItemsStore.getState().items).toBe(held);
  expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(result);
});

test("successive SSE updates in the same millisecond still apply", () => {
  useWorkItemsStore.getState().upsert(makeItem({ updatedAt: earlier }));
  const result = makeItem({ summary: "Finished", phase: "done", needsUser: "review", updatedAt: earlier });

  useWorkItemsStore.getState().upsert(result);

  expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(result);
});

test("an invalid timestamp cannot displace a valid one, and a valid result repairs an invalid timestamp", async () => {
  const responses = deferResponses();
  useWorkItemsStore.getState().upsert(makeItem({ updatedAt: "invalid" }));
  const repaired = makeItem({ summary: "Valid result", updatedAt: later });
  const repair = useWorkItemsStore.getState().fetchDetail("wi-1");
  responses[0]!({ item: repaired });
  await repair;
  const held = useWorkItemsStore.getState().items;
  const malformed = useWorkItemsStore.getState().fetchDetail("wi-1");
  responses[1]!({ item: makeItem({ summary: "Invalid result", updatedAt: "invalid" }) });
  await malformed;

  expect(useWorkItemsStore.getState().items).toBe(held);
  expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(repaired);
});

test("list merging adds new items while retaining newer and unrelated items", async () => {
  const responses = deferResponses();
  const live = makeItem({ summary: "Latest result", updatedAt: later });
  const unrelated = makeItem({ id: "wi-2", featureId: "feat-2" });
  useWorkItemsStore.getState().upsert(live);
  useWorkItemsStore.getState().upsert(unrelated);
  const inFlight = useWorkItemsStore.getState().fetchList();
  const added = makeItem({ id: "wi-3", featureId: "feat-3" });

  responses[0]!({ items: [makeItem({ updatedAt: earlier }), added], nextCursor: null });
  await inFlight;

  expect([...useWorkItemsStore.getState().items.values()]).toEqual([live, unrelated, added]);
  expect(useWorkItemsStore.getState().paginationByStatus.get("review")).toEqual({
    nextCursor: null, hasMore: false
  });
});
