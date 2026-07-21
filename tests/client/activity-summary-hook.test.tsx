import { afterEach, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActivityGroupKey, ActivitySummaryResponse } from "@shared/api-contracts";
import { activitySummaryCache, useActivitySummary } from "@/routes/activity/useActivitySummary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The hook holds one request at a time. Both cases below are invisible in the
 * rendered output — an overtaken response and a response arriving after unmount
 * look exactly like a slow network — so they are asserted on the signals the
 * hook handed to fetch.
 */

interface Call {
  url: string;
  signal: AbortSignal;
  settle: (body: unknown) => void;
  /** The network refusing, as distinct from the abort below: this one the
   *  reader is meant to see. */
  fail: (error: Error) => void;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const realNow = Date.now;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  globalThis.fetch = realFetch;
  Date.now = realNow;
  activitySummaryCache.clear();
  rendered = [];
});

/**
 * Replaces fetch with one that hands back every call, unresolved, so a test
 * decides the order things land in.
 *
 * It has to reject on abort, the way the real one does. A mock that ignored the
 * signal and resolved anyway would make the last-writer-wins test pass against
 * a hook that never aborted anything — the bug it exists to catch.
 */
function captureFetches({ ignoreAbort = false } = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    return new Promise((resolve, reject) => {
      const signal = init!.signal!;
      const fail = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (signal.aborted) return fail();
      if (!ignoreAbort) signal.addEventListener("abort", fail, { once: true });
      calls.push({
        url: String(url),
        signal,
        settle: (body) => resolve(new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" }
        })),
        fail: (error) => reject(error)
      });
    });
  }) as typeof fetch;
  return calls;
}

let latest: ReturnType<typeof useActivitySummary> | null = null;
let rendered: Array<ActivitySummaryResponse | null> = [];

function Probe({ group = "model", days = 30 }: { group?: ActivityGroupKey | null; days?: number }) {
  latest = useActivitySummary(group, days);
  rendered.push(latest.data);
  return <output>{latest.data ? String(latest.data.days) : latest.loading ? "loading" : "idle"}</output>;
}

async function mount(group: ActivityGroupKey | null = "model"): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root?.render(<Probe group={group} />); });
  return container;
}

async function regroup(group: ActivityGroupKey | null, days = 30): Promise<void> {
  await act(async () => { root?.render(<Probe group={group} days={days} />); });
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  rendered = [];
}

function summary(days = 30, group: ActivityGroupKey = "model", calls = 1): ActivitySummaryResponse {
  return {
    days, group, daily: [], buckets: [], groups: [], p50Ms: calls, p95Ms: calls, p99Ms: calls,
    ttft: { calls: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 }
  };
}

/** The way the app really mounts — `main.tsx` wraps `App` in `StrictMode`. React
 *  runs every effect's setup, then its cleanup, then its setup again, so any
 *  memory that survives in a ref has to agree with a teardown that already ran.
 *  Mounting bare, the way every other case here does, cannot see that at all. */
async function mountStrict(group: ActivityGroupKey | null = "model"): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<StrictMode><Probe group={group} /></StrictMode>);
  });
  return container;
}

test("a refresh abandons the request the mount started", async () => {
  const calls = captureFetches();
  await mount();
  expect(calls.length).toBe(1);
  expect(calls[0]!.signal.aborted).toBe(false);

  await act(async () => { void latest!.refresh(); });

  // Two requests, and the first is abandoned — so when the slower of the two
  // lands it cannot overwrite the answer the reader asked for last.
  expect(calls.length).toBe(2);
  expect(calls[0]!.signal.aborted).toBe(true);
  expect(calls[1]!.signal.aborted).toBe(false);
});

test("a refresh still in flight is abandoned when the tab goes away", async () => {
  const calls = captureFetches();
  await mount();
  await act(async () => { void latest!.refresh(); });
  expect(calls[1]!.signal.aborted).toBe(false);

  await act(async () => { root?.unmount(); });
  root = null;

  // Without this the response resolves onto a root React has torn down. The
  // mount request already carried a signal; the refresh was the hole.
  expect(calls[1]!.signal.aborted).toBe(true);
});

test("the answer that lands is the one the last request asked for", async () => {
  const calls = captureFetches();
  const page = await mount();
  await act(async () => { void latest!.refresh(); });

  // The overtaken request answers second and with a different window. An
  // unsignalled first request would win here purely by arriving late.
  await act(async () => { calls[1]!.settle({ days: 30, daily: [], buckets: [], groups: [] }); });
  await act(async () => { calls[0]!.settle({ days: 7, daily: [], buckets: [], groups: [] }); });

  expect(page.querySelector("output")?.textContent).toBe("30");
});

test("the grouping asked for is the one the request carries", async () => {
  // The percentiles a group carries cannot be recut from another grouping's
  // rows, so the dimension has to travel to the endpoint rather than be
  // applied here.
  const calls = captureFetches();
  await mount("scopeType");
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toContain("group=scopeType");
});

test("a caller with nothing to show asks for nothing", async () => {
  // The window is a 30-day aggregate over every call the install has made. A
  // tab that renders none of it should not be paying for one.
  const calls = captureFetches();
  await mount(null);
  expect(calls.length).toBe(0);
});

test("leaving an initial Logs view starts loading an uncached summary", async () => {
  const calls = captureFetches();
  const page = await mount(null);
  expect(latest!.loading).toBe(false);
  await regroup("purpose");
  expect(calls).toHaveLength(1);
  expect(latest!.data).toBeNull();
  expect(latest!.loading).toBe(true);
  expect(page.querySelector("output")?.textContent).toBe("loading");
  await act(async () => calls[0]!.settle(summary(30, "purpose")));
  expect(latest!.loading).toBe(false);
});

test("the cut already in hand is not asked for a second time", async () => {
  // Out to a tab that reads no summary and back again. `load` is memoized on
  // the grouping, so it is a different function on the way back and React
  // re-runs the effect either way — only the hook's own memory of what it
  // asked for stops that becoming a refetch of the answer still on screen.
  const calls = captureFetches();
  await mount("model");
  expect(calls.length).toBe(1);

  await regroup(null);
  await regroup("model");
  expect(calls.length).toBe(1);
  expect(calls[0]!.signal.aborted).toBe(false);
});

test("the dev double-mount is not left holding a request it already abandoned", async () => {
  // StrictMode runs setup, cleanup, then setup again. The cleanup aborts the
  // request in flight — but the ref remembering what was asked for survives a
  // simulated remount, so unless the teardown forgets it too the second setup
  // skips and the page sits on a skeleton with no request behind it. The one
  // way out is Refresh, which the same `loading` disables.
  const calls = captureFetches();
  const page = await mountStrict("model");
  expect(calls.length).toBe(2);
  // The first is the one the cleanup threw away; the second is the live one.
  expect(calls.map((call) => call.signal.aborted)).toEqual([true, false]);

  await act(async () => {
    calls[1]!.settle({ days: 30, daily: [], buckets: [], group: "model", groups: [] });
  });
  expect(latest!.loading).toBe(false);
  expect(page.querySelector("output")?.textContent).toBe("30");
});

test("a request still in flight when the reader steps away is left to land", async () => {
  // Abandoning it here throws away a request already paid for, and — because
  // the hook holds what it asked for — the tab that wanted it comes back to a
  // skeleton that never resolves: nothing re-asks, and nothing ever answered.
  const calls = captureFetches();
  const page = await mount("model");
  await regroup(null);
  expect(calls[0]!.signal.aborted).toBe(false);

  await act(async () => {
    calls[0]!.settle({ days: 30, daily: [], buckets: [], group: "model", groups: [] });
  });
  await regroup("model");
  expect(calls.length).toBe(1);
  expect(page.querySelector("output")?.textContent).toBe("30");
});

test("a cut that failed is asked for again on the way back", async () => {
  // A held cut is one the hook has; a failed request left it nothing. Coming
  // back to the tab that wanted it has to try again rather than sit on the
  // error until the reader finds Refresh.
  const calls = captureFetches();
  await mount("model");
  await act(async () => {
    calls[0]!.fail(new Error("network down"));
  });
  expect(latest!.error).toBe("network down");

  await regroup(null);
  await regroup("model");
  expect(calls.length).toBe(2);
});

test("re-grouping abandons the cut the reader moved off", async () => {
  const calls = captureFetches();
  const page = await mount("model");
  await regroup("purpose");

  expect(calls.length).toBe(2);
  expect(calls[1]!.url).toContain("group=purpose");
  expect(calls[0]!.signal.aborted).toBe(true);

  // Switching twice in quick succession settles on the second, not on whichever
  // came back last: the abandoned cut answers after the live one here, and
  // without the abort it would overwrite the grouping being looked at.
  await act(async () => {
    calls[1]!.settle({ days: 30, daily: [], buckets: [], group: "purpose", groups: [] });
  });
  await act(async () => {
    calls[0]!.settle({ days: 7, daily: [], buckets: [], group: "model", groups: [] });
  });
  expect(page.querySelector("output")?.textContent).toBe("30");
});

test("returning within five minutes renders the cached answer on the first render without fetching", async () => {
  let now = 1_000;
  Date.now = () => now;
  const calls = captureFetches();
  await mount();
  await act(async () => calls[0]!.settle(summary()));
  await unmount();

  now += 5 * 60_000 - 1;
  await mount();
  expect(calls).toHaveLength(1);
  expect(rendered[0]).toEqual(summary());
  expect(latest!.loading).toBe(false);
});

test("expiry retains the cached answer while refreshing and starts a new five-minute period on success", async () => {
  let now = 1_000;
  Date.now = () => now;
  const calls = captureFetches();
  await mount();
  await act(async () => calls[0]!.settle(summary()));
  await unmount();

  now += 5 * 60_000;
  await mount();
  expect(calls).toHaveLength(2);
  expect(rendered[0]).toEqual(summary());
  expect(latest!.data).toEqual(summary());
  expect(latest!.loading).toBe(true);

  now += 1_000;
  await act(async () => calls[1]!.settle(summary(30, "model", 2)));
  expect(latest!.data!.p50Ms).toBe(2);
  expect(latest!.loading).toBe(false);
  await unmount();
  now += 5 * 60_000 - 1;
  await mount();
  expect(calls).toHaveLength(2);
  expect(rendered[0]!.p50Ms).toBe(2);
});

test("a failed background refresh preserves stale data and retries on the next visit", async () => {
  let now = 1_000;
  Date.now = () => now;
  const calls = captureFetches();
  await mount();
  await act(async () => calls[0]!.settle(summary()));
  await unmount();
  now += 5 * 60_000;
  await mount();
  await act(async () => calls[1]!.fail(new Error("offline")));
  expect(latest!.data).toEqual(summary());
  expect(latest!.error).toBe("offline");
  expect(latest!.loading).toBe(false);

  await unmount();
  await mount();
  expect(calls).toHaveLength(3);
  expect(latest!.data).toEqual(summary());
  await act(async () => calls[2]!.settle(summary(30, "model", 2)));
  expect(latest!.error).toBe("");
  expect(latest!.data!.p50Ms).toBe(2);
});

test("Refresh bypasses a fresh cache and stores the replacement", async () => {
  const calls = captureFetches();
  await mount();
  await act(async () => calls[0]!.settle(summary()));
  await act(async () => { void latest!.refresh(); });
  expect(calls).toHaveLength(2);
  expect(latest!.data).toEqual(summary());
  expect(latest!.loading).toBe(true);
  await act(async () => calls[1]!.settle(summary(30, "model", 2)));
  await unmount();
  await mount();
  expect(calls).toHaveLength(2);
  expect(latest!.data!.p50Ms).toBe(2);
});

for (const returnVia of ["Logs", "remount"]) {
  test(`a failed manual refresh keeps the data but retries on return via ${returnVia}`, async () => {
    Date.now = () => 1_000;
    const calls = captureFetches();
    await mount();
    await act(async () => calls[0]!.settle(summary()));
    await act(async () => { void latest!.refresh(); });
    await act(async () => calls[1]!.fail(new Error("offline")));
    expect(latest!.data).toEqual(summary());
    expect(latest!.error).toBe("offline");

    if (returnVia === "Logs") {
      await regroup(null);
      await regroup("model");
    } else {
      await unmount();
      await mount();
    }
    expect(calls).toHaveLength(3);
    expect(latest!.data).toEqual(summary());
    expect(latest!.loading).toBe(true);
    await act(async () => calls[2]!.settle(summary(30, "model", 2)));
    expect(latest!.error).toBe("");
    await unmount();
    await mount();
    expect(calls).toHaveLength(3);
    expect(latest!.data!.p50Ms).toBe(2);
  });
}

test("each grouping and time window keeps its own cached answer", async () => {
  const calls = captureFetches();
  await mount();
  await act(async () => calls[0]!.settle(summary()));
  await regroup("model", 7);
  expect(calls[1]!.url).toContain("days=7");
  await act(async () => calls[1]!.settle(summary(7)));
  await regroup("purpose", 7);
  expect(calls[2]!.url).toContain("group=purpose");
  await act(async () => calls[2]!.settle(summary(7, "purpose")));

  await regroup("model", 30);
  expect(latest!.data).toEqual(summary());
  await regroup("model", 7);
  expect(latest!.data).toEqual(summary(7));
  await regroup("purpose", 7);
  expect(latest!.data).toEqual(summary(7, "purpose"));
  expect(calls).toHaveLength(3);
});

test("returning to a cached grouping cancels the other grouping's pending response", async () => {
  const calls = captureFetches({ ignoreAbort: true });
  await mount();
  await act(async () => calls[0]!.settle(summary()));
  await regroup("purpose");
  await regroup("model");
  expect(calls[1]!.signal.aborted).toBe(true);
  await act(async () => calls[1]!.settle(summary(30, "purpose")));
  expect(latest!.data).toEqual(summary());
  expect(activitySummaryCache.has("purpose:30")).toBe(false);
});

test("an overtaken response cannot overwrite the cache even if transport delivers it after abort", async () => {
  const calls = captureFetches({ ignoreAbort: true });
  await mount();
  await act(async () => { void latest!.refresh(); });
  await act(async () => calls[1]!.settle(summary(30, "model", 2)));
  await act(async () => calls[0]!.settle(summary()));
  await unmount();
  await mount();
  expect(calls).toHaveLength(2);
  expect(latest!.data!.p50Ms).toBe(2);
});

test("expiry does not poll an open page but returning from Logs revalidates it", async () => {
  let now = 1_000;
  Date.now = () => now;
  const calls = captureFetches();
  await mount();
  await act(async () => calls[0]!.settle(summary()));
  now += 5 * 60_000;
  expect(calls).toHaveLength(1);
  await regroup(null);
  await regroup("model");
  expect(calls).toHaveLength(2);
  expect(latest!.data).toEqual(summary());
});

test("two mounted readers share a request and one leaving does not cancel the other's fetch", async () => {
  const calls = captureFetches();
  await mount();
  const otherContainer = document.createElement("div");
  document.body.appendChild(otherContainer);
  const otherRoot = createRoot(otherContainer);
  try {
    await act(async () => otherRoot.render(<Probe />));
    expect(calls).toHaveLength(1);
    await unmount();
    expect(calls[0]!.signal.aborted).toBe(false);
    await act(async () => calls[0]!.settle(summary()));
    expect(otherContainer.textContent).toBe("30");
    expect(latest!.loading).toBe(false);
  } finally {
    await act(async () => otherRoot.unmount());
    otherContainer.remove();
  }
});
