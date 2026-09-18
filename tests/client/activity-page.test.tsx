import { afterEach, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import type { ActivityGroupKey, ActivitySummaryResponse } from "@shared/api-contracts";
import { getClientId, respondToUiSummaryRequest } from "@/lib/ui-context";
import { ActivityPage } from "@/routes/activity/ActivityPage";
import { activitySummaryCache } from "@/routes/activity/useActivitySummary";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Wiring only — happy-dom performs no layout, so nothing here may depend on a
 * measured box. What it does guard is the two places the Overview can be wrong
 * while still rendering: which bucket a percentile is pinned to, and whether a
 * zero percentile is presented as a measurement.
 */

const SUMMARY: ActivitySummaryResponse = {
  days: 30,
  daily: [
    { date: "2026-08-01", calls: 120, failed: 4, inputTokens: 9000, outputTokens: 300, cacheReadTokens: 8100, p50Ms: 800, p95Ms: 4000, p99Ms: 9000 },
    { date: "2026-08-03", calls: 60, failed: 0, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 900, p50Ms: 700, p95Ms: 3000, p99Ms: 8000 }
  ],
  // Deliberately unequal, and deliberately not in count order: a panel that
  // sorted or re-indexed them would pin the percentiles onto the wrong bar.
  buckets: [
    { bucket: "<1s", calls: 90 },
    { bucket: "1-5s", calls: 60 },
    { bucket: "5-15s", calls: 20 },
    { bucket: "15-60s", calls: 8 },
    { bucket: ">60s", calls: 2 }
  ],
  group: "model",
  groups: [
    {
      key: "openai-compatible / gpt-5.6-sol",
      label: "openai-compatible / gpt-5.6-sol",
      calls: 120,
      failed: 4,
      p50Ms: 900,
      p95Ms: 4200,
      p99Ms: 12_000,
      maxMs: 30_000,
      inputTokens: 9000,
      outputTokens: 300,
      cacheReadTokens: 8100,
      fallbackCalls: 0,
      reasons: [{ reason: "Not Found", calls: 4 }]
    },
    {
      key: "codex / gpt-5.5",
      label: "codex / gpt-5.5",
      calls: 60,
      failed: 0,
      p50Ms: 700,
      p95Ms: 3000,
      p99Ms: 8000,
      maxMs: 9000,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 900,
      fallbackCalls: 60,
      reasons: []
    }
  ],
  p50Ms: 900,
  p95Ms: 4200,
  p99Ms: 61_000,
  ttft: { calls: 140, p50Ms: 320, p95Ms: 980, p99Ms: 2100 }
};

/** The same window cut by purpose, which is the one dimension whose keys the
 *  log cannot always express: a call written with no purpose lands in the
 *  endpoint's "(none)" bucket, and there is no `purpose=` value that means
 *  "the ones without one". */
const PURPOSE_SUMMARY: ActivitySummaryResponse = {
  ...SUMMARY,
  group: "purpose",
  groups: [
    {
      key: "memory_dream",
      label: "memory_dream",
      calls: 120,
      failed: 4,
      p50Ms: 900,
      p95Ms: 4200,
      p99Ms: 12_000,
      maxMs: 30_000,
      inputTokens: 9000,
      outputTokens: 300,
      cacheReadTokens: 8100,
      fallbackCalls: 0,
      reasons: [{ reason: "Not Found", calls: 4 }]
    },
    {
      key: "(none)",
      label: "(none)",
      calls: 60,
      failed: 0,
      p50Ms: 700,
      p95Ms: 3000,
      p99Ms: 8000,
      maxMs: 9000,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 900,
      fallbackCalls: 0,
      reasons: []
    }
  ]
};

/** Relative to the clock, because the row reads its timestamp against the
 *  moment the list loaded. 17½ minutes back so it renders "17m ago" for the
 *  whole of a run rather than turning over mid-file. */
const CREATED_AT = new Date(Date.now() - 17.5 * 60_000).toISOString();

const CALLS = [
  {
    id: "llm_a",
    purpose: "memory_dream",
    scopeType: "memory",
    scopeId: "dream-1",
    parentCallId: null,
    provider: "openai-compatible",
    model: "codex/gpt-5.6-sol",
    baseURL: null,
    apiMode: null,
    requestHash: "req",
    responseHash: "res",
    metadata: null,
    inputTokens: 50_284,
    outputTokens: 284,
    totalTokens: 50_568,
    reasoningTokens: null,
    cacheReadTokens: 40_913,
    cacheWriteTokens: null,
    status: "failed",
    // The shape the list endpoint really answers with — an object, not a
    // string. Its message is the Zod wrapper this failure shape records,
    // with the provider's own sentence nested inside.
    error: {
      name: "AI_TypeValidationError",
      message:
        'Type validation failed: Value: {"error":{"message":"Our servers are currently overloaded.","code":500}}'
    },
    startedAt: CREATED_AT,
    finishedAt: new Date(Date.parse(CREATED_AT) + 17_850).toISOString(),
    latencyMs: 17_850,
    createdAt: CREATED_AT,
    updatedAt: new Date(Date.parse(CREATED_AT) + 17_850).toISOString()
  }
];

let root: Root | null = null;
let container: HTMLElement | null = null;
let currentSearch = "";
let requestedUrls: string[] = [];
let postedBodies: Array<{ url: string; body: string }> = [];
let originalFetch: typeof fetch | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  // Restored here rather than at the end of the render helper: a click that
  // moves the page to another tab starts a fetch, and with the real `fetch`
  // back in place that request goes to a relative URL and throws.
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
  root = null;
  container = null;
  requestedUrls = [];
  postedBodies = [];
  activitySummaryCache.clear();
});

function LocationProbe() {
  currentSearch = useLocation().search;
  return null;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * The answer for a url, and nothing about when it arrives.
 */
function bodyFor(url: string, summary: ActivitySummaryResponse): unknown {
  if (url.includes("/api/activity/summary")) return summary;
  if (url.includes("/api/activity/calls")) return { calls: CALLS };
  return { ok: true };
}

async function renderPage(
  summary: ActivitySummaryResponse = SUMMARY,
  entry = "/activity",
  { strict = false }: { strict?: boolean } = {}
): Promise<HTMLElement> {
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(url);
    if (typeof init?.body === "string") postedBodies.push({ url, body: init.body });
    const body = bodyFor(url, summary);
    return new Promise<Response>((resolve, reject) => {
      // A response is never delivered to a caller that gave up: the real fetch
      // rejects on an aborted signal. A mock that resolved anyway counted an
      // abandoned request as a delivered one, which made the whole class of
      // "the cleanup ran and then the setup ran again" — StrictMode's double
      // mount, a superseded re-group — invisible to every test in this file.
      const fail = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (init?.signal?.aborted) return fail();
      init?.signal?.addEventListener("abort", fail, { once: true });
      // On a microtask, never in the calling tick: a response that lands before
      // the effect cleanup that abandons it can run is one no real network
      // could produce, and it is exactly the ordering these tests exist to
      // measure.
      queueMicrotask(() => {
        resolve(new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" }
        }));
      });
    });
  }) as typeof fetch;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // The page portals its header-band actions into the shell's slot; the slot
  // is mounted here so those actions land inside the container the tests query.
  const tree = (
    <MemoryRouter initialEntries={[entry]}>
      <LocationProbe />
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <ActivityPage />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await act(async () => {
    root?.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  await settle();
  return container;
}

const callRequests = () => requestedUrls.filter((url) => url.includes("/api/activity/calls"));

/**
 * What the agent would actually be handed, taken down the path it really uses:
 * a summary request comes in over SSE, `ui-context` asks whichever provider is
 * registered, and POSTs the answer back. Reading the registry directly would
 * not exercise `lastSummaryProvider`, which is where a stale registration from
 * the other tab would show up.
 */
async function publishedSummary(): Promise<Record<string, unknown>> {
  await act(async () => {
    await respondToUiSummaryRequest({
      requestId: "req-1",
      clientId: getClientId(),
      timeoutMs: 5_000
    });
  });
  const posted = postedBodies.filter((entry) => entry.url.includes("/api/ui/page-summary")).at(-1);
  const payload = JSON.parse(posted?.body ?? "{}") as {
    summary?: { summary?: Record<string, unknown> };
  };
  return payload.summary?.summary ?? {};
}

async function clickTab(page: HTMLElement, label: string): Promise<void> {
  const tab = [...page.querySelectorAll('[role="tab"]')].find(
    (node) => node.textContent === label
  );
  await act(async () => {
    tab?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

const summaryRequests = () => requestedUrls.filter((url) => url.includes("/api/activity/summary"));

/** The grouping each summary request asked for, in order. Counted rather than
 *  merely checked for presence: a page that re-asks on every tab switch has the
 *  right answer on screen at both ends of a round trip and is still refetching
 *  what it already holds. */
const requestedGroups = () =>
  summaryRequests().map((url) => new URLSearchParams(url.split("?")[1] ?? "").get("group"));

/** The grouping selector, not the table: on a purpose breakdown a row's own
 *  label can read the same as a group option's. `aria-pressed` is only on the
 *  selector. */
async function clickGroup(page: HTMLElement, label: string): Promise<void> {
  const button = [...page.querySelectorAll("button[aria-pressed]")].find(
    (node) => node.textContent === label
  ) as HTMLElement | undefined;
  if (!button) throw new Error(`no grouping button labelled ${label}`);
  await act(async () => {
    button.click();
  });
  await settle();
}

async function clickBreakdownRow(page: HTMLElement, label: string): Promise<void> {
  const button = [...page.querySelectorAll("tbody button")].find(
    (node) => node.textContent === label
  ) as HTMLElement | undefined;
  if (!button) throw new Error(`no breakdown row labelled ${label}`);
  await act(async () => {
    button.click();
  });
  await settle();
}

test("activity opens on Overview, with Breakdown and Logs a tab away", async () => {
  const page = await renderPage();
  const tabs = [...page.querySelectorAll('[role="tab"]')];
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Overview", "Breakdown", "Logs"]);
  expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
});

test("breakdown is a tab of its own, reached by the url", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
  expect(page.querySelector("#activity-panel-breakdown")).not.toBeNull();
  const selected = [...page.querySelectorAll('[role="tab"]')].find(
    (node) => node.getAttribute("aria-selected") === "true"
  );
  expect(selected?.textContent).toBe("Breakdown");
  // The panel is the table, not an empty shell: the tab has to be wired to the
  // summary the page already holds.
  expect([...page.querySelectorAll("tbody button")].map((node) => node.textContent)).toEqual([
    "openai-compatible / gpt-5.6-sol",
    "codex / gpt-5.5"
  ]);
});

test("the grouping in the url is the one the endpoint is asked for", async () => {
  // Not merely "a request went out": the grouping the url asked for has to be
  // the one the endpoint is asked for, or the page renders someone else's
  // answer under the heading it chose.
  await renderPage(PURPOSE_SUMMARY, "/activity?tab=breakdown&group=purpose");
  expect(summaryRequests().length).toBe(1);
  expect(summaryRequests()[0]).toContain("group=purpose");
});

test("switching the grouping asks the endpoint again, at the new grouping", async () => {
  // The url alone is not enough. Re-grouping is a different query, so the
  // request has to be re-issued — a hook that read the grouping once at mount
  // would keep answering with the first cut under the second one's name.
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
  expect(summaryRequests().length).toBe(1);
  // provider / model is the landing cut, so a url with no grouping still asks
  // the endpoint for one.
  expect(summaryRequests()[0]).toContain("group=model");

  await clickGroup(page, "purpose");
  expect(summaryRequests().length).toBe(2);
  expect(summaryRequests()[1]).toContain("group=purpose");
});

test("choosing a grouping rewrites the url rather than only the table", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
  await clickGroup(page, "purpose");
  // A grouping held only in component state cannot be linked to or reloaded.
  expect(new URLSearchParams(currentSearch).get("group")).toBe("purpose");
  expect(new URLSearchParams(currentSearch).get("tab")).toBe("breakdown");
});

test("the default grouping carries no parameter", async () => {
  const page = await renderPage(PURPOSE_SUMMARY, "/activity?tab=breakdown&group=purpose");
  await clickGroup(page, "provider / model");
  // Matches url-params' convention: the default is the absence of the value.
  expect(currentSearch).not.toContain("group");
  expect(new URLSearchParams(currentSearch).get("tab")).toBe("breakdown");
});

test("a breakdown row opens the log filtered to that group", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
  await clickBreakdownRow(page, "openai-compatible / gpt-5.6-sol");

  const params = new URLSearchParams(currentSearch);
  expect(params.get("tab")).toBe("logs");
  expect(params.get("provider")).toBe("openai-compatible");
  expect(params.get("model")).toBe("gpt-5.6-sol");
  expect(page.querySelector('[role="tabpanel"]')?.id).toBe("activity-panel-logs");
  // The url and the query are two separate claims; this is the one the reader
  // sees.
  const requested = callRequests().at(-1) ?? "";
  expect(requested).toContain("provider=openai-compatible");
  expect(requested).toContain("model=gpt-5.6-sol");
});

test("a breakdown row replaces the log's filters rather than adding to them", async () => {
  // The reader arrives on the breakdown with a filter already set from the log.
  // A row is a whole question, so what it opens is that group — not that group
  // narrowed by whatever the last visit left behind.
  //
  // Every filter the log can hold, not only the two the log's own bar sets:
  // a `day` or a `scopeType` left behind by an earlier row is invisible on the
  // way through the breakdown and silently narrows the answer this row promised.
  const page = await renderPage(
    SUMMARY,
    "/activity?tab=breakdown&purpose=memory_dream&status=failed" +
      "&scopeType=memory&day=2026-08-01&fallback=1&q=llm_abc"
  );
  await clickBreakdownRow(page, "codex / gpt-5.5");

  const params = new URLSearchParams(currentSearch);
  expect(params.get("provider")).toBe("codex");
  expect([...params.keys()].filter((key) => key !== "tab" && key !== "provider" && key !== "model"))
    .toEqual([]);
});

/**
 * The three dimensions with no control on the log at all: their only route in
 * is a breakdown row, and their only route out is the chip.
 *
 * One test per dimension, because each is a separate case in `logFilterFor`, a
 * separate key on the query the hook builds, and a separate `query.set` in the
 * path builder — a single case passing says nothing about its neighbours. The
 * fixtures give each row a label its key would not survive being read as, so a
 * row that filtered by what it displays rather than by what it is fails here
 * rather than at the endpoint.
 */
const LINKED_ROWS: Array<{
  name: string;
  group: ActivityGroupKey;
  key: string;
  label: string;
  param: string;
  value: string;
}> = [
  { name: "a scope type", group: "scopeType", key: "memory", label: "memory (scope)", param: "scopeType", value: "memory" },
  { name: "a day", group: "day", key: "2026-08-01", label: "Aug 1", param: "day", value: "2026-08-01" },
  // Both halves: "primary" is a filter of its own, not the absence of one, and
  // it is the half a presence-shaped implementation gets wrong.
  { name: "the fallback calls", group: "fallback", key: "fallback", label: "Fallback attempts", param: "fallback", value: "1" },
  { name: "the primary calls", group: "fallback", key: "primary", label: "First attempts", param: "fallback", value: "0" }
];

for (const linked of LINKED_ROWS) {
  test(`a row for ${linked.name} opens the log filtered to it`, async () => {
    const page = await renderPage(
      {
        ...SUMMARY,
        group: linked.group,
        groups: [{ ...SUMMARY.groups[0]!, key: linked.key, label: linked.label }]
      },
      `/activity?tab=breakdown&group=${linked.group}`
    );
    await clickBreakdownRow(page, linked.label);

    const params = new URLSearchParams(currentSearch);
    expect(params.get("tab")).toBe("logs");
    expect(params.get(linked.param)).toBe(linked.value);
    // The url and the request are two separate claims, and this is the one the
    // reader sees: a filter the hook does not carry reaches the url and stops
    // there, leaving a filtered heading over an unfiltered list.
    expect(callRequests().at(-1) ?? "").toContain(`${linked.param}=${linked.value}`);
  });
}

test("the log says which filters it is showing, including the ones it cannot set", async () => {
  // The bar has no control for these, so the chip is the whole of their
  // interface — and `Clear` only appears when at least one filter is showing.
  // Without them the list is filtered and the page says it is not.
  const page = await renderPage(SUMMARY, "/activity?tab=logs&scopeType=memory&day=2026-08-01&fallback=0");
  const chips = [...page.querySelectorAll("button")]
    .map((node) => node.textContent ?? "")
    .filter((text) => /^(scope|day|attempt):/.test(text));
  expect(chips).toEqual(["scope: memory", "day: 2026-08-01", "attempt: primary"]);
});

test("a fallback value the log cannot filter on is not reported as one", async () => {
  // The server applies a clause for "1" and for "0" and none at all otherwise,
  // so a hand-edited or stale `?fallback=` leaves the list unfiltered. Read
  // raw, every statement the page made about it was wrong in the same
  // direction — and the chip's was the opposite of the truth, since "attempt:
  // primary" is exactly the half of the cut this list is not.
  const page = await renderPage(SUMMARY, "/activity?tab=logs&fallback=maybe");
  const chips = [...page.querySelectorAll("button")]
    .map((node) => node.textContent ?? "")
    .filter((text) => /^attempt:/.test(text));
  expect(chips).toEqual([]);
  // The other two statements, which the chip fix alone would have left lying:
  // what the agent is told, and what was actually asked for.
  expect((await publishedSummary()).filters).toMatchObject({ fallback: null });
  expect(callRequests().at(-1) ?? "").not.toContain("fallback");
});

test("removing one linked filter leaves the others alone", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=logs&scopeType=memory&day=2026-08-01");
  const chip = [...page.querySelectorAll("button")].find(
    (node) => node.textContent === "day: 2026-08-01"
  );
  await act(async () => {
    chip?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settle();

  const params = new URLSearchParams(currentSearch);
  expect(params.get("day")).toBeNull();
  expect(params.get("scopeType")).toBe("memory");
});

test("Clear takes the linked filters with it", async () => {
  // The one control that removes filters wholesale. Leaving these three behind
  // empties the bar the reader can see and keeps the list narrowed by the ones
  // they cannot.
  const page = await renderPage(
    SUMMARY,
    "/activity?tab=logs&status=failed&purpose=memory_dream&scopeType=memory&day=2026-08-01&fallback=1"
  );
  const clear = [...page.querySelectorAll("button")].find((node) => node.textContent === "Clear");
  await act(async () => {
    clear?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settle();

  expect([...new URLSearchParams(currentSearch).keys()]).toEqual(["tab"]);
});

test("narrowing by purpose keeps the scope the reader arrived with", async () => {
  // `setTextFilters` used to delete `scopeType` outright, from when the log
  // could not answer it. It can now, and a filter that vanished because the
  // reader touched an unrelated dropdown widens the list without saying so.
  const page = await renderPage(SUMMARY, "/activity?tab=logs&scopeType=memory");
  const select = [...page.querySelectorAll("select")].find((node) =>
    [...node.options].some((option) => option.value === "memory_dream")
  );
  await act(async () => {
    select!.value = "memory_dream";
    select!.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await settle();

  const params = new URLSearchParams(currentSearch);
  expect(params.get("purpose")).toBe("memory_dream");
  expect(params.get("scopeType")).toBe("memory");
  expect(callRequests().at(-1) ?? "").toContain("scopeType=memory");
});

test("opening the log keeps the grouping the reader came from", async () => {
  // `group` is not one of the log's filters — it is where the back button goes.
  const page = await renderPage(PURPOSE_SUMMARY, "/activity?tab=breakdown&group=purpose");
  await clickBreakdownRow(page, "memory_dream");

  const params = new URLSearchParams(currentSearch);
  expect(params.get("tab")).toBe("logs");
  expect(params.get("purpose")).toBe("memory_dream");
  expect(params.get("group")).toBe("purpose");
});

test("a group the log cannot express does not open the log at all", async () => {
  // "(none)" is calls written with no purpose. There is no filter that means
  // that, so the alternative to doing nothing is jumping to an unfiltered log
  // — a screen that answers a question the reader did not ask.
  const page = await renderPage(PURPOSE_SUMMARY, "/activity?tab=breakdown&group=purpose");
  const before = currentSearch;
  await clickBreakdownRow(page, "(none)");

  expect(currentSearch).toBe(before);
  expect(page.querySelector('[role="tabpanel"]')?.id).toBe("activity-panel-breakdown");
  expect(callRequests().length).toBe(0);
});

test("a slow regrouping leaves the heading on the answer still in view", async () => {
  // The table names the dimension the response was built from. Between the
  // click and the answer the two disagree, and naming the requested one puts
  // the previous cut's rows under the new cut's heading.
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
  expect(page.querySelector("th")?.textContent).toBe("Provider / model");

  // The regrouped answer never lands. Rejecting on abort the way the real fetch
  // does, so an aborted request cannot settle onto the page either.
  globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const fail = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (init?.signal?.aborted) return fail();
      init?.signal?.addEventListener("abort", fail, { once: true });
    })) as typeof fetch;

  await clickGroup(page, "purpose");

  // The click landed — without this the heading below is unchanged for the
  // wrong reason.
  expect(new URLSearchParams(currentSearch).get("group")).toBe("purpose");
  expect(page.querySelector("th")?.textContent).toBe("Provider / model");
  // The two halves answer different questions, and in this window they differ:
  // the selector says what the reader asked for, the heading says what is on
  // the screen.
  // Scoped to the grouping row: the header carries a second pressed-button
  // group for the window, and an unscoped search finds whichever comes first
  // in the document.
  const pressed = [
    ...page.querySelectorAll('[aria-label="Group by"] button[aria-pressed]')
  ].find((node) => node.getAttribute("aria-pressed") === "true");
  expect(pressed?.textContent).toBe("purpose");
});

test("a percentile is pinned to the bucket it falls in", async () => {
  const page = await renderPage();
  const bucketText = (bucket: string) =>
    page.querySelector(`[data-latency-bucket="${bucket}"]`)?.textContent ?? "";
  // p50 900ms and p95 4.2s share the two fastest buckets; p99 is 61s, which is
  // over the last edge and belongs on the overflow bar, not the 15-60s one.
  expect(bucketText("<1s")).toContain("p50");
  expect(bucketText("1-5s")).toContain("p95");
  expect(bucketText("15-60s")).not.toContain("p99");
  expect(bucketText(">60s")).toContain("p99");
});

test("a window that measured nothing pins no percentile at all", async () => {
  // The endpoint answers 0 for a window whose calls all recorded a null
  // latency. Pinned, that would put p50/p95/p99 on the "<1s" bar and claim the
  // whole install answers in under a second.
  const page = await renderPage({
    ...SUMMARY,
    buckets: SUMMARY.buckets.map((bucket) => ({ ...bucket, calls: 0 })),
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    ttft: { calls: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 }
  });
  // Named by bucket rather than by node: a failed `toEqual` over DOM elements
  // serialises the whole tree and never comes back.
  const pinned = [...page.querySelectorAll("[data-latency-bucket]")]
    .filter((row) => /p50|p95|p99/.test(row.textContent ?? ""))
    .map((row) => row.getAttribute("data-latency-bucket"));
  expect(pinned).toEqual([]);
});

test("the overview asks for the purpose cut, whatever grouping the url holds", async () => {
  // The page holds one summary and the Overview's table is the purpose cut, so
  // that is the request while this tab is showing. The grouping the reader
  // picked is not overwritten — it waits in the url for their return.
  const page = await renderPage(PURPOSE_SUMMARY, "/activity?group=day");
  expect(summaryRequests().length).toBe(1);
  expect(summaryRequests()[0]).toContain("group=purpose");
  expect(new URLSearchParams(currentSearch).get("group")).toBe("day");
  // Drawn from the answer that came back, in the order it came back in.
  expect([...page.querySelectorAll("tbody button")].map((node) => node.textContent)).toEqual([
    "memory_dream",
    "(none)"
  ]);

  await clickTab(page, "Breakdown");
  expect(summaryRequests().length).toBe(2);
  expect(summaryRequests()[1]).toContain("group=day");
});

test("the dev double-mount lands on a table, not on a skeleton", async () => {
  // `main.tsx` wraps the app in StrictMode, so this is how the page really
  // mounts in dev: every effect set up, torn down, and set up again. Getting
  // that wrong does not show as a missing request — it shows as a page that
  // never leaves its skeleton, with the Refresh button that would rescue it
  // disabled by the same `loading` that is stuck.
  const page = await renderPage(PURPOSE_SUMMARY, "/activity", { strict: true });
  expect([...page.querySelectorAll("tbody button")].map((node) => node.textContent)).toEqual([
    "memory_dream",
    "(none)"
  ]);
});

test("the dev double-mount does not leave Refresh disabled with nothing to wait for", async () => {
  // The other half, and the one that makes the first unrecoverable: `busy` is
  // the summary's own `loading`, so a request that was abandoned and never
  // replaced disables the one control that would ask for it again. Asserted
  // apart from the table above so each symptom is its own failure.
  const page = await renderPage(PURPOSE_SUMMARY, "/activity", { strict: true });
  const refresh = [...page.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label")?.startsWith("Refresh") ?? false
  ) as HTMLButtonElement | undefined;
  expect(refresh?.getAttribute("aria-label")).toBe("Refresh");
  expect(refresh?.disabled).toBe(false);
});

test("passing through the log does not re-ask for the summary on the way back", async () => {
  // The log reads no summary at all — `LogsTab` is handed a refresh token and
  // nothing else. A grouping that moves on the way in fetches an answer nobody
  // looks at, and moves back on the way out to fetch the one already on the
  // page; while that second answer is in flight `data.group` is the other cut,
  // so the Overview's table vanishes and pops back on every return.
  const page = await renderPage(PURPOSE_SUMMARY, "/activity");
  expect(requestedGroups()).toEqual(["purpose"]);

  await clickTab(page, "Logs");
  await clickTab(page, "Overview");
  expect(requestedGroups()).toEqual(["purpose"]);
  // The same answer throughout, so the table never left.
  expect([...page.querySelectorAll("tbody button")].map((node) => node.textContent)).toEqual([
    "memory_dream",
    "(none)"
  ]);
});

test("the breakdown's own cut survives the same round trip", async () => {
  // The neighbouring pair, and the one that a fix aimed only at the Overview
  // breaks: pinning the request to `purpose` everywhere but the Breakdown tab
  // makes this trip cost two requests where it costs none.
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
  expect(requestedGroups()).toEqual(["model"]);

  await clickTab(page, "Logs");
  await clickTab(page, "Breakdown");
  expect(requestedGroups()).toEqual(["model"]);
  expect(page.querySelector("th")?.textContent).toBe("Provider / model");
});

test("moving between summary tabs fetches each cut once and reuses it on return", async () => {
  const page = await renderPage(SUMMARY, "/activity");
  await clickTab(page, "Breakdown");
  await clickTab(page, "Overview");
  expect(requestedGroups()).toEqual(["purpose", "model"]);
});

test("an overview row opens the log filtered to that purpose", async () => {
  // The Overview's rows are purposes however the url is grouped, so the filter
  // has to be resolved through the cut the rows were drawn from. Read against
  // the url's own grouping — `model` here — because resolving "memory_dream"
  // as a provider/model name yields no filter at all and the row goes dead.
  const page = await renderPage(PURPOSE_SUMMARY, "/activity?group=model");
  await clickBreakdownRow(page, "memory_dream");

  const params = new URLSearchParams(currentSearch);
  expect(params.get("tab")).toBe("logs");
  expect(params.get("purpose")).toBe("memory_dream");
  expect(page.querySelector('[role="tabpanel"]')?.id).toBe("activity-panel-logs");
  // The url and the query are two separate claims; this is the one the reader
  // sees.
  expect(callRequests().at(-1) ?? "").toContain("purpose=memory_dream");
});

test("the log's query does not run while the reader is on the overview", async () => {
  // The list fetch used to sit on the page, so opening Activity asked for
  // twenty rows nobody was looking at. It belongs to the tab that shows them.
  await renderPage();
  expect(callRequests().length).toBe(0);
  expect(requestedUrls.filter((url) => url.includes("/api/activity/summary")).length).toBe(1);
});

test("the log tab asks for its own rows and renders them", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=logs");
  expect(callRequests().length).toBe(1);
  expect(page.querySelectorAll("[data-log-purpose]").length).toBe(1);
  expect(page.querySelector("[data-log-purpose]")?.textContent).toBe("memory_dream");
});

test("log readings carry their labels without a separate column header", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=logs");
  expect(page.querySelector("[data-log-model]")?.textContent).toBe("codex/gpt-5.6-sol");
  expect(page.querySelector("[data-log-tokens]")?.textContent).toBe("50.3k → 284 tokens");
  expect(page.querySelector("[data-log-rate]")?.textContent).toBe("15.9 tok/s");
  expect(page.querySelector("[data-log-cache]")?.textContent).toBe("81% cache");
  expect(page.querySelector("[data-log-duration]")?.textContent).toBe("18s");
  expect(page.querySelector("[data-log-status]")?.textContent).toBe("failed");
});

test("on the overview the agent is handed the aggregate, not a list of rows", async () => {
  await renderPage(PURPOSE_SUMMARY);
  const summary = await publishedSummary();
  expect(summary.tab).toBe("overview");
  expect(summary.windowDays).toBe(30);
  // Which cut, not only the rows: "the top group is memory" answers one
  // question under purpose and a different one under scope type.
  expect(summary.group).toBe("purpose");
  expect((summary.groups as Array<{ key: string }>).map((g) => g.key)).toEqual([
    "memory_dream",
    "(none)"
  ]);
  // Describing twenty call rows to someone looking at a chart is describing
  // the wrong screen.
  expect(summary.recentCalls).toBeUndefined();
  expect(summary.filters).toBeUndefined();
});

test("on the breakdown the agent is handed the cut it is reading, named", async () => {
  // Every summary provider in the app is registered by a route, and this tab is
  // not one: on `?tab=breakdown` the registry was empty, so an agent asking what
  // the reader was looking at got a location and no content at all.
  //
  // The grouping is half the answer. "The top group is codex / gpt-5.5" is a
  // provider/model under this cut and would be a scope type under another, and
  // the rows alone do not say which.
  await renderPage(SUMMARY, "/activity?tab=breakdown");
  const summary = await publishedSummary();
  expect(summary.tab).toBe("breakdown");
  expect(summary.group).toBe("model");
  expect((summary.groups as Array<{ key: string }>).map((g) => g.key)).toEqual([
    "openai-compatible / gpt-5.6-sol",
    "codex / gpt-5.5"
  ]);
  // The table is the whole tab: twenty call rows and a set of log filters
  // describe a screen nobody is on.
  expect(summary.recentCalls).toBeUndefined();
  expect(summary.filters).toBeUndefined();
});

test("the agent is told which cut is on screen, not which one was asked for", async () => {
  // Moving to the Overview asks for the purpose cut, and until that answer
  // lands the rows still on screen are the ones the reader was already reading.
  // Naming them purposes would tell the agent that `codex / gpt-5.5` is
  // something this install does — a plausible sentence about nothing.
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
  // The answer in hand is the model cut. Read off the heading, which is what
  // the reader sees; the description the Breakdown publishes is asserted on its
  // own above, and the question here is what the *Overview* says on arrival.
  expect(page.querySelector("th")?.textContent).toBe("Provider / model");

  // The purpose request never answers. Rejecting on abort the way the real
  // fetch does, and leaving every other request on the recording mock so the
  // summary the agent is handed still gets posted.
  const recording = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("/api/activity/summary")) return recording(input, init);
    return new Promise((_resolve, reject) => {
      const fail = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (init?.signal?.aborted) return fail();
      init?.signal?.addEventListener("abort", fail, { once: true });
    });
  }) as typeof fetch;

  await clickTab(page, "Overview");
  const summary = await publishedSummary();
  expect(summary.tab).toBe("overview");
  expect(summary.group).toBe("model");
  expect((summary.groups as Array<{ key: string }>).map((g) => g.key)).toEqual([
    "openai-compatible / gpt-5.6-sol",
    "codex / gpt-5.5"
  ]);
});

test("the agent is handed every filter the list was fetched under", async () => {
  // The whole object, key by key. The three linked filters have to be added in
  // two places — the hook's input and the summary it builds — and nothing was
  // checking the second: deleting `day` there left an agent told the list was
  // unfiltered while it held one day of it, which is the exact failure these
  // fields exist to prevent. Eight distinct values, so a key reading its
  // neighbour's value fails too.
  await renderPage(
    SUMMARY,
    "/activity?tab=logs&status=failed&purpose=memory_dream&provider=codex&model=gpt-5.5" +
      "&scopeType=memory&day=2026-08-01&fallback=1&q=llm_abc"
  );
  expect((await publishedSummary()).filters).toEqual({
    status: "failed",
    purpose: "memory_dream",
    provider: "codex",
    model: "gpt-5.5",
    scopeType: "memory",
    day: "2026-08-01",
    fallback: "1",
    q: "llm_abc"
  });
});

test("on the logs tab the agent is handed the rows and the filters", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=logs&purpose=memory_dream");
  const summary = await publishedSummary();
  expect(summary.tab).toBe("logs");
  expect((summary.filters as { purpose: string }).purpose).toBe("memory_dream");
  expect(summary.loadedCallCount).toBe(1);
  expect((summary.recentCalls as Array<{ id: string }>).map((c) => c.id)).toEqual(["llm_a"]);
  // The 30-day aggregate answers a question nobody on this tab asked.
  expect(summary.groups).toBeUndefined();
  expect(summary.openCallId).toBeNull();

  await act(async () => {
    page
      .querySelector("[data-log-row]")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settle();
  expect((await publishedSummary()).openCallId).toBe("llm_a");
});

test("a failed call is described to the agent by its reason, not as an object", async () => {
  // `error` arrives as `{name, message}`. Handed to `String()` it becomes
  // "[object Object]" — a summary that tells the agent a call failed and
  // nothing about why. Read the same way as the panel and the Overview: the
  // provider's sentence out of the Zod wrapper, with its code.
  const page = await renderPage(SUMMARY, "/activity?tab=logs");
  const REASON = "Our servers are currently overloaded. (500)";

  const listed = (await publishedSummary()).recentCalls as Array<{ error: string | null }>;
  expect(listed.map((call) => call.error)).toEqual([REASON]);

  await act(async () => {
    page
      .querySelector("[data-log-row]")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settle();
  expect((await publishedSummary()).openCall).toMatchObject({ id: "llm_a", error: REASON });
});

test("switching tabs replaces the description instead of leaving both behind", async () => {
  // The registry answers with the last provider still registered and its
  // cleanup deletes by key, so a tab that failed to unregister would keep
  // answering for a screen nobody is looking at. Round trip, because a stale
  // entry only overtakes the live one on the way back.
  const page = await renderPage();
  expect((await publishedSummary()).tab).toBe("overview");

  await clickTab(page, "Logs");
  expect((await publishedSummary()).tab).toBe("logs");

  await clickTab(page, "Overview");
  expect((await publishedSummary()).tab).toBe("overview");

  // Three keys now, and the registry answers with the last one still
  // registered: a third provider is a third chance for a departing tab's entry
  // to be the one left standing.
  await clickTab(page, "Breakdown");
  expect((await publishedSummary()).tab).toBe("breakdown");

  await clickTab(page, "Overview");
  expect((await publishedSummary()).tab).toBe("overview");
});

test("refreshing the breakdown re-asks for the summary it is drawn from", async () => {
  // Breakdown reads the same response the Overview does, so Refresh here is the
  // summary request — not the log's, which has no list on screen to reload.
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
  const before = requestedUrls.length;
  const refresh = [...page.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Refresh"
  );
  await act(async () => {
    refresh?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settle();

  const since = requestedUrls.slice(before);
  expect(since.filter((url) => url.includes("/api/activity/summary")).length).toBe(1);
  expect(since.filter((url) => url.includes("/api/activity/calls")).length).toBe(0);
});

test("the refresh button asks the tab that is showing, and only that tab", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=logs");
  const before = requestedUrls.length;
  const refresh = [...page.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Refresh"
  );
  await act(async () => {
    refresh?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settle();

  const since = requestedUrls.slice(before);
  expect(since.filter((url) => url.includes("/api/activity/calls")).length).toBe(1);
  expect(since.filter((url) => url.includes("/api/activity/summary")).length).toBe(0);
});

/** The pressed button inside a named group, so the page's two pressed-button
 *  rows cannot be confused for each other. */
function pressedIn(page: HTMLElement, label: string): string | undefined {
  return [...page.querySelectorAll(`[aria-label="${label}"] button[aria-pressed]`)]
    .find((node) => node.getAttribute("aria-pressed") === "true")?.textContent ?? undefined;
}

test("the window reaches the endpoint the reader asked it of", async () => {
  await renderPage(SUMMARY, "/activity?days=7");
  // Not merely "a request went out": the span the url names has to be the span
  // the endpoint is asked for, or every figure on the page describes a window
  // the reader did not choose.
  expect(requestedUrls.some((url) => url.includes("days=7"))).toBe(true);
  expect(requestedUrls.some((url) => url.includes("days=30"))).toBe(false);
});

test("choosing a window rewrites the url and re-asks", async () => {
  const page = await renderPage(SUMMARY, "/activity");
  const before = requestedUrls.length;
  await act(async () => {
    [...page.querySelectorAll("button")].find((node) => node.textContent === "24h")!.click();
  });
  // A window held only in component state cannot be linked to or reloaded, and
  // a url that moved without a request leaves the page on the old span.
  expect(new URLSearchParams(currentSearch).get("days")).toBe("1");
  expect(requestedUrls.slice(before).some((url) => url.includes("days=1"))).toBe(true);
});

test("the default window carries no parameter", async () => {
  const page = await renderPage(SUMMARY, "/activity?days=7");
  await act(async () => {
    [...page.querySelectorAll("button")].find((node) => node.textContent === "30d")!.click();
  });
  // Matches url-params' convention, the same one `tab` and `group` follow.
  expect(new URLSearchParams(currentSearch).get("days")).toBeNull();
});

test("a window the page cannot offer falls back to the default", async () => {
  await renderPage(SUMMARY, "/activity?days=53");
  // The endpoint would clamp 53 into range and answer it, leaving the reader on
  // a span no control can express or clear. The page only honours the spans it
  // can show pressed.
  expect(requestedUrls.some((url) => url.includes("days=30"))).toBe(true);
  expect(requestedUrls.some((url) => url.includes("days=53"))).toBe(false);
});

test("the window survives a trip through the log and back", async () => {
  const page = await renderPage(SUMMARY, "/activity?days=7");
  const before = requestedUrls.length;
  await act(async () => {
    [...page.querySelectorAll<HTMLElement>('[role="tab"]')].find((n) => n.textContent === "Logs")!.click();
  });
  await act(async () => {
    [...page.querySelectorAll<HTMLElement>('[role="tab"]')].find((n) => n.textContent === "Overview")!.click();
  });
  // The log asks for nothing *of the summary* — it does fetch its own list —
  // so the answer already in hand is the one the Overview returns to. No
  // second trip, and still the reader's span.
  expect(requestedUrls.slice(before).filter((url) => url.includes("/summary"))).toEqual([]);
  expect(new URLSearchParams(currentSearch).get("days")).toBe("7");
});

test("the window and the grouping are two independent choices", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown&days=7&group=purpose");
  // Both pressed at once, each in its own named group — the regression a single
  // shared `asked` key would produce is one of them silently reverting.
  expect(pressedIn(page, "Window")).toBe("7d");
  expect(pressedIn(page, "Group by")).toBe("purpose");
  expect(requestedUrls.some((url) => url.includes("days=7") && url.includes("group=purpose")))
    .toBe(true);
});

test("the header band holds the window group and refresh as 28px controls; there is no subtitle and no underline tabs", async () => {
  const page = await renderPage();
  // Scoped to this render's container: the slot is mounted inside it (see
  // renderPage), and a document-wide query would find a leftover one first.
  const slot = page.querySelector('[data-slot="pane-actions"]')!;
  expect(slot === null).toBe(false);
  const group = slot.querySelector('[data-slot="activity-window"]')!;
  expect(group === null).toBe(false);
  expect(group.getAttribute("role")).toBe("group");
  const opts = Array.from(group.querySelectorAll("button"));
  expect(opts.map((b) => b.textContent?.trim())).toEqual(["24h", "7d", "30d"]);
  for (const b of opts) for (const t of ["h-7", "text-2xs"]) expect(b.className.split(/\s+/)).toContain(t);
  // The default window (30d) is the pressed one, marked by the --sel fill and nothing else.
  const pressed = opts.filter((b) => b.getAttribute("aria-pressed") === "true");
  expect(pressed.map((b) => b.textContent?.trim())).toEqual(["30d"]);
  expect(pressed[0]!.className.split(/\s+/)).toContain("bg-sel");
  for (const b of opts.filter((b) => b.getAttribute("aria-pressed") !== "true")) expect(b.className.split(/\s+/)).not.toContain("bg-sel");
  const refreshButtons = slot.querySelectorAll('button[aria-label="Refresh"]');
  expect(refreshButtons.length).toBe(1);
  expect(refreshButtons[0]!.className.split(/\s+/)).toContain("size-7");
  expect(page.textContent).not.toContain("Every LLM call Mandate makes");
  expect(page.innerHTML.includes("border-b-2")).toBe(false);
  const tabs = page.querySelector('[data-slot="page-tabs"]')!;
  expect(tabs.getAttribute("role")).toBe("tablist");
  expect(Array.from(tabs.querySelectorAll('[role="tab"]')).map((t) => t.id)).toEqual(["activity-tab-overview", "activity-tab-breakdown", "activity-tab-logs"]);
  const column = page.querySelector('[data-slot="page-column"]')!;
  for (const t of ["max-w-[1280px]", "px-4", "md:px-8", "gap-6", "pt-1", "pb-6"]) expect(column.className.split(/\s+/)).toContain(t);
});
