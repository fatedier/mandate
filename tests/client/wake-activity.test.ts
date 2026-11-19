import { beforeEach, describe, expect, test } from "bun:test";
import { useWakeActivityStore } from "@/store/wake-activity";
import type { ActiveWakeDto, ActiveWakesResponse } from "@shared/api-contracts";
import { mockFetch } from "../helpers/fetch.js";

function activeWorkers(): string[] {
  return [...useWakeActivityStore.getState().activeByWorkerId.keys()].sort();
}

function wakeOf(workerId: string): string | undefined {
  return useWakeActivityStore.getState().activeByWorkerId.get(workerId)?.wakeId;
}

function startOf(workerId: string): string | undefined {
  return useWakeActivityStore.getState().activeByWorkerId.get(workerId)?.startedAt;
}

const STARTED = "2026-09-29T10:00:00.000Z";

function snapshotEntry(overrides: Partial<ActiveWakeDto> = {}): ActiveWakeDto {
  return {
    threadId: "th-1",
    wakeId: "wake-1",
    scope: "worker",
    scopeId: "wkr-1",
    startedAt: "2026-09-29T10:00:00.000Z",
    ...overrides
  };
}

/** Workers already known to be at work, as the store holds them. */
function seed(...wakes: ActiveWakeDto[]): void {
  useWakeActivityStore.setState({ activeByWorkerId: new Map(wakes.map((w) => [w.scopeId!, { wakeId: w.wakeId, startedAt: w.startedAt }])) });
}

function deferResponses() {
  const requests: Array<{
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  mockFetch(() => new Promise<Response>((resolve, reject) => {
    requests.push({ resolve, reject });
  }));
  return requests;
}

describe("wake-activity store", () => {
  beforeEach(() => {
    useWakeActivityStore.setState({ activeByWorkerId: new Map() });
  });

  test("wakeFinished for a superseded wake is a no-op (New Chat race)", () => {
    const store = useWakeActivityStore.getState();
    // Wake A runs on the old thread; New Chat archives it WITHOUT cancelling,
    // then wake B starts on a fresh thread for the same worker. A's finished
    // event must not blank B's live signal.
    store.wakeStarted({ threadId: "th-old", wakeId: "wake-A", scope: "worker", scopeId: "wkr-1", startedAt: STARTED });
    store.wakeStarted({ threadId: "th-new", wakeId: "wake-B", scope: "worker", scopeId: "wkr-1", startedAt: STARTED });
    store.wakeFinished({ threadId: "th-old", wakeId: "wake-A", scope: "worker", scopeId: "wkr-1" });
    expect(wakeOf("wkr-1")).toBe("wake-B");

    store.wakeFinished({ threadId: "th-new", wakeId: "wake-B", scope: "worker", scopeId: "wkr-1" });
    expect(activeWorkers()).toEqual([]);
  });

  test("a refresh REPLACES the map — stale entries vanish", async () => {
    const store = useWakeActivityStore.getState();
    // Simulate a missed wakeFinished: wkr-stale is active in the client map
    // but absent from the authoritative snapshot.
    store.wakeStarted({ threadId: "th-s", wakeId: "wake-stale", scope: "worker", scopeId: "wkr-stale", startedAt: STARTED });
    mockFetch(() => Response.json({ wakes: [snapshotEntry({ threadId: "th-2", wakeId: "wake-2", scopeId: "wkr-2" })] }));
    await store.refetch();
    expect(activeWorkers()).toEqual(["wkr-2"]);
    expect(wakeOf("wkr-2")).toBe("wake-2");
  });

  test("each running wake keeps when it began, from the list and from its start event", async () => {
    const store = useWakeActivityStore.getState();
    mockFetch(() => Response.json({ wakes: [snapshotEntry({ scopeId: "wkr-1", startedAt: "2026-09-29T09:58:00.000Z" })] }));
    await store.refetch();
    expect(startOf("wkr-1")).toBe("2026-09-29T09:58:00.000Z");
    store.wakeStarted({ threadId: "th-2", wakeId: "wake-2", scope: "worker", scopeId: "wkr-2", startedAt: "2026-09-29T10:03:00.000Z" });
    expect(startOf("wkr-2")).toBe("2026-09-29T10:03:00.000Z");
    // A new wake of the same worker brings its own.
    store.wakeStarted({ threadId: "th-1", wakeId: "wake-9", scope: "worker", scopeId: "wkr-1", startedAt: "2026-09-29T10:05:00.000Z" });
    expect(startOf("wkr-1")).toBe("2026-09-29T10:05:00.000Z");
  });

  test("a refresh keeps only worker-scope wakes", async () => {
    mockFetch(() => Response.json({ wakes: [
      snapshotEntry({ threadId: "th-f", wakeId: "wake-f", scopeId: "wkr-1" }),
      snapshotEntry({ threadId: "th-o", wakeId: "wake-o", scope: "manager", scopeId: null })
    ] }));
    await useWakeActivityStore.getState().refetch();
    expect(activeWorkers()).toEqual(["wkr-1"]);
  });

  test("manager-scope events are ignored", () => {
    const store = useWakeActivityStore.getState();
    store.wakeStarted({ threadId: "th-o", wakeId: "wake-o", scope: "manager", scopeId: null, startedAt: STARTED });
    expect(activeWorkers()).toEqual([]);

    // A stray overview finish must not touch worker entries either.
    store.wakeStarted({ threadId: "th-1", wakeId: "wake-1", scope: "worker", scopeId: "wkr-1", startedAt: STARTED });
    store.wakeFinished({ threadId: "th-o", wakeId: "wake-o", scope: "manager", scopeId: null });
    expect(activeWorkers()).toEqual(["wkr-1"]);
  });

  test("a refresh preserves a start received in flight while repairing untouched workers", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    seed(snapshotEntry({ scopeId: "stale-worker" }));
    const refresh = store.refetch();
    store.wakeStarted(snapshotEntry());
    requests[0]!.resolve(Response.json({ wakes: [snapshotEntry({ scopeId: "disconnected-worker", wakeId: "missed-wake" })] }));
    await refresh;

    expect(activeWorkers()).toEqual(["disconnected-worker", "wkr-1"]);
    expect(wakeOf("wkr-1")).toBe("wake-1");
    // With the start it was heard with.
    expect(startOf("wkr-1")).toBe(snapshotEntry().startedAt);
    expect(wakeOf("disconnected-worker")).toBe("missed-wake");
  });

  for (const known of [true, false]) {
    test(`a finish received in flight prevents resurrection of a ${known ? "known" : "previously unknown"} wake`, async () => {
      const store = useWakeActivityStore.getState();
      const requests = deferResponses();
      if (known) seed(snapshotEntry());
      const refresh = store.refetch();
      store.wakeFinished(snapshotEntry());
      requests[0]!.resolve(Response.json({ wakes: [snapshotEntry()] }));
      await refresh;

      expect(activeWorkers()).toEqual([]);
    });
  }

  test("finishing an old wake in flight preserves a different wake found by the snapshot", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    seed(snapshotEntry());
    const refresh = store.refetch();
    store.wakeFinished(snapshotEntry());
    requests[0]!.resolve(Response.json({ wakes: [snapshotEntry({ threadId: "new-thread", wakeId: "new-wake" })] }));
    await refresh;

    expect(wakeOf("wkr-1")).toBe("new-wake");
  });

  test("a new-thread start followed by the old-thread finish survives a stale snapshot", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    const refresh = store.refetch();
    store.wakeStarted(snapshotEntry({ threadId: "new-thread", wakeId: "new-wake" }));
    store.wakeFinished(snapshotEntry());
    requests[0]!.resolve(Response.json({ wakes: [snapshotEntry()] }));
    await refresh;

    expect(wakeOf("wkr-1")).toBe("new-wake");
  });

  for (const includesFinished of [true, false]) {
    test(`a completed new-thread wake preserves an older running wake when the snapshot ${includesFinished ? "includes" : "omits"} the completed wake`, async () => {
      const store = useWakeActivityStore.getState();
      const requests = deferResponses();
      const older = snapshotEntry();
      const completed = snapshotEntry({ threadId: "new-thread", wakeId: "new-wake" });
      seed(older);
      const refresh = store.refetch();
      store.wakeStarted(completed);
      store.wakeFinished(completed);
      requests[0]!.resolve(Response.json({ wakes: includesFinished ? [older, completed] : [older] }));
      await refresh;

      expect(wakeOf("wkr-1")).toBe(older.wakeId);
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

    expect(wakeOf("wkr-1")).toBe("next-wake");
  });

  test("finishes for different unseen wakes are both retained during a refresh", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    const refresh = store.refetch();
    store.wakeFinished(snapshotEntry());
    store.wakeFinished(snapshotEntry({ threadId: "other-thread", wakeId: "other-wake" }));
    requests[0]!.resolve(Response.json({ wakes: [snapshotEntry()] }));
    await refresh;

    expect(activeWorkers()).toEqual([]);
  });

  for (const newestFirst of [true, false]) {
    test(`overlapping refreshes only apply the latest request when it finishes ${newestFirst ? "first" : "last"}`, async () => {
      const store = useWakeActivityStore.getState();
      const requests = deferResponses();
      const older = store.refetch();
      const newest = store.refetch();
      store.wakeStarted(snapshotEntry());
      const held = useWakeActivityStore.getState().activeByWorkerId;
      const replyToOlder = async () => {
        requests[0]!.resolve(Response.json({ wakes: [snapshotEntry({ scopeId: "stale-worker", wakeId: "stale-wake" })] }));
        await older;
      };
      if (!newestFirst) {
        await replyToOlder();
        expect(useWakeActivityStore.getState().activeByWorkerId).toBe(held);
      }
      requests[1]!.resolve(Response.json({ wakes: [snapshotEntry({ scopeId: "current-worker", wakeId: "current-wake" })] }));
      await newest;
      if (newestFirst) await replyToOlder();

      expect(activeWorkers()).toEqual(["current-worker", "wkr-1"]);
    });
  }

  test("a later refresh can clear an event retained by an earlier refresh", async () => {
    const store = useWakeActivityStore.getState();
    const requests = deferResponses();
    const first = store.refetch();
    store.wakeStarted(snapshotEntry());
    requests[0]!.resolve(Response.json({ wakes: [] }));
    await first;
    expect(activeWorkers()).toEqual(["wkr-1"]);
    const second = store.refetch();
    requests[1]!.resolve(Response.json({ wakes: [] }));
    await second;

    expect(activeWorkers()).toEqual([]);
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
      expect(activeWorkers()).toEqual(["wkr-1"]);
      const retry = store.refetch();
      requests[1]!.resolve(Response.json({ wakes: [] }));
      await retry;

      expect(activeWorkers()).toEqual([]);
    });
  }
});
