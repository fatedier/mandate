import { afterEach, expect, test } from "bun:test";
import { readerTimeZone } from "@/lib/time-zone";
import { act, StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import type { ActivityGroupKey, ActivitySummaryResponse } from "@shared/api-contracts";
import { ActivityPage } from "@/routes/activity/ActivityPage";
import { formatCalendarDay } from "@/lib/format";
import { activitySummaryCache } from "@/routes/activity/useActivitySummary";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settleRounds } from "../helpers/mount.js";
import { emptyLedger } from "../helpers/activity-ledger.js";

/**
 * Wiring only — happy-dom performs no layout, so nothing here may depend on a
 * measured box. What it does guard is the two places the Overview can be wrong
 * while still rendering: which bucket a percentile is pinned to, and whether a
 * zero percentile is presented as a measurement.
 */

const SUMMARY: ActivitySummaryResponse = {
  days: 30,
  ledger: emptyLedger(),
  spend: { micros: 0, reportedMicros: 0, estimated: false, pricedCalls: 0, unpricedCalls: 0, includedCalls: 0, includedApiMicros: 0, pendingCalls: 0 },
  daily: [
    { date: "2026-08-01", calls: 120, failed: 4, inputTokens: 9000, outputTokens: 300, cacheReadTokens: 8100, p50Ms: 800, p95Ms: 4000, p99Ms: 9000 },
    { date: "2026-08-03", calls: 60, failed: 0, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 900, p50Ms: 700, p95Ms: 3000, p99Ms: 8000 }
  ],
  dates: ["2026-08-01", "2026-08-02", "2026-08-03"],
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
      reasons: [{ reason: "Not Found", calls: 4 }],
      spendMicros: 0,
      spendEstimated: false,
      unpricedCalls: 0
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
      reasons: [],
      spendMicros: 0,
      spendEstimated: false,
      unpricedCalls: 0
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
      reasons: [{ reason: "Not Found", calls: 4 }],
      spendMicros: 0,
      spendEstimated: false,
      unpricedCalls: 0
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
      reasons: [],
      spendMicros: 0,
      spendEstimated: false,
      unpricedCalls: 0
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

let currentSearch = "";
let requestedUrls: string[] = [];

afterEach(() => {
  // Unmount before the summary cache the page reads is cleared under it.
  runCleanups();
  requestedUrls = [];
  activitySummaryCache.clear();
});

function LocationProbe() {
  currentSearch = useLocation().search;
  return null;
}

/**
 * The answer for a url, and nothing about when it arrives.
 */
function bodyFor(url: string, summary: ActivitySummaryResponse): unknown {
  if (url.includes("/api/activity/summary")) return summary;
  if (url.includes("/api/activity/calls")) {
    const query = new URL(url, "http://x.example.test").searchParams;
    if (query.get("view") === "expired") return { calls: CALLS, totals: { calls: 542, extraMicros: 465_000_000 } };
    if (query.get("view") === "timers" || query.get("agent")) return { calls: CALLS, totals: { calls: 86, extraMicros: null } };
    return { calls: CALLS };
  }
  return { ok: true };
}

async function renderPage(
  summary: ActivitySummaryResponse = SUMMARY,
  entry = "/activity",
  { strict = false }: { strict?: boolean } = {}
): Promise<HTMLElement> {
  // mockFetch never delivers a response to a caller that gave up, and answers
  // on a later microtask, never in the calling tick. A mock that did either
  // made the whole class of "the cleanup ran and then the setup ran again" —
  // StrictMode's double mount, a superseded re-group — invisible to every
  // test in this file: that ordering is what these tests exist to measure.
  mockFetch((call) => {
    requestedUrls.push(call.url);
    return jsonResponse(bodyFor(call.url, summary));
  });

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
  const { host } = await mountAsync(strict ? <StrictMode>{tree}</StrictMode> : tree);
  await settleRounds(1);
  return host;
}

const callRequests = () => requestedUrls.filter((url) => url.includes("/api/activity/calls"));

async function clickTab(page: HTMLElement, label: string): Promise<void> {
  const tab = [...page.querySelectorAll('[role="tab"]')].find(
    (node) => node.textContent === label
  );
  await act(async () => {
    tab?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settleRounds(1);
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
  await settleRounds(1);
}

/** The Overview's headline figures, as one text. */
function overviewTotals(page: HTMLElement): string {
  return page.querySelector('[data-slot="activity-totals"]')?.textContent ?? "";
}

async function clickBreakdownRow(page: HTMLElement, label: string): Promise<void> {
  const button = [...page.querySelectorAll("tbody button")].find(
    (node) => node.textContent === label
  ) as HTMLElement | undefined;
  if (!button) throw new Error(`no breakdown row labelled ${label}`);
  await act(async () => {
    button.click();
  });
  await settleRounds(1);
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

// The header line names the picker; the grouping is named once, in the
// pressed button, and again over its column (the title, the
// pressed button and the column head all said "Provider / model").
test("the breakdown's header line says what the buttons do, not the grouping a third time", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
  const panel = page.querySelector("#activity-panel-breakdown")!;
  // How long calls take sits above it; the table's own header is the second.
  const header = panel.querySelectorAll('[data-slot="section-header"]')[1]!;
  expect(header.querySelector('[data-slot="section-title"]')!.textContent).toBe("Group by");
  expect(header.querySelector('[data-slot="section-meta"]') === null).toBe(true);
  expect(panel.querySelector("th")!.textContent).toBe("Provider / model");
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
  // Provider / model is the landing cut, so a url with no grouping still asks
  // the endpoint for one.
  expect(summaryRequests()[0]).toContain("group=model");

  await clickGroup(page, "Purpose");
  expect(summaryRequests().length).toBe(2);
  expect(summaryRequests()[1]).toContain("group=purpose");
});

test("choosing a grouping rewrites the url rather than only the table", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
  await clickGroup(page, "Purpose");
  // A grouping held only in component state cannot be linked to or reloaded.
  expect(new URLSearchParams(currentSearch).get("group")).toBe("purpose");
  expect(new URLSearchParams(currentSearch).get("tab")).toBe("breakdown");
});

test("the default grouping carries no parameter", async () => {
  const page = await renderPage(PURPOSE_SUMMARY, "/activity?tab=breakdown&group=purpose");
  await clickGroup(page, "Provider / model");
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

test("the log's request names the reader's time zone, so its day is theirs", async () => {
  await renderPage(SUMMARY, "/activity?tab=logs&day=2026-10-25");
  const requested = new URL(callRequests().at(-1) ?? "", "http://x").searchParams;
  expect(requested.get("day")).toBe("2026-10-25");
  expect(requested.get("tz")).toBe(readerTimeZone());
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
      "&scopeType=memory&day=2026-08-01&fallback=1&q=llm_abc&view=expired&agent=managers"
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
  // The day reads as a date; the URL keeps its key.
  expect(chips).toEqual(["scope: memory", `day: ${formatCalendarDay("2026-08-01")}`, "attempt: primary"]);
  expect(chips[1]).toMatch(/^day: Aug 1(, 2026)?$/);
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
  // The other statement, which the chip fix alone would have left lying: what
  // was actually asked for.
  expect(callRequests().at(-1) ?? "").not.toContain("fallback");
});

test("removing one linked filter leaves the others alone", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=logs&scopeType=memory&day=2026-08-01");
  const chip = [...page.querySelectorAll("button")].find(
    (node) => node.textContent === `day: ${formatCalendarDay("2026-08-01")}`
  );
  await act(async () => {
    chip?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settleRounds(1);

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
  await settleRounds(1);

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
  await settleRounds(1);

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

  // The regrouped answer never lands. mockFetch rejects on abort the way the
  // real fetch does, so an aborted request cannot settle onto the page either.
  mockFetch(() => new Promise<Response>(() => {}));

  await clickGroup(page, "Purpose");

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
  expect(pressed?.textContent).toBe("Purpose");
});

test("a percentile is pinned to the bucket it falls in", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown");
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
  }, "/activity?tab=breakdown");
  expect(page.querySelectorAll("[data-latency-bucket]").length).toBe(5);
  // Named by bucket rather than by node: a failed `toEqual` over DOM elements
  // serialises the whole tree and never comes back.
  const pinned = [...page.querySelectorAll("[data-latency-bucket]")]
    .filter((row) => /p50|p95|p99/.test(row.textContent ?? ""))
    .map((row) => row.getAttribute("data-latency-bucket"));
  expect(pinned).toEqual([]);
});

test("the overview asks for the purpose cut, whatever grouping the url holds", async () => {
  // The page holds one summary and the Overview asks for the purpose cut while
  // it is showing. The grouping the reader picked is not overwritten — it
  // waits in the url for their return.
  const page = await renderPage(PURPOSE_SUMMARY, "/activity?group=day");
  expect(summaryRequests().length).toBe(1);
  expect(summaryRequests()[0]).toContain("group=purpose");
  expect(new URLSearchParams(currentSearch).get("group")).toBe("day");
  expect(overviewTotals(page)).toContain("180");

  await clickTab(page, "Breakdown");
  expect(summaryRequests().length).toBe(2);
  expect(summaryRequests()[1]).toContain("group=day");
});

const refreshButton = (page: HTMLElement) => [...page.querySelectorAll("button")].find(
  (node) => node.getAttribute("aria-label")?.startsWith("Refresh") ?? false
) as HTMLButtonElement | undefined;

/** From here on, a summary request never answers; the log's still do. */
function holdSummaries() {
  mockFetch((call) => {
    requestedUrls.push(call.url);
    if (call.url.includes("/api/activity/summary")) return new Promise<Response>(() => {});
    return jsonResponse(bodyFor(call.url, SUMMARY));
  });
}

for (const tab of ["Overview", "Breakdown"]) {
  test(`a summary still loading shows its skeleton on ${tab}, with Refresh disabled as Refreshing`, async () => {
    // Opened on the log, the summary is not asked for until a summary tab is.
    const page = await renderPage(SUMMARY, "/activity?tab=logs");
    holdSummaries();
    await clickTab(page, tab);
    expect(summaryRequests()).toHaveLength(1);
    expect(page.querySelector('[role="tabpanel"] [data-slot="skeleton"]')).not.toBeNull();
    const refresh = refreshButton(page);
    expect([refresh?.getAttribute("aria-label"), refresh?.disabled]).toEqual(["Refreshing", true]);
  });
}

test("a refresh keeps the answer on screen and shows Refreshing until the new one lands", async () => {
  const page = await renderPage(PURPOSE_SUMMARY);
  const rows = () => overviewTotals(page);
  const before = rows();
  expect(before).toContain("180");
  holdSummaries();
  await act(async () => {
    refreshButton(page)?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settleRounds(1);
  expect(rows()).toBe(before);
  const refresh = refreshButton(page);
  expect([refresh?.getAttribute("aria-label"), refresh?.disabled]).toEqual(["Refreshing", true]);
});

test("the dev double-mount lands on a table, not on a skeleton", async () => {
  // `main.tsx` wraps the app in StrictMode, so this is how the page really
  // mounts in dev: every effect set up, torn down, and set up again. Getting
  // that wrong does not show as a missing request — it shows as a page that
  // never leaves its skeleton, with the Refresh button that would rescue it
  // disabled by the same `loading` that is stuck.
  const page = await renderPage(PURPOSE_SUMMARY, "/activity", { strict: true });
  expect(page.querySelector('[role="tabpanel"] [data-slot="skeleton"]') === null).toBe(true);
  expect(overviewTotals(page)).toContain("180");
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
  // The same answer throughout, so the figures never left.
  expect(overviewTotals(page)).toContain("180");
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

test("a By agent row opens the log filtered to that agent", async () => {
  const page = await renderPage({
    ...PURPOSE_SUMMARY,
    ledger: emptyLedger({ agents: [{ role: "managers", calls: 180, spendMicros: 0, expiredExtraMicros: 0, money: "unpriced" }] })
  }, "/activity?group=model");
  const link = [...page.querySelectorAll("a")].find((node) => node.textContent === "Managers") as HTMLElement | undefined;
  await act(async () => {
    link?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await settleRounds(2);
  const params = new URLSearchParams(currentSearch);
  expect(params.get("tab")).toBe("logs");
  expect(params.get("agent")).toBe("managers");
  expect(page.querySelector('[role="tabpanel"]')?.id).toBe("activity-panel-logs");
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

// Refresh asks again for what the open tab is drawn from, once, and not the
// other tab's request.
const refreshRows: Array<{ name: string; tab: "breakdown" | "logs"; asked: string; untouched: string }> = [
  {
    // Breakdown reads the same response the Overview does, so Refresh here is the
    // summary request — not the log's, which has no list on screen to reload.
    name: "refreshing the breakdown re-asks for the summary it is drawn from",
    tab: "breakdown",
    asked: "/api/activity/summary",
    untouched: "/api/activity/calls"
  },
  {
    name: "the refresh button asks the tab that is showing, and only that tab",
    tab: "logs",
    asked: "/api/activity/calls",
    untouched: "/api/activity/summary"
  }
];

test.each(refreshRows)("$name", async ({ tab, asked, untouched }) => {
  const page = await renderPage(SUMMARY, `/activity?tab=${tab}`);
  const before = requestedUrls.length;
  const refresh = [...page.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Refresh"
  );
  await act(async () => {
    refresh?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settleRounds(1);

  const since = requestedUrls.slice(before);
  expect(since.filter((url) => url.includes(asked)).length).toBe(1);
  expect(since.filter((url) => url.includes(untouched)).length).toBe(0);
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
  expect(requestedUrls.slice(before).filter((url) => url.includes("/summary"))).toStrictEqual([]);
  expect(new URLSearchParams(currentSearch).get("days")).toBe("7");
});

test("the window and the grouping are two independent choices", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=breakdown&days=7&group=purpose");
  // Both pressed at once, each in its own named group — the regression a single
  // shared `asked` key would produce is one of them silently reverting.
  expect(pressedIn(page, "Window")).toBe("7d");
  expect(pressedIn(page, "Group by")).toBe("Purpose");
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

/** The log panel's header line. */
const logHeader = (page: HTMLElement) => page.querySelector("#activity-panel-logs header")?.firstElementChild?.textContent ?? "";

async function clickPreset(page: HTMLElement, label: string): Promise<void> {
  const chip = [...page.querySelectorAll("[data-log-preset]")].find((node) => node.textContent === label) as HTMLElement | undefined;
  await act(async () => {
    chip?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settleRounds(2);
}

test("presets set the view and keep the other filters", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=logs&purpose=agent_wake_step");
  expect([...page.querySelectorAll("[data-log-preset]")].map((n) => n.textContent)).toEqual(["All", "Failed", "Slow", "Cache expired", "Timers"]);
  await clickPreset(page, "Slow");
  let params = new URLSearchParams(currentSearch);
  expect([params.get("view"), params.get("purpose")]).toEqual(["slow", "agent_wake_step"]);
  await clickPreset(page, "Failed");
  params = new URLSearchParams(currentSearch);
  expect([params.get("view"), params.get("status")]).toEqual([null, "failed"]);
  expect([...page.querySelectorAll('[data-log-preset][aria-pressed="true"]')].map((n) => n.textContent)).toEqual(["Failed"]);
  await clickPreset(page, "All");
  params = new URLSearchParams(currentSearch);
  expect([params.get("view"), params.get("status"), params.get("purpose")]).toEqual([null, null, "agent_wake_step"]);
});

test("period views ask for the page's window and say so", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=logs&view=expired&days=7");
  expect(callRequests().at(-1) ?? "").toContain("view=expired");
  expect(callRequests().at(-1) ?? "").toContain("days=7");
  expect(logHeader(page)).toContain("Cache expired · last 7 days · 542 calls");
  expect(logHeader(page)).toContain("~$465.00 paid on top of a cache read");
  await clickPreset(page, "Slow");
  expect(callRequests().at(-1) ?? "").toContain("view=slow");
  expect(callRequests().at(-1) ?? "").not.toContain("days=");
  expect(logHeader(page)).toContain("Recent calls");
});

test("an agent filter shows as a chip that can be removed", async () => {
  const page = await renderPage(SUMMARY, "/activity?tab=logs&agent=managers");
  expect(callRequests().at(-1) ?? "").toContain("agent=managers");
  expect(callRequests().at(-1) ?? "").toContain("days=30");
  expect(logHeader(page)).toContain("Managers · last 30 days · 86 calls");
  const chip = [...page.querySelectorAll("button")].find((n) => n.textContent?.includes("agent: Managers")) as HTMLElement | undefined;
  expect(chip === undefined).toBe(false);
  await act(async () => {
    chip?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await settleRounds(2);
  expect(new URLSearchParams(currentSearch).get("agent")).toBeNull();
});
