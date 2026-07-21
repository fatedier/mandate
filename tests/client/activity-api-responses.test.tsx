import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CallDetailPanel } from "@/routes/activity/CallDetailPanel";
import { useActivityData } from "@/routes/activity/useActivityData";
import type { ActivityCall } from "@/routes/activity/types";
import type { ActivityQueryFilters } from "@/routes/activity/useActivityFilters";

let root: Root;
let container: HTMLElement;
let originalFetch: typeof fetch;
const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousAct: boolean | undefined;
let filterId = 0;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousAct = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  try {
    await act(async () => { root.unmount(); });
  } finally {
    container.remove();
    globalThis.fetch = originalFetch;
    environment.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(node: ReactNode) {
  await act(async () => { root.render(node); });
  await settle();
}

async function mountList() {
  const queryFilters: ActivityQueryFilters = {
    status: null, purpose: null, provider: null, model: null,
    scopeType: null, day: null, fallback: null, q: `response-test-${++filterId}`
  };
  let state!: ReturnType<typeof useActivityData>;
  function Probe() {
    state = useActivityData({ filterKey: JSON.stringify(queryFilters), queryFilters });
    return null;
  }
  await render(<Probe />);
  return () => state;
}

function call(id: string): ActivityCall {
  return {
    id, purpose: "fixture", scopeType: null, scopeId: null, parentCallId: null,
    provider: "openai", model: "fixture-model", baseURL: null, apiMode: null,
    requestHash: "", responseHash: "", request: null, response: null,
    output: null, usage: null, metadata: null, inputTokens: null, outputTokens: null,
    totalTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    status: "succeeded", error: null, startedAt: null, finishedAt: null,
    latencyMs: null, ttftMs: null,
    createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z"
  };
}

const failures = [
  { name: "HTTP error message", response: () => Response.json({ error: "Activity unavailable" }, { status: 503 }), message: "Activity unavailable" },
  { name: "business error", response: () => Response.json({ ok: false, error: "Activity rejected" }), message: "Activity rejected" },
  { name: "bare error", response: () => Response.json({ error: "Call not found" }), message: "Call not found" },
  { name: "proxy HTML", response: () => new Response("<html>Proxy failure</html>", { status: 502 }), message: "HTTP 502" },
  { name: "invalid JSON", response: () => new Response("not json"), message: "Invalid JSON response" }
];

for (const scenario of failures) {
  test(`Activity initial load reports ${scenario.name}`, async () => {
    globalThis.fetch = (async () => scenario.response()) as typeof fetch;
    const state = await mountList();
    expect(state().error).toBe(scenario.message);
    expect(state().currentData).toBeNull();
    expect(state().initialLoading).toBe(false);
    expect(state().refreshing).toBe(false);
  });

  test(`Activity pagination reports ${scenario.name} and preserves loaded rows`, async () => {
    const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`));
    const requests: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      requests.push(url);
      return url.searchParams.has("before") ? scenario.response() : Response.json({ calls });
    }) as typeof fetch;
    const state = await mountList();
    await act(async () => { state().loadMore(); });
    await settle();
    expect(state().error).toBe(scenario.message);
    expect(state().calls).toEqual(calls);
    expect(state().loadingMore).toBe(false);
    expect(state().hasMore).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.searchParams.get("before")).toBe(calls[19]!.createdAt);
    expect(requests[1]!.searchParams.get("beforeId")).toBe(calls[19]!.id);
    expect(requests[1]!.searchParams.get("q")).toBe(requests[0]!.searchParams.get("q"));
  });

  test(`Activity detail displays ${scenario.name}`, async () => {
    globalThis.fetch = (async () => scenario.response()) as typeof fetch;
    await render(<CallDetailPanel callId="call-detail" onClose={() => {}} />);
    const panel = document.querySelector("[data-call-detail]");
    expect(panel?.textContent).toContain(scenario.message);
    expect(panel?.textContent).not.toContain("Loading");
    expect(panel?.querySelector("[data-call-fields]")).toBeNull();
  });
}

test("Activity appends a successful older page and retains rows while refreshing", async () => {
  const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`));
  globalThis.fetch = (async (input: RequestInfo | URL) => Response.json({
    calls: String(input).includes("before=") ? [call("older")] : calls
  })) as typeof fetch;
  const state = await mountList();
  await act(async () => { state().loadMore(); });
  expect(state().calls.map((row) => row.id)).toEqual([...calls.map((row) => row.id), "older"]);
  expect(state().hasMore).toBe(false);
  let resolve!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((done) => { resolve = done; })) as typeof fetch;
  let refresh!: Promise<void>;
  await act(async () => { refresh = state().fetchTopPage("refresh"); });
  expect(state().refreshing).toBe(true);
  expect(state().calls).toHaveLength(21);
  await act(async () => { resolve(Response.json({ calls: [call("newest")] })); await refresh; });
  expect(state().calls.map((row) => row.id)).toEqual(["newest"]);
  expect(state().error).toBe("");
  expect(state().refreshing).toBe(false);
});

function pendingBody(signal: AbortSignal) {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
    }
  }));
}

for (const count of [0, 1, 20]) {
  test(`Activity clears pagination errors after a retry returns ${count} rows`, async () => {
    const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`));
    const older = Array.from({ length: count }, (_, index) => call(`older-${index}`));
    let fail = true;
    const cursors: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (!url.searchParams.has("before")) return Response.json({ calls });
      cursors.push(url.search);
      return fail
        ? new Response("Unavailable", { status: 502 })
        : Response.json({ calls: older });
    }) as typeof fetch;
    const state = await mountList();
    await act(async () => { state().loadMore(); });
    expect(state().paginationError).toBe("HTTP 502");
    expect(state().calls).toEqual(calls);
    fail = false;
    await act(async () => { state().loadMore(); });
    expect(cursors).toHaveLength(2);
    expect(cursors[1]).toBe(cursors[0]);
    expect(state().paginationError).toBe("");
    expect(state().error).toBe("");
    expect(state().calls).toEqual([...calls, ...older]);
    expect(state().hasMore).toBe(count === 20);
    expect(state().loadingMore).toBe(false);
  });
}

test("Activity clears pagination failure when the feed refresh succeeds", async () => {
  const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`));
  globalThis.fetch = (async (input: RequestInfo | URL) => String(input).includes("before=")
    ? new Response("Unavailable", { status: 502 })
    : Response.json({ calls })) as typeof fetch;
  const state = await mountList();
  await act(async () => { state().loadMore(); });
  expect(state().paginationError).toBe("HTTP 502");
  await act(async () => { await state().fetchTopPage("refresh"); });
  expect(state().paginationError).toBe("");
  expect(state().error).toBe("");
  expect(state().hasMore).toBe(true);
  expect(state().calls).toEqual(calls);
});

test("Activity pagination recovery preserves a separate refresh error", async () => {
  const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`));
  globalThis.fetch = (async () => Response.json({ calls })) as typeof fetch;
  const state = await mountList();
  globalThis.fetch = (async () => new Response("Unavailable", { status: 502 })) as typeof fetch;
  await act(async () => { state().loadMore(); });
  globalThis.fetch = (async () => Response.json({ error: "Refresh unavailable" }, { status: 503 })) as typeof fetch;
  await act(async () => { await state().fetchTopPage("refresh"); });
  expect(state().paginationError).toBe("HTTP 502");
  globalThis.fetch = (async () => Response.json({ calls: [] })) as typeof fetch;
  await act(async () => { state().loadMore(); });
  expect(state().paginationError).toBe("");
  expect(state().error).toBe("Refresh unavailable");
  expect(state().calls).toEqual(calls);
});

test("Activity ignores an older-page failure arriving after a successful refresh", async () => {
  const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`));
  let rejectOlder!: (error: Error) => void;
  globalThis.fetch = (async (input: RequestInfo | URL) => String(input).includes("before=")
    // Deliberately settle with a transport error after cancellation.
    ? new Promise<Response>((_resolve, reject) => { rejectOlder = reject; })
    : Response.json({ calls })) as typeof fetch;
  const state = await mountList();
  await act(async () => { state().loadMore(); });
  await act(async () => { await state().fetchTopPage("refresh"); });
  await act(async () => { rejectOlder(new TypeError("Connection lost")); });
  expect(state().paginationError).toBe("");
  expect(state().error).toBe("");
  expect(state().loadingMore).toBe(false);
  expect(state().calls).toEqual(calls);
});

test("Activity ignores an aborted body when a newer refresh succeeds", async () => {
  let oldSignal!: AbortSignal;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    oldSignal = init!.signal!;
    return pendingBody(oldSignal);
  }) as typeof fetch;
  const state = await mountList();
  globalThis.fetch = (async () => Response.json({ calls: [call("newest")] })) as typeof fetch;
  await act(async () => { await state().fetchTopPage("refresh"); });
  expect(oldSignal.aborted).toBe(true);
  expect(state().error).toBe("");
  expect(state().calls.map((row) => row.id)).toEqual(["newest"]);
});

test("Activity detail ignores an aborted body and renders the newly selected call", async () => {
  let oldSignal!: AbortSignal;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    oldSignal = init!.signal!;
    return pendingBody(oldSignal);
  }) as typeof fetch;
  await render(<CallDetailPanel callId="old" onClose={() => {}} />);
  globalThis.fetch = (async () => Response.json({ call: {
    ...call("newest"), status: "failed", error: { message: "Provider rejected the request" }
  } })) as typeof fetch;
  await render(<CallDetailPanel callId="newest" onClose={() => {}} />);
  expect(oldSignal.aborted).toBe(true);
  const panel = document.querySelector("[data-call-detail]");
  expect(panel?.textContent).toContain("newest");
  expect(panel?.querySelector("[data-call-error]")?.textContent).toContain("Provider rejected the request");
  expect(panel?.querySelector("[data-call-fields]")).not.toBeNull();
  expect(panel?.textContent).not.toContain("Aborted");
});
