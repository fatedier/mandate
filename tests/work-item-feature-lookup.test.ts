import { expect, test, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore, type WorkItem } from "../src/server/modules/agent/work-item-store.js";
import { WorkItemChangeEmitter } from "../src/server/modules/agent/work-item-events.js";
import { registerWorkItemsRoutes } from "../src/server/modules/agent/work-items-routes.js";
import { broadcastWorkItemCreated } from "../src/server/modules/agent/work-item-created-broadcast.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { toWorkItemDto } from "../src/server/modules/agent/work-item-dto.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";
import { attachSnapshotSseListeners } from "../src/client/lib/snapshot-sse-listeners.js";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";
import { mockFetch } from "./helpers/fetch.js";
import { seedProject } from "./helpers/fixtures.js";

/** A real server — real schema, real stores, real routes, real SSE emitter —
 *  with the client's fetch pointed at it. Nothing here hand-writes a payload:
 *  what the client store receives is what the route actually serialises. */
function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const changes = new WorkItemChangeEmitter();
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db, changes);
  const workStore = new WorkItemStore(db, changes);
  const sse = new AgentSseEmitter({ workItemUpdateThrottleMs: 1 });

  const app = new Hono();
  registerWorkItemsRoutes(app, { workStore, sse });
  const unsubscribe = broadcastWorkItemCreated({ workStore, featuresStore: features, sse });

  // The client's own EventSource plumbing, fed by the server's own emitter.
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, {
    cancelled: () => false,
    setConnection: () => {},
    onReconnect: () => {}
  });
  sse.addSink((e) => {
    source.dispatchEvent(new MessageEvent(e.event, { data: JSON.stringify(e.data) }));
  });

  mockFetch(({ url, init }) => app.request(url, init));

  const projectId = seedProject(projects, { name: "p", workingDir: "/tmp/p", tmuxSessionName: "p" });
  const newFeature = (name: string) =>
    features.insert({
      projectId, name, mode: "shared-cwd", branch: null, baseRef: null,
      worktreePath: null, tmuxWindowName: name, ownership: "app"
    });

  return { db, workStore, projectId, newFeature, unsubscribe, sse };
}

function resetClientStore() {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map()
  }, true);
}

function itemsFor(featureId: string): WorkItemDto[] {
  return [...useWorkItemsStore.getState().items.values()].filter((i) => i.featureId === featureId);
}

beforeEach(resetClientStore);
afterEach(() => {
  resetClientStore();
});

// ── the fetch fallback ───────────────────────────────────────────────────

test("fetchByFeature loads the item the list never delivered", async () => {
  const { db, newFeature, workStore, unsubscribe } = setup();
  try {
    const featureId = newFeature("late");
    retitle(db, workStore, featureId, "Arrived after the list was taken.");
    resetClientStore();
    expect(itemsFor(featureId).length).toBe(0);

    await useWorkItemsStore.getState().fetchByFeature(featureId);

    const [item] = itemsFor(featureId);
    expect(item).toBeDefined();
    expect(item!.title).toBe("Arrived after the list was taken.");
  } finally {
    unsubscribe();
  }
});

test("an unknown feature leaves the store untouched rather than throwing", async () => {
  const { unsubscribe } = setup();
  try {
    await useWorkItemsStore.getState().fetchByFeature("feat-does-not-exist");
    expect(useWorkItemsStore.getState().items.size).toBe(0);
  } finally {
    unsubscribe();
  }
});

// ── the route itself ─────────────────────────────────────────────────────

test("GET /api/work-items?featureId for an unknown feature is an empty list, not a 404", async () => {
  const { unsubscribe } = setup();
  try {
    const res = await fetch("/api/work-items?featureId=nope");
    expect(res.status).toBe(200);
    expect((await res.json() as { items: unknown[] }).items).toEqual([]);
  } finally {
    unsubscribe();
  }
});

test("GET /api/work-items?featureId returns its one item and no cursor, not weakened by the list filters travelling with it", async () => {
  const { newFeature, unsubscribe } = setup();
  try {
    // attention=1 would exclude this idle item from the list route; a
    // lookup that lost its featureId would find a worker made before or after it.
    newFeature("before");
    const featureId = newFeature("filtered");
    newFeature("after");
    const res = await fetch(`/api/work-items?featureId=${featureId}&attention=1&limit=1`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: WorkItemDto[]; nextCursor: string | null };
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.featureId).toBe(featureId);
    expect(body.nextCursor).toBeNull();
  } finally {
    unsubscribe();
  }
});

// ── created / updated over SSE ───────────────────────────────────────────

test("a feature created now reaches the open client's store over SSE", () => {
  const { newFeature, unsubscribe } = setup();
  try {
    expect(useWorkItemsStore.getState().items.size).toBe(0);

    const featureId = newFeature("brand-new");

    const [item] = itemsFor(featureId);
    expect(item).toBeDefined();
    expect(item!.title).toBe("brand-new");
  } finally {
    unsubscribe();
  }
});

test("created then updated then re-fetched is still exactly one item", async () => {
  const { db, newFeature, workStore, unsubscribe, sse } = setup();
  try {
    const featureId = newFeature("dedupe");

    writeItem(db, workStore, sse, featureId, "Updated.");
    await useWorkItemsStore.getState().fetchByFeature(featureId);

    const held = itemsFor(featureId);
    expect(held.length).toBe(1);
    expect(held[0]!.title).toBe("Updated.");
  } finally {
    unsubscribe();
  }
});

// ── HTTP against SSE ─────────────────────────────────────────────────────

/** Hold a real response back. The route runs and serialises its body at call
 *  time — the state the server was in when the request was taken — but the
 *  caller is not handed it until `release()`. That is exactly the shape of the
 *  race: HTTP gives no ordering against the SSE stream. */
function deferResponses() {
  const routed = globalThis.fetch;
  let release!: () => void;
  const heldBack = new Promise<void>((resolve) => { release = resolve; });
  let served: string | null = null;
  mockFetch(async ({ url, init }) => {
    const res = await routed(url, init);
    const body = await res.text();
    served = body;
    await heldBack;
    return new Response(body, {
      status: res.status, headers: { "content-type": "application/json" }
    });
  });
  return {
    release,
    /** The body the server produced, once the route has answered. */
    taken: async () => {
      for (let i = 0; served === null && i < 500; i++) {
        await new Promise((r) => setTimeout(r, 1));
      }
      return served;
    }
  };
}

const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

/** Pin the stamp the server writes. `updated_at` is `new Date().toISOString()`
 *  — millisecond text — so two writes inside one millisecond carry the exact
 *  same string. Freezing the clock makes that collision certain instead of
 *  leaving it to the scheduler, while real time still passes for timers.
 *  Only the no-argument constructor is pinned; `Date.parse`, the other
 *  overloads and every timer keep working as they are. */
function freezeClock(iso: string): () => void {
  const RealDate = globalThis.Date;
  const fixed = RealDate.parse(iso);
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args) => Reflect.construct(target, args.length === 0 ? [fixed] : args)
  });
  return () => { globalThis.Date = RealDate; };
}

test("a GET in flight cannot roll the item back to what it held when it was taken", async () => {
  const { db, newFeature, workStore, unsubscribe, sse } = setup();
  try {
    const featureId = newFeature("racing");
    writeItem(db, workStore, sse, featureId, "First conclusion.");
    resetClientStore();

    // 1. The pane asks for the item. The route answers from the row as it
    //    stands, but the client does not see that answer yet.
    const deferred = deferResponses();
    const inFlight = useWorkItemsStore.getState().fetchByFeature(featureId);
    const takenBody = await deferred.taken();
    expect(takenBody).not.toBeNull();
    const taken = JSON.parse(takenBody!) as { items: WorkItemDto[] };
    expect(taken.items[0]!.title).toBe("First conclusion.");

    // 2. A newer write lands over SSE while that request is still outstanding.
    // A rollback here would bring back the first title.
    await tick();
    writeItem(db, workStore, sse, featureId, "Second conclusion.");
    const live = itemsFor(featureId)[0]!;
    expect(live.title).toBe("Second conclusion.");
    // The two really are different generations. Were the clock ever to stop
    // separating them, this test would prove nothing and must say so.
    expect(Date.parse(live.updatedAt)).toBeGreaterThan(Date.parse(taken.items[0]!.updatedAt));

    // 3. Only now does the older response resolve.
    deferred.release();
    await inFlight;

    const [after] = itemsFor(featureId);
    expect(itemsFor(featureId).length).toBe(1);
    expect(after!.title).toBe("Second conclusion.");
    expect(after!.updatedAt).toBe(live.updatedAt);
  } finally {
    unsubscribe();
  }
});

test("a GET stamped the same millisecond as the push that overtook it is dropped", async () => {
  const { db, newFeature, workStore, unsubscribe, sse } = setup();
  const unfreeze = freezeClock("2026-08-03T04:05:06.007Z");
  try {
    const featureId = newFeature("same-millisecond");
    writeItem(db, workStore, sse, featureId, "First conclusion.");
    resetClientStore();

    // 1. The pane asks for the item; the route answers from the row as it
    //    stands, and the client is not handed that answer yet.
    const deferred = deferResponses();
    const inFlight = useWorkItemsStore.getState().fetchByFeature(featureId);
    const takenBody = await deferred.taken();
    expect(takenBody).not.toBeNull();
    const taken = JSON.parse(takenBody!) as { items: WorkItemDto[] };
    expect(taken.items[0]!.title).toBe("First conclusion.");

    // 2. A newer write lands over SSE while that request is outstanding. Real
    //    time passes so the SSE throttle window drains, but the frozen clock
    //    hands this write the very same `updatedAt` as the one before it.
    await tick();
    writeItem(db, workStore, sse, featureId, "Second conclusion.");
    const live = itemsFor(featureId)[0]!;
    expect(live.title).toBe("Second conclusion.");
    // The precondition this test exists for: the two generations are
    // indistinguishable by `updatedAt`. Were the clock ever to separate them,
    // this would silently become a re-run of the strictly-newer case above and
    // prove nothing about ties, so it has to say so.
    expect(live.updatedAt).toBe(taken.items[0]!.updatedAt);

    // 3. Only now does the older response resolve. A tie must not unseat the
    //    push: it is the later generation of the same row.
    deferred.release();
    await inFlight;

    const [after] = itemsFor(featureId);
    expect(itemsFor(featureId).length).toBe(1);
    expect(after!.title).toBe("Second conclusion.");
  } finally {
    unfreeze();
    unsubscribe();
  }
});

/** What a server-side writer does to an item: change the row, then push it.
 *  The title stands in for whatever changed: no production writer renames an
 *  item now, but the client keeps the later copy whatever the field. */
function retitle(db: Database, workStore: WorkItemStore, featureId: string, title: string): WorkItem {
  db.prepare("update work_items set title = ? where feature_id = ?").run(title, featureId);
  return workStore.touch(workStore.getByFeature(featureId)!.id)!;
}

function writeItem(db: Database, workStore: WorkItemStore, sse: AgentSseEmitter, featureId: string, title: string): void {
  sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(retitle(db, workStore, featureId, title)) });
}
