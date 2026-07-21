import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { MandateStore } from "../src/server/app/store.js";
import { startServer, type RunningServer } from "./helpers/server.js";

// Layout needs a real browser; happy-dom does not measure visibility or overflow.

let server: RunningServer;
let browser: Browser;

/** Bun's default per-test budget is five seconds, and a browser test that runs
 *  past it is killed hard enough to take the shared browser down — one real
 *  failure then reports as four. A locator that never resolves has to fail
 *  inside its own test, with its own message, so both numbers are stated here
 *  and the wait is the shorter of the two. */
const TEST_TIMEOUT_MS = 20_000;
const WAIT_MS = 8_000;

/**
 * All six purposes the recorder emits — `grep -rhoE 'purpose: "[a-z_]+"'
 * src/server` — not a selection of them. The three memory extraction purposes
 * are 25 to 33 characters, against a column that is 167px at its widest, and
 * none of them clears it (see the measured table below); a fixture holding
 * only the short ones would let the truncation test pass by omission.
 *
 * `agent_wake_step` dominates the way it dominates the store (495 of the last
 * 500), and the rare ones are pinned to fixed early indices so every one of
 * them is on the first page the log renders.
 */
const DOMINANT_PURPOSE = "agent_wake_step";

const RARE_PURPOSE_AT = new Map<number, string>([
  [3, "agent_compression"],
  [5, "memory_dream"],
  [8, "memory_summary_extraction"],
  [11, "memory_new_chat_extraction"],
  [14, "memory_feature_archive_extraction"],
  [21, "agent_compression"],
  [26, "memory_dream"]
]);

/** Spread across all five latency buckets, and no two alike: a fixture where
 *  every call takes the same time makes the percentile columns agree with each
 *  other for a reason that has nothing to do with the code. */
const LATENCIES_MS = [
  420, 780, 940, 1_600, 2_450, 3_900, 4_800, 6_200,
  7_450, 9_100, 11_300, 14_200, 16_800, 23_500, 38_900, 64_200
];

/** The shape wrapped provider failures arrive in: the provider's own
 *  error object returned down the streaming channel, wrapped by the SDK's
 *  schema check. */
const WRAPPED_PROVIDER_ERROR =
  'Type validation failed: Value: {"error":{"message":"litellm.APIError: ' +
  'Our servers are currently overloaded. Please try again later.","type":null,' +
  '"param":null,"code":"500"}}.\nError message: [\n  {\n    "code": "invalid_union"';

const SEEDED_CALLS = 40;

/** Row `index` counted back from newest. Rows are three hours apart so every
 *  `created_at` is distinct — `order by created_at desc` decides which twenty
 *  the first page shows, and equal timestamps would make that arbitrary. */
function seedActivityCalls(dataDir: string): void {
  const store = new MandateStore(dataDir);
  try {
    const insert = store.db.prepare(`
      insert into llm_calls (
        id, purpose, scope_type, scope_id, provider, model,
        request_hash, response_hash, metadata_json,
        input_tokens, output_tokens, total_tokens, cache_read_tokens,
        status, error_json, started_at, finished_at, latency_ms,
        created_at, updated_at
      ) values (?, ?, ?, 'thread-e2e', ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (let index = 0; index < SEEDED_CALLS; index += 1) {
      const createdAt = new Date(now - index * 3 * 3_600_000 - 25_000).toISOString();
      const latencyMs = LATENCIES_MS[index % LATENCIES_MS.length]! + index;
      const finishedAt = new Date(Date.parse(createdAt) + latencyMs).toISOString();
      // Include both failed and succeeded calls with long purposes.
      const failed = index === 7 || index === 3;
      // No `running` row, and none is possible here: `MandateStore`'s
      // constructor marks every running or pending call failed, so a live
      // status cannot survive the boot this tier goes through. `StatusWord`
      // renders for `running` too and "running" is the wider word — that the
      // column assertions below group on which word appeared rather than on
      // whether one did is what keeps them honest if that ever changes. The
      // word itself is covered where it is reachable, in
      // tests/client/activity-log-row.test.tsx.
      insert.run(
        `llm_e2e_${String(index).padStart(3, "0")}`,
        purposeFor(index),
        scopeTypeFor(index),
        // Two providers and two models, because a breakdown of a single-model
        // fixture is one row and every grouping of it looks correct. The
        // majority keeps index 0, which the detail-panel test reads. The model
        // name carrying its own slash is the case `logFilterFor` splits on the
        // FIRST " / " for: `openai-compatible / codex/gpt-5.6-sol` has to come
        // apart into two filters, not three.
        index % 5 === 4 ? "codex" : "openai-compatible",
        index % 5 === 4 ? "gpt-5.5" : "codex/gpt-5.6-sol",
        `req_${index}`,
        `res_${index}`,
        JSON.stringify(metadataFor(index)),
        // The prompt, whole. `cache_read_tokens` below is the part of it that
        // was cached, so it has to be the smaller of the two — a seed with more
        // cached than prompt describes a call no provider can report, and would
        // let a hit rate over 100% pass unnoticed.
        50_000 + index * 371,
        // One call recorded no output, so tok/s has a "no reading" case.
        index === 12 ? null : 130 + index * 17,
        50_130 + index * 388,
        // One call read nothing from cache — a genuine 0%, not a missing value.
        index === 3 ? 0 : 40_000 + index * 913,
        failed ? "failed" : "succeeded",
        failed ? JSON.stringify({ name: "AI_TypeValidationError", message: WRAPPED_PROVIDER_ERROR }) : null,
        createdAt,
        finishedAt,
        latencyMs,
        createdAt,
        finishedAt
      );
    }
  } finally {
    store.db.close();
  }
}

/** Interleaved rather than blocked, so the twenty rows the first page shows
 *  carry more than one purpose — otherwise "filtered to that pattern" would be
 *  true of the unfiltered list too. */
function purposeFor(index: number): string {
  return RARE_PURPOSE_AT.get(index) ?? DOMINANT_PURPOSE;
}

/** Every third call, so the minority scope is smaller than one page of the log
 *  — which is what makes "the list came back filtered" measurable rather than
 *  merely asserted about the url. */
function scopeTypeFor(index: number): string {
  return index % 3 === 0 ? "memory" : "agent_thread";
}

/** How many rows the `memory` scope holds. Derived rather than written down:
 *  the claim is that the log came back with this scope's rows and no others,
 *  and a number typed twice stops being that claim the first time the seed
 *  changes. It is under one page (20), so nothing pages in behind it. */
const MEMORY_CALLS = Array.from({ length: SEEDED_CALLS }, (_unused, index) => index)
  .filter((index) => scopeTypeFor(index) === "memory").length;

/** The newest row carries a feature event, so the detail panel has the fields
 *  the deleted in-row expansion used to show and `retention.ts` still keeps
 *  the metadata keys for. */
function metadataFor(index: number): Record<string, unknown> {
  const phase = index % 2 === 0 ? "delivering" : "planning";
  const providerName = index % 5 === 4 ? "direct-codex" : "llm-proxy";
  if (index !== 0) return { phase, providerName };
  return {
    phase,
    providerName,
    featureEvents: [
      {
        type: "feature_event",
        kind: "completion",
        taskId: "task-e2e",
        featureId: "feat-e2e",
        workItemId: "wi-e2e",
        source: {
          project: { id: "proj-e2e", name: "Mandate" },
          feature: { id: "feat-e2e", name: "activity-page-rebuild" },
          workItem: { id: "wi-e2e", title: "Rebuild the log row" },
          capturedAt: "2026-08-03T00:00:00.000Z"
        },
        label: "Rebuild the log row"
      }
    ]
  };
}

beforeAll(async () => {
  server = await startServer({ configured: true, seed: seedActivityCalls });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server?.cleanup();
});

/** Use a fresh browser context so each case starts with the default layout. */
async function openActivity(search = "", viewport = { width: 1280, height: 900 }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}/activity${search}`, { waitUntil: "networkidle" });
  return page;
}

async function purposeCells(page: Page): Promise<Array<{ purpose: string }>> {
  return page.locator("[data-log-purpose]").evaluateAll((nodes) =>
    nodes.map((node) => ({ purpose: node.textContent ?? "" }))
  );
}

const distinctPurposes = (cells: Array<{ purpose: string }>) =>
  [...new Set(cells.map((cell) => cell.purpose))].sort();

test("Logs pauses failed automatic pagination until a successful manual retry", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  attachPageDiagnostics(page);
  page.setDefaultTimeout(WAIT_MS);
  let failOlder = true;
  const olderRequests: string[] = [];
  await page.route("**/api/activity/calls?*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has("before")) return route.continue();
    olderRequests.push(url.search);
    if (!failOlder) return route.continue();
    await route.fulfill({ status: 502, contentType: "text/html", body: "<html>Proxy failure</html>" });
  });
  try {
    await page.goto(`${server.baseUrl}/activity?tab=logs`);
    await page.locator("[data-log-row]").nth(19).waitFor();
    await page.getByRole("button", { name: "Load older", exact: true }).scrollIntoViewIfNeeded();
    const retry = page.getByRole("button", { name: "Retry loading older", exact: true });
    await retry.waitFor();
    // Leave the sentinel visible across many frames; reconnecting its observer
    // after each failed request used to produce a continuous retry loop.
    await page.waitForTimeout(1000);
    expect(olderRequests).toHaveLength(1);
    expect(await page.locator("[data-log-row]").count()).toBe(20);
    await page.getByText("HTTP 502", { exact: true }).waitFor();

    await retry.click();
    await retry.waitFor();
    await page.waitForTimeout(500);
    expect(olderRequests).toHaveLength(2);
    expect(olderRequests[1]).toBe(olderRequests[0]);

    failOlder = false;
    await retry.click();
    await page.locator("[data-log-row]").nth(39).waitFor();
    await page.getByText("HTTP 502", { exact: true }).waitFor({ state: "hidden" });
    expect(olderRequests).toHaveLength(3);
    expect(olderRequests[2]).toBe(olderRequests[0]);

    await page.getByRole("button", { name: "Load older", exact: true }).scrollIntoViewIfNeeded();
    await page.getByText("No older calls.", { exact: true }).waitFor();
    expect(olderRequests).toHaveLength(4);
    expect(olderRequests[3]).not.toBe(olderRequests[0]);
    expect(await page.locator("[data-log-row]").count()).toBe(SEEDED_CALLS);
  } finally {
    await page.close();
  }
}, TEST_TIMEOUT_MS);

describe("the activity log row", () => {
  for (const width of [375, 1280, 1440, 1920]) {
    test(`models and readings remain visible at a ${width}px viewport`, async () => {
      const page = await openActivity("?tab=logs", { width, height: 900 });
      try {
        await page.locator("[data-log-model]").first().waitFor({ state: "visible", timeout: WAIT_MS });
        const rows = await page.locator("[data-log-row]").evaluateAll((nodes) =>
          nodes.map((row) => {
            const model = row.querySelector("[data-log-model]")!;
            const provider = row.querySelector("[data-log-provider]")!;
            const metrics = row.querySelector("[data-log-metrics]")!;
            const info = row.querySelector("[data-log-info]")!;
            const box = row.getBoundingClientRect();
            const infoBox = info.getBoundingClientRect();
            const metricsBox = metrics.getBoundingClientRect();
            return {
              model: model.textContent,
              provider: provider.textContent,
              modelWidth: model.clientWidth,
              modelScroll: model.scrollWidth,
              metricsWidth: metrics.clientWidth,
              inside: metricsBox.right <= box.right && infoBox.right <= box.right,
              separate: metricsBox.left >= infoBox.right || metricsBox.top >= infoBox.bottom,
              visible: [model, metrics, row.querySelector("[data-log-purpose]")!, provider]
                .every((node) => node.getClientRects().length > 0 && node.clientWidth > 0)
            };
          })
        );
        expect(rows.length).toBeGreaterThanOrEqual(20);
        expect([...new Set(rows.map((row) => row.model))].sort()).toEqual([
          "codex/gpt-5.6-sol", "gpt-5.5"
        ]);
        expect([...new Set(rows.map((row) => row.provider))].sort()).toEqual([
          "direct-codex", "llm-proxy"
        ]);
        expect(rows.every((row) => row.visible && row.inside && row.separate)).toBe(true);
        expect(rows.every((row) => row.modelScroll <= row.modelWidth)).toBe(true);
        const overflows = await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth);
        expect(overflows).toBe(false);
      } finally {
        await page.close();
      }
    }, TEST_TIMEOUT_MS);
  }

  test("opening a call does not move the rows underneath it", async () => {
    // The inline expansion this replaces animated grid-template-rows from
    // 0fr to 1fr, which pushed every row below it down the page — including
    // whatever the reader had opened the row to compare against.
    const page = await openActivity("?tab=logs");
    try {
      const rows = page.locator("[data-log-row]");
      await rows.first().waitFor({ state: "visible", timeout: WAIT_MS });
      const before = await rows.nth(6).boundingBox();
      await rows.first().click();
      await page.locator("[data-call-detail]").waitFor({ state: "visible", timeout: WAIT_MS });
      const after = await rows.nth(6).boundingBox();
      expect(after?.y).toBe(before?.y);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("the panel carries the fields the row stopped showing", async () => {
    // Scoped to the field grid on purpose, though not for the reason it looks
    // like. Only one of these five strings — `delivering` — appears anywhere
    // else in the panel: the seed writes no request/response/output payload,
    // so `metadata` is the sole raw-JSON section, and it holds `phase`
    // literally. The provider and the model are columns that never reach a
    // payload, and the other two are joined by this module rather than stored.
    // So an unscoped assertion would not be wholly vacuous — it would be
    // vacuous for exactly one of the five, which is worse: `delivering` would
    // keep passing with `buildCallDetailFields` deleted.
    const page = await openActivity("?tab=logs");
    try {
      await page.locator("[data-log-row]").first().click();
      await page.locator("[data-call-detail]").waitFor({ state: "visible", timeout: WAIT_MS });
      // Waited for explicitly: `innerText()` carries Playwright's own 30s
      // actionability budget, which outlives this test's 20s and gets it killed
      // hard enough to take the shared browser — and the tests after it — down.
      const grid = page.locator("[data-call-fields]");
      await grid.waitFor({ state: "visible", timeout: WAIT_MS });
      const fields = await grid.innerText();
      expect(fields).toContain("openai-compatible");
      expect(fields).toContain("codex/gpt-5.6-sol");
      expect(fields).toContain("delivering");
      // The feature-event annotation the deleted in-row expansion carried, and
      // the reason `retention.ts` keeps these metadata keys past the window.
      expect(fields).toContain("completed · Rebuild the log row");
      expect(fields).toContain("Mandate / activity-page-rebuild");
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("the panel leads with the provider's own reason, not the wrapper", async () => {
    const page = await openActivity("?tab=logs&status=failed");
    try {
      await page.locator("[data-log-row]").first().click();
      await page.locator("[data-call-detail]").waitFor({ state: "visible", timeout: WAIT_MS });
      const block = page.locator("[data-call-error]");
      await block.waitFor({ state: "visible", timeout: WAIT_MS });
      const reason = await block.innerText();
      expect(reason).toContain("Our servers are currently overloaded");
      // Wrapped provider failures record the wrapper as their message. It
      // is still in the `error` payload below; it is not what leads.
      expect(reason).not.toContain("Type validation failed");
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

});

/**
 * The breakdown's columns, measured.
 *
 * The tiers are container queries, and happy-dom evaluates none of them: every
 * heading is "visible" there whatever the width, so `tests/` can assert which
 * class a cell carries and nothing about which cells a reader sees. That is the
 * whole of what this block adds.
 */
const breakdownHeadings = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("th")]
      // The same test the phone case uses: a `display: none` heading has no
      // boxes. `offsetParent` would answer null for a positioned ancestor too.
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => node.textContent ?? "")
  );

/** The width the tiers are actually evaluated against — the `@container`
 *  ancestor, not the viewport. Walked up from the table's parent, because the
 *  table sits inside `overflow-x-auto` and measures its own un-shrunk width.
 *
 *  Throws rather than answering 0 when the walk finds nothing: 0 is less than
 *  every edge, so a `?? 0` would let the core-tier test's width half pass
 *  vacuously — in the one test that measures the tier this file exists to
 *  measure. A missing container is also the mutation Task 2's unit test covers,
 *  and it must not read here as "narrow". */
const breakdownContainerWidth = (page: Page) =>
  page.evaluate(() => {
    let node = document.querySelector("table")?.parentElement ?? null;
    while (node && !node.className.split(/\s+/).includes("@container")) node = node.parentElement;
    if (!node) throw new Error("no @container ancestor above the breakdown table");
    return node.clientWidth;
  });

async function expectBreakdownFits(page: Page) {
  const layout = await page.locator("table").evaluate((table) => {
    const scroller = table.parentElement!;
    const bounds = scroller.getBoundingClientRect();
    const visibleCells = [...table.querySelectorAll<HTMLTableCellElement>("th, td")].filter((cell) => cell.getClientRects().length > 0);
    return {
      overflow: scroller.scrollWidth - scroller.clientWidth,
      clipped: visibleCells.filter((cell) => {
        const rect = cell.getBoundingClientRect();
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
      }).map((cell) => cell.textContent),
      overflowingMetrics: visibleCells.filter((cell) => cell.cellIndex > 0 && cell.scrollWidth > cell.clientWidth + 1)
        .map((cell) => cell.textContent)
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.clipped).toEqual([]);
  expect(layout.overflowingMetrics).toEqual([]);
}

/**
 * The tiers, in the order the columns are dropped. Not re-derived here: the
 * component's own rule is 52rem then 40rem, and these are what a reader is left
 * holding on each side of those edges.
 */
const CORE_COLUMNS = ["Provider / model", "Calls", "p50", "p95", "Failed"];
const MID_COLUMNS = [...CORE_COLUMNS, "Input", "Cache"];
const ALL_COLUMNS = [
  "Provider / model", "Calls", "p50", "p95", "p99", "max",
  "Failed", "Fallback", "Input", "Cache", "Output"
];

/** Container-query edges with the app's 16px root font size. */
const TIER_2_EDGE_PX = 52 * 16;
const TIER_1_EDGE_PX = 40 * 16;

/** At equal split, the expanded sidebar leaves the 1512px viewport in the
 *  core tier. Collapsing it reaches the middle tier; 1920px reaches the full
 *  tier. Assert the actual container band as well as its visible columns. */
const MID_VIEWPORT = { width: 1512, height: 900 };
const WIDE_VIEWPORT = { width: 1920, height: 900 };

async function openBreakdown(search: string, viewport = MID_VIEWPORT, sidebarCollapsed = true) {
  const page = await browser.newPage({ viewport });
  attachPageDiagnostics(page);
  await page.addInitScript((sidebarCollapsed) => {
    localStorage.setItem("ap.ui", JSON.stringify({
      state: { sidebarCollapsed, sidebarWidth: 224, chatPanelRatio: 0.5 }, version: 0
    }));
    localStorage.setItem("mandate.chat.drawerOpen.v1", "true");
  }, sidebarCollapsed);
  await page.goto(`${server.baseUrl}/activity${search}`, { waitUntil: "networkidle" });
  await page.locator("table").first().waitFor({ timeout: WAIT_MS });
  return page;
}

describe("the breakdown", () => {
  test("equal split with the expanded sidebar keeps the core columns readable", async () => {
    const page = await openBreakdown("?tab=breakdown", MID_VIEWPORT, false);
    try {
      const width = await breakdownContainerWidth(page);
      expect(width).toBeGreaterThanOrEqual(34 * 16);
      expect(width).toBeLessThan(TIER_1_EDGE_PX);
      expect(await breakdownHeadings(page)).toEqual(CORE_COLUMNS);
      await expectBreakdownFits(page);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("between the two edges the token columns outrank the tail percentiles", async () => {
    // The tier the ordering exists for, and the one no unit test can see: input
    // and cache are still on screen where p99, max, fallback and output are
    // not. A container query is evaluated by the browser or not at all —
    // happy-dom reports every heading visible at every width.
    const page = await openBreakdown("?tab=breakdown", MID_VIEWPORT);
    try {
      const width = await breakdownContainerWidth(page);
      expect(width).toBeGreaterThanOrEqual(TIER_1_EDGE_PX);
      expect(width).toBeLessThan(TIER_2_EDGE_PX);
      expect(await breakdownHeadings(page)).toEqual(MID_COLUMNS);
      await expectBreakdownFits(page);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("a wide window shows every column, in the order they were specified", async () => {
    const page = await openBreakdown("?tab=breakdown", WIDE_VIEWPORT);
    try {
      expect(await breakdownContainerWidth(page)).toBeGreaterThanOrEqual(TIER_2_EDGE_PX);
      // The whole list, not its length: eleven headings in the wrong order is
      // the same count and a different table.
      expect(await breakdownHeadings(page)).toEqual(ALL_COLUMNS);
      await expectBreakdownFits(page);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("changing the grouping changes the first column and nothing else", async () => {
    // Two readings of one window are only comparable if the figures beside the
    // key do not move. Read at the mid tier, so seven columns are on screen to
    // disagree rather than five.
    const page = await openBreakdown("?tab=breakdown", MID_VIEWPORT);
    try {
      await page.getByRole("button", { name: "scope type" }).click();
      await page.locator("th", { hasText: "Scope type" }).waitFor({ timeout: WAIT_MS });
      const headings = await breakdownHeadings(page);
      expect(headings[0]).toBe("Scope type");
      expect(headings.slice(1)).toEqual(MID_COLUMNS.slice(1));
      await expectBreakdownFits(page);
      // The grouping is in the url, so this cut can be linked to and reloaded.
      expect(new URL(page.url()).searchParams.get("group")).toBe("scopeType");
      // And it is the endpoint's cut, not a relabelling of the model one: the
      // seed's two scope types are these.
      const keys = await page.evaluate(() =>
        [...document.querySelectorAll("tbody button")].map((node) => node.textContent)
      );
      expect(keys.sort()).toEqual(["agent_thread", "memory"]);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("retained columns fit immediately around both container-query boundaries", async () => {
    const page = await openBreakdown("?tab=breakdown", WIDE_VIEWPORT);
    try {
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("16px");
      for (const width of [639, 640, 641, 831, 832, 833]) {
        // Control only the containing block, leaving the table and its cells
        // governed by the shipped CSS, independently of shell dimensions.
        await page.locator("table").evaluate((table, width) => {
          let node = table.parentElement!;
          while (!node.classList.contains("@container")) node = node.parentElement!;
          node.style.width = `${width}px`;
        }, width);
        expect(await breakdownContainerWidth(page)).toBe(width);
        const expected = width < TIER_1_EDGE_PX ? CORE_COLUMNS : width < TIER_2_EDGE_PX ? MID_COLUMNS : ALL_COLUMNS;
        expect(await breakdownHeadings(page)).toEqual(expected);
        await expectBreakdownFits(page);
      }
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("long group names and reasons shrink without hiding retained metrics", async () => {
    const page = await openBreakdown("?tab=breakdown");
    try {
      const label = "provider / " + "long-model-name-".repeat(12);
      const reason = "Upstream rejected the request. ".repeat(15);
      await page.route("**/api/activity/summary?*", async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        payload.groups[0].label = label;
        payload.groups[0].reasons = [{ reason, calls: 2 }];
        await route.fulfill({ response, json: payload });
      });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      const name = page.getByRole("button", { name: label, exact: true });
      await name.waitFor({ timeout: WAIT_MS });
      const detail = page.locator("[data-group-reason]").first();
      expect(await name.getAttribute("title")).toBe(label);
      expect(await detail.getAttribute("title")).toContain(reason);
      expect(await name.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      expect(await detail.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      expect(await breakdownHeadings(page)).toEqual(MID_COLUMNS);
      await expectBreakdownFits(page);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("resizing the chat pane updates the visible metrics and equal split can be restored", async () => {
    const page = await openBreakdown("?tab=breakdown", MID_VIEWPORT, false);
    try {
      const initialWidth = await breakdownContainerWidth(page);
      const separator = page.getByRole("separator", { name: "Resize chat panel" });
      expect(await breakdownHeadings(page)).toEqual(CORE_COLUMNS);
      await separator.focus();
      for (let index = 0; index < 8; index++) await separator.press("ArrowRight");
      expect(await breakdownHeadings(page)).toEqual(MID_COLUMNS);
      await expectBreakdownFits(page);
      await separator.press("Home");
      expect(await breakdownContainerWidth(page)).toBe(initialWidth);
      expect(await breakdownHeadings(page)).toEqual(CORE_COLUMNS);
      await expectBreakdownFits(page);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("a phone keeps horizontal scrolling inside the table", async () => {
    const page = await openActivity("?tab=breakdown", { width: 375, height: 900 });
    try {
      const table = page.locator("table");
      await table.waitFor({ timeout: WAIT_MS });
      expect(await breakdownHeadings(page)).toEqual(CORE_COLUMNS);
      const layout = await table.evaluate((table) => {
        const scroller = table.parentElement!;
        scroller.scrollLeft = scroller.scrollWidth;
        const last = [...table.querySelectorAll("th")].filter((cell) => cell.getClientRects().length > 0).at(-1)!;
        return {
          scrollLeft: scroller.scrollLeft,
          rightEdge: last.getBoundingClientRect().right,
          containerEdge: scroller.getBoundingClientRect().right,
          pageOverflow: document.documentElement.scrollWidth > innerWidth
        };
      });
      expect(layout.scrollLeft).toBeGreaterThan(0);
      expect(layout.rightEdge).toBeLessThanOrEqual(layout.containerEdge + 1);
      expect(layout.pageOverflow).toBe(false);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("a row opens the log filtered to that group", async () => {
    const page = await openBreakdown("?tab=breakdown");
    try {
      // The model name carries a slash of its own, so this row's key is
      // `openai-compatible / codex/gpt-5.6-sol` — two filters, not three.
      await page.getByRole("button", { name: /gpt-5\.6-sol/ }).first().click();
      await page.locator("#activity-panel-logs").waitFor({ state: "visible", timeout: WAIT_MS });
      const params = new URL(page.url()).searchParams;
      expect(params.get("provider")).toBe("openai-compatible");
      expect(params.get("model")).toBe("codex/gpt-5.6-sol");
      await page.locator("[data-log-purpose]").first().waitFor({ timeout: WAIT_MS });
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("a scope-type row opens a log the server really filtered", async () => {
    // The one path that runs end to end: a row key becomes a url parameter,
    // becomes a query string, becomes a where clause in the shipped binary.
    // Counted rather than asserted about the url, because a filter the server
    // ignores produces exactly the same url and forty rows instead of fourteen.
    const page = await openBreakdown("?tab=breakdown&group=scopeType");
    try {
      await page.getByRole("button", { name: "memory", exact: true }).click();
      await page.locator("#activity-panel-logs").waitFor({ state: "visible", timeout: WAIT_MS });
      expect(new URL(page.url()).searchParams.get("scopeType")).toBe("memory");

      // Counted as soon as the first page renders, so a server that ignored the
      // filter says so as a number — twenty rows against fourteen — rather than
      // as a timeout further down.
      await page.locator("[data-log-row]").first().waitFor({ timeout: WAIT_MS });
      expect(await page.locator("[data-log-row]").count()).toBe(MEMORY_CALLS);
      // And the feed is complete, so those fourteen are the whole answer rather
      // than the head of a longer one: this scope is under a page, the store is
      // twice that.
      await page.getByText("No older calls.").waitFor({ timeout: WAIT_MS });

      // The bar has no control for this filter, so the chip is the only thing
      // on the page that says the list is not everything — and `Clear` only
      // appears when a chip does.
      await page.getByRole("button", { name: "scope: memory" }).waitFor({ timeout: WAIT_MS });
      await page.getByRole("button", { name: "Clear" }).waitFor({ timeout: WAIT_MS });
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe("the overview hands off to the log", () => {
  test("a pattern row opens the log filtered to that pattern", async () => {
    const page = await openActivity();
    try {
      await page.getByRole("row", { name: /agent_wake_step/ }).first().click();
      await page.locator("#activity-panel-logs").waitFor({ state: "visible", timeout: WAIT_MS });
      expect(new URL(page.url()).searchParams.get("purpose")).toBe("agent_wake_step");

      // The URL carrying a filter and the list honouring it are two different
      // claims; the unfiltered list above shows all six purposes.
      await page.locator("[data-log-purpose]").first().waitFor({ state: "visible", timeout: WAIT_MS });
      expect(distinctPurposes(await purposeCells(page))).toEqual(["agent_wake_step"]);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);
});
