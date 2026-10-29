import { expect, test, beforeEach } from "bun:test";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";
import { mockFetch } from "./helpers/fetch.js";

function makeItem(over: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1", title: "T",
    featureId: "feat-1", projectId: "proj-1",
    lastActivityAt: "2026-05-15T00:00:00Z",
    createdAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    failedAt: null,
    failedMessage: null, failedKind: null,
    ...over
  };
}

beforeEach(() => {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map()
  }, true);
});

const requestCases = [
  {
    name: "list",
    start: () => useWorkItemsStore.getState().fetchList(),
    body: (item: WorkItemDto) => ({ items: [item], nextCursor: "older-page" })
  },
  {
    name: "feature",
    start: () => useWorkItemsStore.getState().fetchByFeature("feat-1"),
    body: (item: WorkItemDto) => ({ items: [item], nextCursor: null })
  },
  {
    name: "acknowledge",
    start: () => useWorkItemsStore.getState().acknowledge("wi-1"),
    body: (item: WorkItemDto) => ({ item })
  }
];

function deferResponses() {
  const pending: Array<(body: unknown) => void> = [];
  mockFetch(() => new Promise<Response>((resolve) => {
    pending.push((body) => resolve(Response.json(body)));
  }));
  return pending;
}

const earlier = "2026-09-15T00:00:00.000Z";
const later = "2026-09-15T00:00:00.001Z";

for (const request of requestCases) {
  for (const stamp of [earlier, later]) {
    test(`${request.name} preserves an intervening SSE update stamped ${stamp}`, async () => {
      const responses = deferResponses();
      const old = makeItem({ title: "Old summary", updatedAt: earlier });
      useWorkItemsStore.getState().upsert(old);
      const inFlight = request.start();
      const live = makeItem({
        title: "Finished task",
        updatedAt: stamp
      });
      useWorkItemsStore.getState().upsert(live);
      const held = useWorkItemsStore.getState().items;

      responses[0]!(request.body(old));
      await inFlight;

      expect(useWorkItemsStore.getState().items).toBe(held);
      expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(live);
    });
  }

  test(`${request.name} accepts a same-millisecond result when only another item changed`, async () => {
    const responses = deferResponses();
    useWorkItemsStore.getState().upsert(makeItem({ updatedAt: earlier }));
    const inFlight = request.start();
    const neighbour = makeItem({ id: "wi-2", featureId: "feat-2", updatedAt: later });
    useWorkItemsStore.getState().upsert(neighbour);
    const result = makeItem({ title: "Acknowledged", updatedAt: earlier });

    responses[0]!(request.body(result));
    await inFlight;

    expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(result);
    expect(useWorkItemsStore.getState().items.get("wi-2")).toEqual(neighbour);
  });

  test(`${request.name} accepts a response newer than an intervening SSE update`, async () => {
    const responses = deferResponses();
    const inFlight = request.start();
    useWorkItemsStore.getState().upsert(makeItem({ updatedAt: earlier }));
    const result = makeItem({ title: "Latest result", updatedAt: later });

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
      title: "Completed before reconnect", updatedAt: earlier
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
      const result = makeItem({ title: "Latest result", updatedAt: stamp });
      responses[1]!(request.body(result));
      await second;
      const held = useWorkItemsStore.getState().items;
      responses[0]!(request.body(makeItem({ title: "Old result", updatedAt: earlier })));
      await first;

      expect(useWorkItemsStore.getState().items).toBe(held);
      expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(result);
    });
  }
}

test("a delayed older SSE event cannot replace a newer HTTP result", async () => {
  const responses = deferResponses();
  const inFlight = useWorkItemsStore.getState().acknowledge("wi-1");
  const result = makeItem({ title: "Latest result", updatedAt: later });
  responses[0]!({ item: result });
  await inFlight;
  const held = useWorkItemsStore.getState().items;

  useWorkItemsStore.getState().upsert(makeItem({ title: "Old event", updatedAt: earlier }));

  expect(useWorkItemsStore.getState().items).toBe(held);
  expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(result);
});

test("successive SSE updates in the same millisecond still apply", () => {
  useWorkItemsStore.getState().upsert(makeItem({ updatedAt: earlier }));
  const result = makeItem({ title: "Finished", updatedAt: earlier });

  useWorkItemsStore.getState().upsert(result);

  expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(result);
});

test("an invalid timestamp cannot displace a valid one, and a valid result repairs an invalid timestamp", async () => {
  const responses = deferResponses();
  useWorkItemsStore.getState().upsert(makeItem({ updatedAt: "invalid" }));
  const repaired = makeItem({ title: "Valid result", updatedAt: later });
  const repair = useWorkItemsStore.getState().acknowledge("wi-1");
  responses[0]!({ item: repaired });
  await repair;
  const held = useWorkItemsStore.getState().items;
  const malformed = useWorkItemsStore.getState().acknowledge("wi-1");
  responses[1]!({ item: makeItem({ title: "Invalid result", updatedAt: "invalid" }) });
  await malformed;

  expect(useWorkItemsStore.getState().items).toBe(held);
  expect(useWorkItemsStore.getState().items.get("wi-1")).toEqual(repaired);
});

test("list merging adds new items while retaining newer and unrelated items", async () => {
  const responses = deferResponses();
  const live = makeItem({ title: "Latest result", updatedAt: later });
  const unrelated = makeItem({ id: "wi-2", featureId: "feat-2" });
  useWorkItemsStore.getState().upsert(live);
  useWorkItemsStore.getState().upsert(unrelated);
  const inFlight = useWorkItemsStore.getState().fetchList();
  const added = makeItem({ id: "wi-3", featureId: "feat-3" });

  responses[0]!({ items: [makeItem({ updatedAt: earlier }), added], nextCursor: null });
  await inFlight;

  expect([...useWorkItemsStore.getState().items.values()]).toEqual([live, unrelated, added]);
});

test("acknowledging posts to the worker's acknowledge route, with nothing in the body", async () => {
  const calls = mockFetch(() => Response.json({ item: makeItem({ updatedAt: later }) }));
  await useWorkItemsStore.getState().acknowledge("wi-1");
  expect(calls.map((c) => [c.method, c.url, c.init?.body ?? null])).toStrictEqual([["POST", "/api/work-items/wi-1/acknowledge", null]]);
});
