import { beforeEach, expect, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { CallDetailPanel } from "@/routes/activity/CallDetailPanel";
import { useActivityData } from "@/routes/activity/useActivityData";
import type { ActivityCall } from "@/routes/activity/types";
import type { ActivityQueryFilters } from "@/routes/activity/useActivityFilters";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;
let filterId = 0;

beforeEach(() => {
  view = null;
});

/** Renders into the test's one root: the first call mounts it, a later one
 *  renders the new tree into it. */
async function render(node: ReactNode) {
  if (view) view.rerender(node);
  else view = await mountAsync(node);
  await settle();
}

async function mountList() {
  const queryFilters: ActivityQueryFilters = {
    status: null, view: null, agent: null, purpose: null, provider: null, model: null,
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
    id, purpose: "fixture", scopeType: null, scopeId: null,
    providerName: null, provider: "openai", model: "fixture-model", baseURL: null, apiMode: null,
    requestHash: "", responseHash: "", request: null, response: null,
    output: null, usage: null, metadata: null, inputTokens: null, outputTokens: null,
    totalTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    status: "succeeded", error: null, startedAt: null, finishedAt: null,
    latencyMs: null, ttftMs: null,
    createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z",
    cost: null
  };
}

const failures = [
  { name: "HTTP error message", response: () => Response.json({ error: "Activity unavailable" }, { status: 503 }), message: "Activity unavailable" },
  { name: "business error", response: () => Response.json({ ok: false, error: "Activity rejected" }), message: "Activity rejected" }
];

for (const scenario of failures) {
  test(`Activity initial load reports ${scenario.name}`, async () => {
    mockFetch(() => scenario.response());
    const state = await mountList();
    expect(state().error).toBe(scenario.message);
    expect(state().currentData).toBeNull();
    expect(state().initialLoading).toBe(false);
    expect(state().refreshing).toBe(false);
  });

  test(`Activity pagination reports ${scenario.name} and preserves loaded rows`, async () => {
    const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`));
    const requests: URL[] = [];
    mockFetch((request) => {
      const url = new URL(request.url, "http://localhost");
      requests.push(url);
      return url.searchParams.has("before") ? scenario.response() : Response.json({ calls });
    });
    const state = await mountList();
    await act(async () => { state().loadMore(); });
    await settle();
    // The older page's failure, not the list's: the list is still good.
    expect(state().paginationError).toBe(scenario.message);
    expect(state().error).toBe("");
    expect(state().calls).toEqual(calls);
    expect(state().loadingMore).toBe(false);
    expect(state().hasMore).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.searchParams.get("before")).toBe(calls[19]!.createdAt);
    expect(requests[1]!.searchParams.get("beforeId")).toBe(calls[19]!.id);
    expect(requests[1]!.searchParams.get("q")).toBe(requests[0]!.searchParams.get("q"));
  });

  test(`Activity detail displays ${scenario.name}`, async () => {
    mockFetch(() => scenario.response());
    await render(<CallDetailPanel callId="call-detail" onClose={() => {}} />);
    const panel = document.querySelector("[data-call-detail]");
    expect(panel?.textContent).toContain(scenario.message);
    expect(panel?.textContent).not.toContain("Loading");
    expect(panel?.querySelector("[data-call-fields]") === null).toBe(true);
  });
}

test("Activity appends a successful older page and retains rows while refreshing", async () => {
  const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`));
  mockFetch(({ url }) => Response.json({
    calls: url.includes("before=") ? [call("older")] : calls
  }));
  const state = await mountList();
  await act(async () => { state().loadMore(); });
  expect(state().calls.map((row) => row.id)).toEqual([...calls.map((row) => row.id), "older"]);
  expect(state().hasMore).toBe(false);
  let resolve!: (response: Response) => void;
  mockFetch(() => new Promise<Response>((done) => { resolve = done; }));
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
    mockFetch((request) => {
      const url = new URL(request.url, "http://localhost");
      if (!url.searchParams.has("before")) return Response.json({ calls });
      cursors.push(url.search);
      return fail
        ? new Response("Unavailable", { status: 502 })
        : Response.json({ calls: older });
    });
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
  mockFetch(({ url }) => url.includes("before=")
    ? new Response("Unavailable", { status: 502 })
    : Response.json({ calls }));
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
  mockFetch(() => Response.json({ calls }));
  const state = await mountList();
  mockFetch(() => new Response("Unavailable", { status: 502 }));
  await act(async () => { state().loadMore(); });
  mockFetch(() => Response.json({ error: "Refresh unavailable" }, { status: 503 }));
  await act(async () => { await state().fetchTopPage("refresh"); });
  expect(state().paginationError).toBe("HTTP 502");
  mockFetch(() => Response.json({ calls: [] }));
  await act(async () => { state().loadMore(); });
  expect(state().paginationError).toBe("");
  expect(state().error).toBe("Refresh unavailable");
  expect(state().calls).toEqual(calls);
});

test("Activity ignores an older-page failure arriving after a successful refresh", async () => {
  const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`));
  let rejectOlder!: (error: Error) => void;
  mockFetch(({ url }) => url.includes("before=")
    // Deliberately settle with a transport error after cancellation.
    ? new Promise<Response>((_resolve, reject) => { rejectOlder = reject; })
    : Response.json({ calls }), { ignoreAbort: true });
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
  mockFetch(({ init }) => {
    oldSignal = init!.signal!;
    return pendingBody(oldSignal);
  });
  const state = await mountList();
  mockFetch(() => Response.json({ calls: [call("newest")] }));
  await act(async () => { await state().fetchTopPage("refresh"); });
  expect(oldSignal.aborted).toBe(true);
  expect(state().error).toBe("");
  expect(state().calls.map((row) => row.id)).toEqual(["newest"]);
});

test("Activity detail ignores an aborted body and renders the newly selected call", async () => {
  let oldSignal!: AbortSignal;
  mockFetch(({ init }) => {
    oldSignal = init!.signal!;
    return pendingBody(oldSignal);
  });
  await render(<CallDetailPanel callId="old" onClose={() => {}} />);
  mockFetch(() => Response.json({ call: {
    ...call("newest"), status: "failed", error: { message: "Provider rejected the request" }
  } }));
  await render(<CallDetailPanel callId="newest" onClose={() => {}} />);
  expect(oldSignal.aborted).toBe(true);
  const panel = document.querySelector("[data-call-detail]");
  expect(panel?.textContent).toContain("newest");
  expect(panel?.querySelector("[data-call-error]")?.textContent).toContain("Provider rejected the request");
  expect(panel?.querySelector("[data-call-fields]")).not.toBeNull();
  expect(panel?.textContent).not.toContain("Aborted");
});

test("Activity detail: the panel carries the fields the row stopped showing", async () => {
  mockFetch(() => Response.json({ call: {
    ...call("call-fields"), provider: "openai-compatible", providerName: "team-proxy", model: "codex/gpt-5.6-sol",
    metadata: { phase: "delivering", api: "responses" }
  } }));
  await render(<CallDetailPanel callId="call-fields" onClose={() => {}} />);
  const fields = document.querySelector("[data-call-detail] [data-call-fields]")?.textContent ?? "";
  // The provider by its name and the API it spoke; the internal family stays out.
  expect(fields).not.toContain("openai-compatible");
  for (const shown of ["team-proxy", "Responses", "codex/gpt-5.6-sol", "delivering"]) {
    expect(fields).toContain(shown);
  }
});

test("Activity detail: a wrapped provider failure leads with the provider's own reason", async () => {
  // How the SDK's schema check wraps the provider's error object.
  const wrapped = 'Type validation failed: Value: {"error":{"message":"litellm.APIError: '
    + 'Our servers are currently overloaded. Please try again later.","type":null,'
    + '"param":null,"code":"500"}}.\nError message: [\n  {\n    "code": "invalid_union"';
  mockFetch(() => Response.json({ call: { ...call("call-wrapped"), status: "failed", error: { message: wrapped } } }));
  await render(<CallDetailPanel callId="call-wrapped" onClose={() => {}} />);
  const reason = document.querySelector("[data-call-detail] [data-call-error]")?.textContent ?? "";
  expect(reason).toContain("Our servers are currently overloaded");
  expect(reason).not.toContain("Type validation failed");
});

test("Activity detail: a call no longer in the log says so, not as a red box", async () => {
  mockFetch(() => Response.json({ error: "not found" }, { status: 404 }));
  let closed = 0;
  await render(<CallDetailPanel callId="call-gone" onClose={() => { closed++; }} />);
  const panel = document.querySelector("[data-call-detail]")!;
  const state = panel.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Call not found");
  expect(state.textContent).toContain("It's no longer in the log.");
  expect(panel.querySelector('.text-destructive, [class*="bg-destructive/"]') === null).toBe(true);
  await act(async () => { [...state.querySelectorAll("button")].find((b) => b.textContent === "Close")!.click(); });
  expect(closed).toBe(1);
});

test("Activity detail: a call that fails to load says why and can retry", async () => {
  let reads = 0;
  mockFetch(() => {
    reads++;
    return reads === 1 ? Response.json({ error: "Activity unavailable" }, { status: 503 }) : Response.json({ call: call("call-detail") });
  });
  await render(<CallDetailPanel callId="call-detail" onClose={() => {}} />);
  const panel = document.querySelector("[data-call-detail]")!;
  const state = panel.querySelector('[data-slot="state-message"]')!;
  expect(state.querySelector("h2")!.textContent).toBe("Couldn't load this call");
  expect(state.textContent).toContain("Activity unavailable");
  await act(async () => { [...state.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click(); });
  await settle();
  expect(panel.querySelector('[data-slot="state-message"]') === null).toBe(true);
  expect(panel.querySelector("[data-call-fields]")).not.toBeNull();
});

test("Activity detail: loading is one quiet line, no spinner", async () => {
  mockFetch(() => new Promise<Response>(() => {}));
  await render(<CallDetailPanel callId="call-detail" onClose={() => {}} />);
  await settle();
  const line = document.querySelector('[data-call-detail] [data-slot="loading-line"]');
  expect(line?.textContent).toBe("Loading…");
  expect(document.querySelector("[data-call-detail] .animate-spin") === null).toBe(true);
});


test("an older page keeps the view's totals from the first", async () => {
  const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`));
  mockFetch(({ url }) => Response.json(url.includes("before=")
    ? { calls: [call("older")], totals: { calls: 999, extraMicros: 1 } }
    : { calls, totals: { calls: 21, extraMicros: 465_000_000 } }));
  const state = await mountList();
  await act(async () => { state().loadMore(); });
  expect(state().calls.length).toBe(21);
  expect(state().currentData?.totals).toEqual({ calls: 21, extraMicros: 465_000_000 });
});

test("Activity detail: a judgement's call opens with its answer card above the fields", async () => {
  mockFetch(() => Response.json({ call: {
    ...call("call-judged"), purpose: "manager_stop_check",
    metadata: { kind: "chat", judgement: { options: ["decision", "result", "nothing"], answer: "result", subject: { replySeq: 9, replyAt: "2026-08-03T11:40:00.000Z" } } }
  } }));
  await render(<CallDetailPanel callId="call-judged" onClose={() => {}} />);
  const card = document.querySelector("[data-call-detail] [data-call-judgement]");
  expect(card?.querySelector("[aria-current='true']")?.textContent).toBe("Has a result");
  // Above the fields, as the cache verdict is.
  expect(card!.compareDocumentPosition(document.querySelector("[data-call-detail] [data-call-fields]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("Activity detail: a panel kept open across midnight names yesterday's reply by its date", async () => {
  const zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = "UTC";
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-03T23:55:00.000Z"));
  try {
    mockFetch(() => Response.json({ call: {
      ...call("call-late"), purpose: "manager_stop_check",
      metadata: { judgement: { options: ["decision", "result", "nothing"], answer: "nothing", subject: { replySeq: 9, replyAt: "2026-08-03T23:50:00.000Z" } } }
    } }));
    // Mounted with nothing open; a call is opened the next morning.
    await render(<CallDetailPanel callId={null} onClose={() => {}} />);
    clock.mockReturnValue(Date.parse("2026-08-04T08:00:00.000Z"));
    await render(<CallDetailPanel callId="call-late" onClose={() => {}} />);
    expect(document.querySelector("[data-call-detail] [data-judgement-about]")?.textContent).toBe("About the reply at Aug 3 23:50");
  } finally {
    clock.mockRestore();
    process.env.TZ = zone;
  }
});
