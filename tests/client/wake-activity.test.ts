import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useWakeActivityStore } from "@/store/wake-activity";
import type { ActiveWakeDto, ActiveWakesResponse } from "@shared/api-contracts";

function activeFeatures(): string[] {
  return [...useWakeActivityStore.getState().activeByFeatureId.keys()].sort();
}

function wakeOf(featureId: string): string | undefined {
  return useWakeActivityStore.getState().activeByFeatureId.get(featureId);
}

function snapshotEntry(overrides: Partial<ActiveWakeDto> = {}): ActiveWakeDto {
  return {
    threadId: "th-1",
    wakeId: "wake-1",
    scope: "worker",
    scopeId: "feat-1",
    ...overrides
  };
}

const originalFetch = globalThis.fetch;

function deferResponses() {
  const requests: Array<{
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  globalThis.fetch = (() => new Promise<Response>((resolve, reject) => {
    requests.push({ resolve, reject });
  })) as unknown as typeof fetch;
  return requests;
}

describe("wake-activity store", () => {
  beforeEach(() => {
    useWakeActivityStore.getState().applySnapshot([]);
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  test("wakeStarted marks the feature active; wakeFinished clears it", () => {
    const store = useWakeActivityStore.getState();
    store.wakeStarted({ threadId: "th-1", wakeId: "wake-1", scope: "worker", scopeId: "feat-1" });
    expect(wakeOf("feat-1")).toBe("wake-1");

    store.wakeFinished({ threadId: "th-1", wakeId: "wake-1", scope: "worker", scopeId: "feat-1" });
    expect(activeFeatures()).toEqual([]);
  });

  test("wakeFinished for a superseded wake is a no-op (New Chat race)", () => {
    const store = useWakeActivityStore.getState();
    // Wake A runs on the old thread; New Chat archives it WITHOUT cancelling,
    // then wake B starts on a fresh thread for the same feature. A's finished
    // event must not blank B's live signal.
    store.wakeStarted({ threadId: "th-old", wakeId: "wake-A", scope: "worker", scopeId: "feat-1" });
    store.wakeStarted({ threadId: "th-new", wakeId: "wake-B", scope: "worker", scopeId: "feat-1" });
    store.wakeFinished({ threadId: "th-old", wakeId: "wake-A", scope: "worker", scopeId: "feat-1" });
    expect(wakeOf("feat-1")).toBe("wake-B");

    store.wakeFinished({ threadId: "th-new", wakeId: "wake-B", scope: "worker", scopeId: "feat-1" });
    expect(activeFeatures()).toEqual([]);
  });

  test("applySnapshot REPLACES the map — stale entries vanish", () => {
    const store = useWakeActivityStore.getState();
    // Simulate a missed wakeFinished: feat-stale is active in the client map
    // but absent from the authoritative snapshot.
    store.wakeStarted({ threadId: "th-s", wakeId: "wake-stale", scope: "worker", scopeId: "feat-stale" });
    store.applySnapshot([snapshotEntry({ threadId: "th-2", wakeId: "wake-2", scopeId: "feat-2" })]);
    expect(activeFeatures()).toEqual(["feat-2"]);
    expect(wakeOf("feat-2")).toBe("wake-2");
  });

  test("applySnapshot keeps only feature-scope wakes", () => {
    useWakeActivityStore.getState().applySnapshot([
      snapshotEntry({ threadId: "th-f", wakeId: "wake-f", scopeId: "feat-1" }),
      snapshotEntry({ threadId: "th-o", wakeId: "wake-o", scope: "manager", scopeId: null })
    ]);
    expect(activeFeatures()).toEqual(["feat-1"]);
  });

  test("manager-scope events are ignored", () => {
    const store = useWakeActivityStore.getState();
    store.wakeStarted({ threadId: "th-o", wakeId: "wake-o", scope: "manager", scopeId: null });
    expect(activeFeatures()).toEqual([]);

    // A stray overview finish must not touch feature entries either.
    store.wakeStarted({ threadId: "th-1", wakeId: "wake-1", scope: "worker", scopeId: "feat-1" });
    store.wakeFinished({ threadId: "th-o", wakeId: "wake-o", scope: "manager", scopeId: null });
    expect(activeFeatures()).toEqual(["feat-1"]);
  });

  test("events without scope are a no-op (backward compat with older servers)", () => {
    const store = useWakeActivityStore.getState();
    store.wakeStarted({ threadId: "th-1", wakeId: "wake-1" });
    expect(activeFeatures()).toEqual([]);

    store.wakeStarted({ threadId: "th-1", wakeId: "wake-1", scope: "worker", scopeId: "feat-1" });
    store.wakeFinished({ threadId: "th-1", wakeId: "wake-1" });
    expect(activeFeatures()).toEqual(["feat-1"]);
  });

  test("a second wake on the same feature replaces the tracked wakeId", () => {
    const store = useWakeActivityStore.getState();
    // Per-thread wakes are serialized server-side, so started(w2) can only
    // arrive after finished(w1); a late finished(w1) after started(w2) cannot
    // happen on an ordered SSE stream. Unconditional delete-by-feature is safe.
    store.wakeStarted({ threadId: "th-1", wakeId: "wake-1", scope: "worker", scopeId: "feat-1" });
    store.wakeFinished({ threadId: "th-1", wakeId: "wake-1", scope: "worker", scopeId: "feat-1" });
    store.wakeStarted({ threadId: "th-1", wakeId: "wake-2", scope: "worker", scopeId: "feat-1" });
    expect(wakeOf("feat-1")).toBe("wake-2");
  });

  test("a refresh preserves a start received in flight while repairing untouched features", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    store.applySnapshot([snapshotEntry({ scopeId: "stale-feature" })]);
    const refresh = store.refetch();
    store.wakeStarted(snapshotEntry());
    requests[0]!.resolve(Response.json({ wakes: [snapshotEntry({ scopeId: "disconnected-feature", wakeId: "missed-wake" })] }));
    await refresh;

    expect(activeFeatures()).toEqual(["disconnected-feature", "feat-1"]);
    expect(wakeOf("feat-1")).toBe("wake-1");
    expect(wakeOf("disconnected-feature")).toBe("missed-wake");
  });

  for (const known of [true, false]) {
    test(`a finish received in flight prevents resurrection of a ${known ? "known" : "previously unknown"} wake`, async () => {
      const store = useWakeActivityStore.getState();
      const requests = deferResponses();
      if (known) store.applySnapshot([snapshotEntry()]);
      const refresh = store.refetch();
      store.wakeFinished(snapshotEntry());
      requests[0]!.resolve(Response.json({ wakes: [snapshotEntry()] }));
      await refresh;

      expect(activeFeatures()).toEqual([]);
    });
  }

  test("finishing an old wake in flight preserves a different wake found by the snapshot", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    store.applySnapshot([snapshotEntry()]);
    const refresh = store.refetch();
    store.wakeFinished(snapshotEntry());
    requests[0]!.resolve(Response.json({ wakes: [snapshotEntry({ threadId: "new-thread", wakeId: "new-wake" })] }));
    await refresh;

    expect(wakeOf("feat-1")).toBe("new-wake");
  });

  test("a new-thread start followed by the old-thread finish survives a stale snapshot", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    const refresh = store.refetch();
    store.wakeStarted(snapshotEntry({ threadId: "new-thread", wakeId: "new-wake" }));
    store.wakeFinished(snapshotEntry());
    requests[0]!.resolve(Response.json({ wakes: [snapshotEntry()] }));
    await refresh;

    expect(wakeOf("feat-1")).toBe("new-wake");
  });

  for (const includesFinished of [true, false]) {
    test(`a completed new-thread wake preserves an older running wake when the snapshot ${includesFinished ? "includes" : "omits"} the completed wake`, async () => {
      const store = useWakeActivityStore.getState();
      const requests = deferResponses();
      const older = snapshotEntry();
      const completed = snapshotEntry({ threadId: "new-thread", wakeId: "new-wake" });
      store.applySnapshot([older]);
      const refresh = store.refetch();
      store.wakeStarted(completed);
      store.wakeFinished(completed);
      requests[0]!.resolve(Response.json({ wakes: includesFinished ? [older, completed] : [older] }));
      await refresh;

      expect(wakeOf("feat-1")).toBe(older.wakeId);
    });
  }

  test("start and finish events are replayed in order through body parsing", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    const refresh = store.refetch();
    let finishBody!: (body: ActiveWakesResponse) => void;
    let parsing!: () => void;
    const parsingStarted = new Promise<void>((resolve) => { parsing = resolve; });
    const response = new Response();
    response.json = () => {
      parsing();
      return new Promise((resolve) => { finishBody = resolve; });
    };
    requests[0]!.resolve(response);
    await parsingStarted;
    store.wakeStarted(snapshotEntry());
    store.wakeFinished(snapshotEntry());
    store.wakeStarted(snapshotEntry({ wakeId: "next-wake" }));
    finishBody({ wakes: [] });
    await refresh;

    expect(wakeOf("feat-1")).toBe("next-wake");
  });

  test("finishes for different unseen wakes are both retained during a refresh", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    const refresh = store.refetch();
    store.wakeFinished(snapshotEntry());
    store.wakeFinished(snapshotEntry({ threadId: "other-thread", wakeId: "other-wake" }));
    requests[0]!.resolve(Response.json({ wakes: [snapshotEntry()] }));
    await refresh;

    expect(activeFeatures()).toEqual([]);
  });

  for (const newestFirst of [true, false]) {
    test(`overlapping refreshes only apply the latest request when it finishes ${newestFirst ? "first" : "last"}`, async () => {
      const store = useWakeActivityStore.getState();
      const requests = deferResponses();
      const older = store.refetch();
      const newest = store.refetch();
      store.wakeStarted(snapshotEntry());
      const held = useWakeActivityStore.getState().activeByFeatureId;
      const replyToOlder = async () => {
        requests[0]!.resolve(Response.json({ wakes: [snapshotEntry({ scopeId: "stale-feature", wakeId: "stale-wake" })] }));
        await older;
      };
      if (!newestFirst) {
        await replyToOlder();
        expect(useWakeActivityStore.getState().activeByFeatureId).toBe(held);
      }
      requests[1]!.resolve(Response.json({ wakes: [snapshotEntry({ scopeId: "current-feature", wakeId: "current-wake" })] }));
      await newest;
      if (newestFirst) await replyToOlder();

      expect(activeFeatures()).toEqual(["current-feature", "feat-1"]);
    });
  }

  test("a later refresh can clear an event retained by an earlier refresh", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    const first = store.refetch();
    store.wakeStarted(snapshotEntry());
    requests[0]!.resolve(Response.json({ wakes: [] }));
    await first;
    expect(activeFeatures()).toEqual(["feat-1"]);
    const second = store.refetch();
    requests[1]!.resolve(Response.json({ wakes: [] }));
    await second;

    expect(activeFeatures()).toEqual([]);
  });

  test("an explicit snapshot supersedes a pending refresh", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    const refresh = store.refetch();
    store.applySnapshot([snapshotEntry({ wakeId: "authoritative-wake" })]);
    requests[0]!.resolve(Response.json({ wakes: [] }));
    await refresh;

    expect(wakeOf("feat-1")).toBe("authoritative-wake");
  });

  for (const failure of ["http", "network", "json"] as const) {
    test(`a ${failure} failure preserves live state and does not leak events into a retry`, async () => {
      const store = useWakeActivityStore.getState();
      const requests = deferResponses();
      const refresh = store.refetch();
      store.wakeStarted(snapshotEntry());
      if (failure === "network") requests[0]!.reject(new Error("Disconnected"));
      else requests[0]!.resolve(failure === "http" ? new Response(null, { status: 503 }) : new Response("invalid JSON"));
      if (failure === "http") await refresh;
      else await expect(refresh).rejects.toThrow();
      expect(activeFeatures()).toEqual(["feat-1"]);
      const retry = store.refetch();
      requests[1]!.resolve(Response.json({ wakes: [] }));
      await retry;

      expect(activeFeatures()).toEqual([]);
    });
  }
});
