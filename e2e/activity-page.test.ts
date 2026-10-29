import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { MandateStore } from "../src/server/app/store.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { pageOverflow } from "./helpers/page-overflow.js";

// Layout needs a real browser; happy-dom does not measure visibility or overflow.

let server: RunningServer;
const browser = browserForFile();

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
 * `agent_wake_step` dominates, as wake steps do in any log, and the rare ones
 * are pinned to fixed early indices so every one of them is on the first page
 * the log renders.
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
        id, purpose, scope_type, scope_id, provider, provider_name, model,
        request_hash, response_hash, metadata_json,
        input_tokens, output_tokens, total_tokens, cache_read_tokens,
        status, error_json, started_at, finished_at, latency_ms,
        created_at, updated_at
      ) values (?, ?, ?, 'thread-e2e', ?, ?, ?,
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
        providerNameFor(index),
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

/** The connection a call was made through, stored with it as the app stores it. */
function providerNameFor(index: number): string {
  return index % 5 === 4 ? "direct-codex" : "team-proxy";
}

function metadataFor(index: number): Record<string, unknown> {
  const phase = index % 2 === 0 ? "delivering" : "planning";
  return { phase, providerName: providerNameFor(index) };
}

beforeAll(async () => {
  server = await startServer({ configured: true, seed: seedActivityCalls });
});

afterAll(async () => {
  server?.cleanup();
});

/** Use a fresh browser context so each case starts with the default layout. */
async function openActivity(search = "", viewport = { width: 1280, height: 900 }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}/activity${search}`);
  return page;
}

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
    // A failed page of older calls is the inline error where the next page
    // would be: its reason, and Retry.
    const retry = page.locator('[data-slot="inline-error"]').getByRole("button", { name: "Retry", exact: true });
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
  // 375 and 1280 sit either side of the row's one container breakpoint;
  // wider viewports only make it roomier.
  for (const width of [375, 1280]) {
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
            const reason = row.querySelector("[data-log-reason]");
            return {
              reason: reason?.textContent ?? null,
              // A failed call's reason stays inside the info column.
              reasonInside: !reason || (reason.getBoundingClientRect().right <= infoBox.right + 0.5 && reason.clientWidth > 0),
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
          "direct-codex", "team-proxy"
        ]);
        expect(rows.every((row) => row.visible && row.inside && row.separate)).toBe(true);
        expect(rows.every((row) => row.modelScroll <= row.modelWidth)).toBe(true);
        // The seed's two failures, each with the provider's own reason.
        expect(rows.flatMap((row) => row.reason ? [row.reason] : [])).toEqual([
          "Our servers are currently overloaded. Please try again later. (500)",
          "Our servers are currently overloaded. Please try again later. (500)"
        ]);
        expect(rows.every((row) => row.reasonInside)).toBe(true);
        expect(await pageOverflow(page)).toEqual([]);
      } finally {
        await page.close();
      }
    }, TEST_TIMEOUT_MS);
  }

  // The detail panel's fields fill three columns, as written for it; the
  // grid asked itself, which a container query never does, so they stood in
  // one column with two thirds of the card empty. Its cards share
  // one left edge, and a short JSON section shows its chevron like a long one
  // (it could be folded with nothing saying so).
  test("a call's detail lays its fields in three columns, its cards on one left edge", async () => {
    const page = await openActivity("?tab=logs", { width: 1280, height: 900 });
    try {
      await page.locator("[data-log-row]").filter({ has: page.locator("[data-log-reason]") }).first().click();
      const panel = page.locator("[data-call-detail]");
      await panel.locator("[data-call-fields]").waitFor({ timeout: WAIT_MS });
      const seen = await panel.evaluate((root) => {
        const fields = [...root.querySelectorAll("[data-call-fields] > div:not(.col-span-full)")];
        const left = (selector: string) => root.querySelector(selector)!.getBoundingClientRect().left;
        const chevron = root.querySelector("section details summary svg")!;
        return {
          fields: fields.length,
          columns: new Set(fields.map((field) => Math.round(field.getBoundingClientRect().left))).size,
          errorLabel: left("[data-call-error] .label-micro"),
          fieldLabel: left("[data-call-fields] .label-micro"),
          chevronLeft: chevron.getBoundingClientRect().left,
          chevronVisible: getComputedStyle(chevron).visibility === "visible"
        };
      });
      expect(seen.fields).toBeGreaterThanOrEqual(3);
      expect(seen.columns).toBe(3);
      expect(Math.abs(seen.errorLabel - seen.fieldLabel)).toBeLessThan(1);
      expect(Math.abs(seen.chevronLeft - seen.fieldLabel)).toBeLessThan(1);
      expect(seen.chevronVisible).toBe(true);
      // And it says which state the section is in: turned down while open,
      // right once folded, down again when unfolded.
      const summary = panel.locator("section details summary").first();
      // Tailwind 4's rotate-90 sets the `rotate` property, not `transform`.
      const turned = () => summary.locator("svg").first().evaluate((el) => getComputedStyle(el).rotate);
      await page.waitForTimeout(250);
      expect(await turned()).toBe("90deg");
      await summary.click();
      await page.waitForTimeout(250);
      expect(await turned()).toBe("none");
      await summary.click();
      await page.waitForTimeout(250);
      expect(await turned()).toBe("90deg");
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

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
 *  measure. A missing container is also the mutation the unit test covers,
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
 * holding on each side of those edges. Spend is in every tier, after Calls.
 */
const CORE_COLUMNS = ["Provider / model", "Calls", "Spend", "p50", "p95", "Failed"];
const MID_COLUMNS = [...CORE_COLUMNS, "Input", "Cache"];
const ALL_COLUMNS = [
  "Provider / model", "Calls", "Spend", "p50", "p95", "p99", "max",
  "Failed", "Fallback", "Input", "Cache", "Output"
];

/** Container-query edges with the app's 16px root font size. */
const TIER_2_EDGE_PX = 52 * 16;
const TIER_1_EDGE_PX = 40 * 16;
const STACK_EDGE_PX = 28 * 16;

/** Stacked: only the first column's head, which names the grouping, and in
 *  every row the core figures below the name, each led by its column's name
 *  and each whole (a short cell never wraps). On `maxLines` lines: one from
 *  just under the stacking edge, and on a phone, with Spend among them, they
 *  may take a second line rather than overflow. */
async function expectStacked(page: Page, maxLines = 1) {
  expect(await breakdownHeadings(page)).toEqual(CORE_COLUMNS.slice(0, 1));
  const rows = await page.locator("tbody tr").evaluateAll((rows) => rows.map((row) => {
    const [name, ...figures] = [...row.querySelectorAll("td")].filter((cell) => cell.getClientRects().length > 0);
    const nameBottom = name!.getBoundingClientRect().bottom;
    return {
      labels: figures.map((cell) => getComputedStyle(cell, "::before").content),
      below: figures.every((cell) => cell.getBoundingClientRect().top >= nameBottom - 0.5),
      whole: figures.every((cell) => cell.getBoundingClientRect().height < parseFloat(getComputedStyle(cell).lineHeight) * 1.5),
      lines: new Set(figures.map((cell) => Math.round(cell.getBoundingClientRect().top))).size
    };
  }));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.labels).toEqual(CORE_COLUMNS.slice(1).map((name) => `"${name}"`));
    expect(row.below).toBe(true);
    expect(row.whole).toBe(true);
    expect(row.lines).toBeLessThanOrEqual(maxLines);
  }
}

/** The page has the window to itself (no chat dock beside it), so the tiers
 *  are reached with the window's width: narrow with the sidebar expanded is the
 *  core tier, and with it collapsed, 780px is the middle tier and 984px the
 *  full one. These are the container widths the old equal split produced at
 *  1512px and 1920px. Assert the actual container band as well as its columns. */
const NARROW_VIEWPORT = { width: 868, height: 900 };
const MID_VIEWPORT = { width: 780, height: 900 };
const WIDE_VIEWPORT = { width: 984, height: 900 };

async function openBreakdown(search: string, viewport = MID_VIEWPORT, sidebarCollapsed = true) {
  const page = await browser.newPage({ viewport });
  attachPageDiagnostics(page);
  await page.addInitScript((sidebarCollapsed) => {
    localStorage.setItem("mandate.ui", JSON.stringify({
      state: { sidebarCollapsed, sidebarWidth: 224 }, version: 0
    }));
  }, sidebarCollapsed);
  await page.goto(`${server.baseUrl}/activity${search}`);
  await page.locator("table").first().waitFor({ timeout: WAIT_MS });
  return page;
}

describe("the breakdown", () => {
  test("a narrow window with the expanded sidebar keeps the core columns readable", async () => {
    const page = await openBreakdown("?tab=breakdown", NARROW_VIEWPORT, false);
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

  test("changing the grouping changes the first column and nothing else", async () => {
    // Two readings of one window are only comparable if the figures beside the
    // key do not move. Read at the mid tier, so seven columns are on screen to
    // disagree rather than five.
    const page = await openBreakdown("?tab=breakdown", MID_VIEWPORT);
    try {
      await page.getByRole("button", { name: "Scope type", exact: true }).click();
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
      // The name truncates inside its button: overflow on the button itself
      // would clip its touch area.
      expect(await name.locator("span").first().evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      expect(await detail.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      expect(await breakdownHeadings(page)).toEqual(MID_COLUMNS);
      await expectBreakdownFits(page);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  // The table kept a 34rem floor and scrolled sideways, so a
  // phone's 358px column held the names and not one figure. Below 28rem each
  // group stacks instead: its name, then its figures, each under its own label.
  test("a phone shows every group's figures under its name, without scrolling sideways", async () => {
    const page = await openActivity("?tab=breakdown", { width: 375, height: 900 });
    try {
      await page.locator("table").waitFor({ timeout: WAIT_MS });
      expect(await breakdownContainerWidth(page)).toBeLessThan(STACK_EDGE_PX);
      await expectStacked(page, 2);
      await expectBreakdownFits(page);
      expect(await pageOverflow(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  // The header line says "Group by"; the answer on screen is named by its own
  // grouping's column head, which stacking keeps, so a regrouping still in
  // flight does not leave it under the newly pressed button's name.
  test("on a phone a regrouping in flight leaves the answer named by its own grouping", async () => {
    const page = await openActivity("?tab=breakdown", { width: 375, height: 900 });
    try {
      await page.locator("table").waitFor({ timeout: WAIT_MS });
      await page.route("**/api/activity/summary?*group=purpose*", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await route.continue().catch(() => {});
      });
      await page.getByRole("button", { name: "Purpose", exact: true }).click();
      // Both copies of the picker press it; the wide one is display:none here.
      await page.locator('[role="group"][aria-label="Group by"] button[aria-pressed="true"]', { hasText: "Purpose" })
        .first().waitFor({ state: "attached", timeout: WAIT_MS });
      expect(await breakdownHeadings(page)).toEqual(["Provider / model"]);
      expect(await page.locator("tbody button").first().textContent()).toContain(" / ");
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  // An 820px window: a 520px section, under the old floor by
  // 24px, which cut the red Failed column in half. From 28rem up it is the
  // table, and the core columns fit it.
  test("the table stacks below 28rem and is a table that fits from there up", async () => {
    const page = await openBreakdown("?tab=breakdown", WIDE_VIEWPORT);
    try {
      for (const width of [520, 449, 448, 447]) {
        await page.locator("table").evaluate((table, width) => {
          let node = table.parentElement!;
          while (!node.classList.contains("@container")) node = node.parentElement!;
          node.style.width = `${width}px`;
        }, width);
        expect(await breakdownContainerWidth(page)).toBe(width);
        if (width < STACK_EDGE_PX) await expectStacked(page);
        else expect(await breakdownHeadings(page)).toEqual(CORE_COLUMNS);
        await expectBreakdownFits(page);
      }
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


// The four totals over the daily chart wrapped 3+1 on a phone, leaving the
// cache hit rate alone on a line. Narrow, the spend has the first line to
// itself and the rest are two by two: calls beside failed, input tokens
// beside the hit rate (a share of that input). Between, when the spend and
// the four do not fit one line, the four move down together; wide, one line.
describe("the overview's totals", () => {
  /** The spend's longest second line (every part in it), whatever the seed
   *  priced: what decides whether the five fit one line. */
  const LONGEST_SPEND = { micros: 12_400_000, reportedMicros: 8_100_000, estimated: true, pricedCalls: 40, unpricedCalls: 3, includedCalls: 120, includedApiMicros: 0, pendingCalls: 1234 };

  async function totals(viewport: { width: number; height: number }) {
    const page = await browser.newPage({ viewport });
    attachPageDiagnostics(page);
    await page.route("**/api/activity/summary?*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.spend = LONGEST_SPEND;
      await route.fulfill({ response, json: payload });
    });
    await page.goto(`${server.baseUrl}/activity`);
    try {
      await page.getByText("$8.10 reported · 3 calls unpriced · 120 included · 1,234 calls not priced yet").waitFor({ timeout: WAIT_MS });
      await page.locator('[data-slot="activity-total"]').first().waitFor({ timeout: WAIT_MS });
      return await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-slot="activity-total"]')].map((el) => {
        const box = el.getBoundingClientRect();
        // The section's panel clips what passes its edges, so a tile past
        // them, or a line in it that cannot wrap, shows as clipped rather
        // than as overflow of the page: each is measured against the panel.
        const panel = el.closest('[data-slot="section-panel"]')!.getBoundingClientRect();
        const inside = box.left >= panel.left - 0.5 && box.right <= panel.right + 0.5
          && [el, ...el.querySelectorAll("*")].every((node) => node.scrollWidth <= node.clientWidth + 0.5 && node.getBoundingClientRect().right <= panel.right + 0.5);
        return { label: el.children[1]!.textContent!, top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), inside };
      }));
    } finally {
      await page.close();
    }
  }

  test("on a phone the spend has a line of its own, then they are two by two, each pair on its own line", async () => {
    const [spend, ...shown] = await totals({ width: 390, height: 844 });
    expect(spend!.label).toBe("spend");
    expect([spend, ...shown].every((t) => t!.inside)).toBe(true);
    expect(shown.map((t) => t.label.split(" ")[0])).toEqual(["calls", "failed", "input", "cache"]);
    expect(shown.every((t) => t.top > spend!.top)).toBe(true);
    expect(spend!.left).toBe(shown[0]!.left);
    expect(shown[0]!.top).toBe(shown[1]!.top);
    expect(shown[2]!.top).toBe(shown[3]!.top);
    expect(shown[2]!.top).toBeGreaterThan(shown[0]!.top);
    expect(shown[0]!.left).toBe(shown[2]!.left);
    expect(shown[1]!.left).toBe(shown[3]!.left);
    // Two columns, left to right: calls and input first.
    expect(shown[1]!.left).toBeGreaterThan(shown[0]!.left);
  }, TEST_TIMEOUT_MS);

  // A pane of a 1440px screen split in two.
  test("in a 600px window the four that follow the spend stay on one line together", async () => {
    const [spend, ...shown] = await totals({ width: 600, height: 900 });
    expect(spend!.label).toBe("spend");
    expect([spend, ...shown].every((t) => t!.inside)).toBe(true);
    expect(new Set(shown.map((t) => t.top)).size).toBe(1);
    expect(shown[0]!.top).toBeGreaterThanOrEqual(spend!.top);
  }, TEST_TIMEOUT_MS);

  test("on a wide screen they share one line", async () => {
    const shown = await totals({ width: 1280, height: 900 });
    expect(shown.every((t) => t.inside)).toBe(true);
    expect(new Set(shown.map((t) => t.top)).size).toBe(1);
  }, TEST_TIMEOUT_MS);
});
