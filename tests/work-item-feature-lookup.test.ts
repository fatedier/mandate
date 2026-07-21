import { expect, test, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { WorkItemChangeEmitter } from "../src/server/modules/agent/work-item-events.js";
import { registerWorkItemsRoutes } from "../src/server/modules/agent/work-items-routes.js";
import { broadcastWorkItemCreated } from "../src/server/modules/agent/work-item-created-broadcast.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { buildFeatureWorkItemTool } from "../src/server/modules/agent/tools/feature-work-item-tools.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import { attachSnapshotSseListeners } from "../src/client/lib/snapshot-sse-listeners.js";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";

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
  const agentStore = new AgentStore(db);
  const sse = new AgentSseEmitter({ workItemUpdateThrottleMs: 1 });

  const app = new Hono();
  registerWorkItemsRoutes(app, {
    agentStore, workStore, sse,
    wake: () => "wake-1"
  });
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

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return app.request(url, init);
  }) as typeof fetch;

  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
    ownership: "app", gitRemote: null, isGit: false
  });
  const newFeature = (name: string) =>
    features.insert({
      projectId, name, mode: "shared-cwd", branch: null, baseRef: null,
      worktreePath: null, tmuxWindowName: name, ownership: "app"
    });

  return { db, workStore, projectId, newFeature, unsubscribe, sse };
}

const originalFetch = globalThis.fetch;

function resetClientStore() {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map(),
    paginationByStatus: new Map()
  }, true);
}

function itemsFor(featureId: string): WorkItemDto[] {
  return [...useWorkItemsStore.getState().items.values()].filter((i) => i.featureId === featureId);
}

beforeEach(resetClientStore);
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetClientStore();
});

// ── the fetch fallback ───────────────────────────────────────────────────

test("fetchByFeature loads the item the list never delivered", async () => {
  const { newFeature, workStore, unsubscribe } = setup();
  try {
    const featureId = newFeature("late");
    workStore.update(workStore.getByFeature(featureId)!.id, {
      summary: "Arrived after the list was taken.",
      summaryBy: "worker"
    });
    resetClientStore();
    expect(itemsFor(featureId).length).toBe(0);

    await useWorkItemsStore.getState().fetchByFeature(featureId);

    const [item] = itemsFor(featureId);
    expect(item).toBeDefined();
    expect(item!.summary).toBe("Arrived after the list was taken.");
    // Provenance survives the full round trip: store → DTO → JSON → client.
    expect(item!.summaryUpdatedBy).toBe("worker");
    expect(item!.summaryUpdatedAt).not.toBeNull();
  } finally {
    unsubscribe();
  }
});

test("fetchByFeature returns only that feature's item, never a neighbour's", async () => {
  const { newFeature, unsubscribe } = setup();
  try {
    const mine = newFeature("mine");
    const theirs = newFeature("theirs");
    resetClientStore();

    await useWorkItemsStore.getState().fetchByFeature(mine);

    expect(itemsFor(mine).length).toBe(1);
    expect(itemsFor(theirs).length).toBe(0);
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

test("fetching twice does not duplicate the item", async () => {
  const { newFeature, unsubscribe } = setup();
  try {
    const featureId = newFeature("twice");
    resetClientStore();

    await useWorkItemsStore.getState().fetchByFeature(featureId);
    await useWorkItemsStore.getState().fetchByFeature(featureId);

    expect(itemsFor(featureId).length).toBe(1);
  } finally {
    unsubscribe();
  }
});

test("the fallback fetch does not disturb items already held for other features", async () => {
  const { newFeature, unsubscribe } = setup();
  try {
    const other = newFeature("other");
    const target = newFeature("target");
    resetClientStore();
    await useWorkItemsStore.getState().fetchByFeature(other);

    await useWorkItemsStore.getState().fetchByFeature(target);

    expect(itemsFor(other).length).toBe(1);
    expect(itemsFor(target).length).toBe(1);
    expect(useWorkItemsStore.getState().items.size).toBe(2);
  } finally {
    unsubscribe();
  }
});

// ── the route itself ─────────────────────────────────────────────────────

test("GET /api/work-items?featureId returns one item and no cursor", async () => {
  const { newFeature, unsubscribe } = setup();
  try {
    const featureId = newFeature("route");
    const res = await fetch(`/api/work-items?featureId=${featureId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: WorkItemDto[]; nextCursor: string | null };
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.featureId).toBe(featureId);
    expect(body.nextCursor).toBeNull();
  } finally {
    unsubscribe();
  }
});

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

test("the featureId lookup is not weakened by the list filters travelling with it", async () => {
  const { newFeature, unsubscribe } = setup();
  try {
    // needsUser=review would exclude this idle item from the list route.
    const featureId = newFeature("filtered");
    const res = await fetch(`/api/work-items?featureId=${featureId}&needsUser=review&limit=1`);
    const body = await res.json() as { items: WorkItemDto[] };
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.featureId).toBe(featureId);
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

test("the summary the feature agent writes next reaches the same item, in place", async () => {
  const { newFeature, workStore, unsubscribe, sse } = setup();
  try {
    const featureId = newFeature("evolving");
    // The real tool, which is what emits workItemUpdated in production.
    const tool = buildFeatureWorkItemTool({
      workStore, sse, resolveFeatureId: () => featureId
    });

    await tool.handler({ summary: "First conclusion." }, featureCtx());

    const held = itemsFor(featureId);
    expect(held.length).toBe(1);
    expect(held[0]!.summary).toBe("First conclusion.");
    expect(held[0]!.summaryUpdatedBy).toBe("worker");
    expect(held[0]!.summaryUpdatedAt).not.toBeNull();
  } finally {
    unsubscribe();
  }
});

test("created then updated then re-fetched is still exactly one item", async () => {
  const { newFeature, workStore, unsubscribe, sse } = setup();
  try {
    const featureId = newFeature("dedupe");
    const tool = buildFeatureWorkItemTool({
      workStore, sse, resolveFeatureId: () => featureId
    });

    await tool.handler({ summary: "Updated." }, featureCtx());
    await useWorkItemsStore.getState().fetchByFeature(featureId);

    const held = itemsFor(featureId);
    expect(held.length).toBe(1);
    expect(held[0]!.summary).toBe("Updated.");
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await routed(input, init);
    const body = await res.text();
    served = body;
    await heldBack;
    return new Response(body, {
      status: res.status, headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
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
  const { newFeature, workStore, unsubscribe, sse } = setup();
  try {
    const featureId = newFeature("racing");
    const tool = buildFeatureWorkItemTool({
      workStore, sse, resolveFeatureId: () => featureId
    });
    await tool.handler({ summary: "First conclusion.", phase: "working" }, featureCtx());
    resetClientStore();

    // 1. The pane asks for the item. The route answers from the row as it
    //    stands, but the client does not see that answer yet.
    const deferred = deferResponses();
    const inFlight = useWorkItemsStore.getState().fetchByFeature(featureId);
    const takenBody = await deferred.taken();
    expect(takenBody).not.toBeNull();
    const taken = JSON.parse(takenBody!) as { items: WorkItemDto[] };
    expect(taken.items[0]!.summary).toBe("First conclusion.");

    // 2. A newer write lands over SSE while that request is still outstanding.
    // phase='done' is also how the server raises needsUser to 'review', so a
    // rollback here would drop the flag the user is waiting on.
    await tick();
    await tool.handler({ summary: "Second conclusion.", phase: "done" }, featureCtx());
    const live = itemsFor(featureId)[0]!;
    expect(live.summary).toBe("Second conclusion.");
    // The two really are different generations. Were the clock ever to stop
    // separating them, this test would prove nothing and must say so.
    expect(Date.parse(live.updatedAt)).toBeGreaterThan(Date.parse(taken.items[0]!.updatedAt));

    // 3. Only now does the older response resolve.
    deferred.release();
    await inFlight;

    const [after] = itemsFor(featureId);
    expect(itemsFor(featureId).length).toBe(1);
    expect(after!.summary).toBe("Second conclusion.");
    expect(after!.phase).toBe("done");
    expect(after!.needsUser).toBe("review");
    expect(after!.summaryUpdatedAt).toBe(live.summaryUpdatedAt);
    expect(after!.summaryUpdatedBy).toBe(live.summaryUpdatedBy);
    expect(after!.updatedAt).toBe(live.updatedAt);
  } finally {
    unsubscribe();
  }
});

test("a GET stamped the same millisecond as the push that overtook it is dropped", async () => {
  const { newFeature, workStore, unsubscribe, sse } = setup();
  const unfreeze = freezeClock("2026-08-03T04:05:06.007Z");
  try {
    const featureId = newFeature("same-millisecond");
    const tool = buildFeatureWorkItemTool({
      workStore, sse, resolveFeatureId: () => featureId
    });
    await tool.handler({ summary: "First conclusion.", phase: "working" }, featureCtx());
    resetClientStore();

    // 1. The pane asks for the item; the route answers from the row as it
    //    stands, and the client is not handed that answer yet.
    const deferred = deferResponses();
    const inFlight = useWorkItemsStore.getState().fetchByFeature(featureId);
    const takenBody = await deferred.taken();
    expect(takenBody).not.toBeNull();
    const taken = JSON.parse(takenBody!) as { items: WorkItemDto[] };
    expect(taken.items[0]!.summary).toBe("First conclusion.");

    // 2. A newer write lands over SSE while that request is outstanding. Real
    //    time passes so the SSE throttle window drains, but the frozen clock
    //    hands this write the very same `updatedAt` as the one before it.
    await tick();
    await tool.handler({ summary: "Second conclusion.", phase: "done" }, featureCtx());
    const live = itemsFor(featureId)[0]!;
    expect(live.summary).toBe("Second conclusion.");
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
    expect(after!.summary).toBe("Second conclusion.");
    expect(after!.phase).toBe("done");
    expect(after!.needsUser).toBe("review");
    expect(after!.summaryUpdatedAt).toBe(live.summaryUpdatedAt);
    expect(after!.summaryUpdatedBy).toBe(live.summaryUpdatedBy);
  } finally {
    unfreeze();
    unsubscribe();
  }
});

test("a fetch newer than what the store holds is still applied", async () => {
  const { newFeature, workStore, unsubscribe, sse } = setup();
  try {
    const featureId = newFeature("forward");
    const tool = buildFeatureWorkItemTool({
      workStore, sse, resolveFeatureId: () => featureId
    });
    await tool.handler({ summary: "Held by the client." }, featureCtx());
    const stale = itemsFor(featureId)[0]!;
    expect(stale.summary).toBe("Held by the client.");

    // The server moves on with nobody listening — the SSE sink is removed, so
    // the client's copy is now genuinely behind the row.
    await tick();
    workStore.update(workStore.getByFeature(featureId)!.id, {
      summary: "Written while disconnected.", summaryBy: "manager"
    });

    // Precondition: the client is behind, so the fetch has something to do.
    expect(itemsFor(featureId)[0]!.summary).toBe("Held by the client.");

    await useWorkItemsStore.getState().fetchByFeature(featureId);

    const [after] = itemsFor(featureId);
    expect(after!.summary).toBe("Written while disconnected.");
    expect(after!.summaryUpdatedBy).toBe("manager");
  } finally {
    unsubscribe();
  }
});

function featureCtx(): ToolContext {
  return {
    threadId: "t-feature", wakeId: "w-1",
    scope: {
      kind: "worker",
      feature: { workingDir: "/tmp/p/feat" },
      project: { workingDir: "/tmp/p" }
    }
  };
}
