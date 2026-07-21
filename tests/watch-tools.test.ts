import { expect, test } from "bun:test";
import { WindowWatchManager } from "../src/server/modules/agent/window-watch-manager.js";
import {
  buildCancelWatchTool,
  buildListMyWatchesTool
} from "../src/server/modules/agent/tools/watch-tools.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

// Manager fixture with a fixed, unmoving pane state — these tests exercise
// the two management tools, not the settle/timeout machinery covered in
// window-watch-manager.test.ts.
function makeManager(env: ReturnType<typeof freshStoresEnv>) {
  return new WindowWatchManager({
    db: env.store.db,
    agentStore: env.agentStore,
    sse: { emit: () => {} },
    onWake: () => "wake-1",
    isThreadBusy: () => false,
    getPaneState: () => ({ status: "ok", changedAt: null }),
    capturePaneTail: async () => ""
  });
}

test("cancel_watch cancels this thread's watch", async () => {
  const env = freshStoresEnv("md-watch-tools-");
  try {
    const threadA = env.agentStore.getOrCreateThread("manager", null);
    const manager = makeManager(env);
    // Two watches on the same thread, differing in paneId and stableMs, so
    // "the survivor is the other one" can be checked by identity rather than
    // by count — a single-watch fixture cannot tell "cancelled the watch
    // named by input.watchId" from "cancelled whatever this thread had".
    // The one we cancel is registered *second*: a handler that ignored
    // watchId and cancelled the thread's first watch instead would, with a
    // first-registered target, produce the same observable result as
    // correct code — insertion order would mask the bug. Targeting the
    // second-registered watch rules that out.
    const other = manager.register({
      ownerThreadId: threadA.id,
      windowKey: "md-p:f",
      paneId: "%1",
      stableMs: 1000
    });
    const target = manager.register({
      ownerThreadId: threadA.id,
      windowKey: "md-p:g",
      paneId: "%2",
      stableMs: 2000
    });
    const cancelTool = buildCancelWatchTool(manager);

    const result = await cancelTool.handler({ watchId: target.watchId }, { threadId: threadA.id } as never);
    expect(result).toMatchObject({ ok: true, watchId: target.watchId });

    const remaining = manager.list(threadA.id);
    expect(remaining).toHaveLength(1);
    // Assert *which* watch survived, by the field its identity actually
    // rests on (paneId), not merely that one watch remains.
    expect(remaining[0]).toMatchObject({ id: other.watchId, paneId: "%1", stableMs: 1000 });
    manager.dispose();
  } finally {
    env.cleanup();
  }
});

test("cancel_watch refuses another thread's watch with an error, not a throw", async () => {
  const env = freshStoresEnv("md-watch-tools-");
  try {
    const threadA = env.agentStore.getOrCreateThread("manager", null);
    const threadB = env.agentStore.getOrCreateThread("worker", "feat-b");
    const manager = makeManager(env);
    const reg = manager.register({
      ownerThreadId: threadA.id,
      windowKey: "md-p:f",
      paneId: "%1",
      stableMs: 1000
    });
    const cancelTool = buildCancelWatchTool(manager);

    const result = await cancelTool.handler({ watchId: reg.watchId }, { threadId: threadB.id } as never);
    expect(result).toMatchObject({ error: expect.stringContaining(reg.watchId) });
    // Positive half: it is still alive for its owner — this is a refusal,
    // not a crash that happened to also delete the watch.
    expect(manager.list(threadA.id)).toHaveLength(1);
    manager.dispose();
  } finally {
    env.cleanup();
  }
});

test("list_my_watches returns this thread's watches with their parameters", async () => {
  const env = freshStoresEnv("md-watch-tools-");
  try {
    const threadA = env.agentStore.getOrCreateThread("manager", null);
    const manager = makeManager(env);
    const reg = manager.register({
      ownerThreadId: threadA.id,
      windowKey: "md-p:f",
      paneId: "%1",
      stableMs: 1000,
      note: "waiting on build"
    });
    const listTool = buildListMyWatchesTool(manager);

    const result = await listTool.handler({}, { threadId: threadA.id } as never) as { watches: Array<Record<string, unknown>> };
    expect(result.watches).toHaveLength(1);
    const watch = result.watches[0]!;
    // Pin the full field set the brief specifies (watchId, paneId, windowKey,
    // stableMs, note, createdAt, timeoutAt) — a plain toMatchObject on two
    // fields would not notice windowKey or note silently dropping out.
    expect(Object.keys(watch).sort()).toEqual(
      ["createdAt", "note", "paneId", "stableMs", "timeoutAt", "watchId", "windowKey"]
    );
    expect(watch).toMatchObject({
      watchId: reg.watchId,
      paneId: "%1",
      windowKey: "md-p:f",
      stableMs: 1000,
      note: "waiting on build"
    });
    expect(Date.parse(watch.createdAt as string)).not.toBeNaN();
    expect(Date.parse(watch.timeoutAt as string)).not.toBeNaN();
    manager.dispose();
  } finally {
    env.cleanup();
  }
});

test("list_my_watches does not leak another thread's watches", async () => {
  const env = freshStoresEnv("md-watch-tools-");
  try {
    const threadA = env.agentStore.getOrCreateThread("manager", null);
    const threadB = env.agentStore.getOrCreateThread("worker", "feat-b");
    const manager = makeManager(env);
    manager.register({
      ownerThreadId: threadA.id,
      windowKey: "md-p:f",
      paneId: "%1",
      stableMs: 1000
    });
    manager.register({
      ownerThreadId: threadB.id,
      windowKey: "md-p:g",
      paneId: "%2",
      stableMs: 2000
    });
    const listTool = buildListMyWatchesTool(manager);

    const result = await listTool.handler({}, { threadId: threadA.id } as never) as { watches: unknown[] };
    expect(result.watches).toHaveLength(1);
    expect(result.watches[0]).toMatchObject({ paneId: "%1", stableMs: 1000 });
    manager.dispose();
  } finally {
    env.cleanup();
  }
});
