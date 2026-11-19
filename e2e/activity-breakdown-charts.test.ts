import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { SEED_MODELS, seedBreakdownCalls, seedKey } from "./helpers/breakdown-seed.js";

// Label boxes, card positions and overflow need a real layout; happy-dom has none.

let server: RunningServer;
const browser = browserForFile();

const TEST_TIMEOUT_MS = 30_000;
const WAIT_MS = 8_000;

/** A desktop window, a half pane's width, a phone. */
const WIDTHS = [1440, 720, 390] as const;

beforeAll(async () => {
  server = await startServer({ configured: true, seed: seedBreakdownCalls });
}, 60_000);

afterAll(() => server?.cleanup());

async function open(search: string, width: number): Promise<Page> {
  const phone = width < 600;
  const page = await browser.newPage({ viewport: { width, height: 1000 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  attachPageDiagnostics(page);
  // A locator that never resolves fails its own test, not the browser.
  page.setDefaultTimeout(WAIT_MS);
  await page.goto(`${server.baseUrl}/activity${search}`);
  return page;
}

interface Rect { left: number; top: number; right: number; bottom: number }

const apart = (a: Rect, b: Rect) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
const within = (inner: Rect, outer: Rect) =>
  inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;

describe("the speed map", () => {
  const placed = SEED_MODELS.filter((model) => model.ttftMs !== null);

  for (const width of WIDTHS) {
    test(`at ${width}px its labels sit inside it and apart, and nothing scrolls sideways`, async () => {
      const page = await open("?tab=breakdown", width);
      try {
        await page.locator("[data-speed-dot]").first().waitFor({ timeout: WAIT_MS });
        expect(await page.locator("[data-speed-dot]").count()).toBe(placed.length);
        expect(await page.locator("[data-speed-missing]").textContent()).toBe("Not on the chart (no first token): check-1");
        const layout = await page.evaluate(() => {
          const svg = document.querySelector('svg[aria-label="Speed"]')!;
          const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
          const dots = [...svg.querySelectorAll("[data-speed-dot] circle:not([fill='transparent'])")]
            .filter((circle) => !circle.getAttribute("fill"))
            .map((circle) => { const r = circle.getBoundingClientRect(); return { cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, r: r.width / 2 }; });
          const text = [...svg.querySelectorAll("[data-speed-label], [data-speed-hint]")].map(box);
          // Text over a dot reads as neither: the nearest point of each box
          // to each dot's centre is outside that dot.
          const covered = text.flatMap((t) => dots.filter((d) => {
            const x = Math.max(t.left, Math.min(d.cx, t.right));
            const y = Math.max(t.top, Math.min(d.cy, t.bottom));
            return Math.hypot(x - d.cx, y - d.cy) < d.r - 0.5;
          }).map((d) => `${Math.round(t.left)},${Math.round(t.top)} over ${Math.round(d.cx)},${Math.round(d.cy)}`));
          // The hint with the names: none of them over another.
          return { plot: box(svg), labels: text, covered };
        });
        expect(layout.covered).toEqual([]);
        // Most dots carry their name; the rest are named by their card.
        expect(layout.labels.length).toBeGreaterThanOrEqual(3);
        for (const [index, label] of layout.labels.entries()) {
          expect(within(label, layout.plot)).toBe(true);
          for (const other of layout.labels.slice(index + 1)) expect(apart(label, other)).toBe(true);
        }
        expect(await pageOverflow(page)).toEqual([]);
      } finally {
        await page.close();
      }
    }, TEST_TIMEOUT_MS);
  }

  test("on a phone the card of a dot at the edge stays inside the chart", async () => {
    const page = await open("?tab=breakdown", 390);
    try {
      // The slowest first token: the dot furthest right.
      const slowest = [...placed].sort((a, b) => (b.ttftMs ?? 0) - (a.ttftMs ?? 0))[0]!;
      const dot = page.locator(`[data-speed-dot="${seedKey(slowest)}"]`);
      await dot.waitFor({ timeout: WAIT_MS });
      await dot.focus();
      const card = page.locator(`[data-speed-card="${seedKey(slowest)}"]`);
      await card.waitFor({ timeout: WAIT_MS });
      const [cardBox, panelBox] = await Promise.all([
        card.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }),
        card.evaluate((el) => { const r = el.closest('[data-slot="section-panel"]')!.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })
      ]);
      expect(within(cardBox, panelBox)).toBe(true);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("on a phone a dot's first tap shows its card, the second opens its log", async () => {
    const page = await open("?tab=breakdown", 390);
    try {
      const model = SEED_MODELS.find((entry) => entry.model === "kite/mini-2")!;
      const dot = page.locator(`[data-speed-dot="${seedKey(model)}"]`);
      await dot.waitFor();
      await dot.tap();
      await page.locator(`[data-speed-card="${seedKey(model)}"]`).waitFor();
      expect(new URL(page.url()).searchParams.get("tab")).toBe("breakdown");
      await dot.tap();
      await page.locator("#activity-panel-logs").waitFor({ state: "visible" });
      expect(new URL(page.url()).searchParams.get("model")).toBe(model.model);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("a dot opens the log of its model, behind its provider", async () => {
    const page = await open("?tab=breakdown", 1440);
    try {
      // A model two providers serve, behind the one that serves others too:
      // the rows must drop both the other provider and the other models.
      const model = SEED_MODELS.find((entry) => entry.provider === "primary" && entry.model === "acme/swift-5")!;
      await page.locator(`[data-speed-dot="${seedKey(model)}"]`).click();
      await page.locator("#activity-panel-logs").waitFor({ state: "visible", timeout: WAIT_MS });
      const params = new URL(page.url()).searchParams;
      expect([params.get("provider"), params.get("model")]).toEqual([model.provider, model.model]);
      // The rows the server sent back, not only the url: a filter it dropped
      // shows the same model behind the other provider too.
      await page.locator("[data-log-row]").first().waitFor({ timeout: WAIT_MS });
      const rows = await page.locator("[data-log-row]").evaluateAll((nodes) => nodes.map((row) =>
        `${row.querySelector("[data-log-provider]")?.textContent} / ${row.querySelector("[data-log-model]")?.textContent}`));
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows)).toEqual(new Set([seedKey(model)]));
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe("the ranked lists", () => {
  for (const width of [720, 390] as const) {
    test(`at ${width}px every name shows whole and a list's bars start at one edge`, async () => {
      const page = await open("?tab=breakdown", width);
      try {
        await page.locator("[data-ranked-row]").first().waitFor();
        const lists = await page.locator("ul:has(> li > [data-ranked-row])").evaluateAll((uls) => uls.map((ul) =>
          [...ul.querySelectorAll<HTMLElement>("[data-ranked-row]")].map((row) => {
            const [name, track] = [...row.children] as HTMLElement[];
            return { name: name!.textContent, cut: name!.scrollWidth > name!.clientWidth, barLeft: Math.round(track!.getBoundingClientRect().left) };
          })));
        expect(lists.length).toBe(2);
        for (const rows of lists) {
          expect(rows.filter((row) => row.cut).map((row) => row.name)).toEqual([]);
          expect(new Set(rows.map((row) => row.barLeft)).size).toBe(1);
        }
      } finally {
        await page.close();
      }
    }, TEST_TIMEOUT_MS);
  }
});

describe("the folded table", () => {
  test("stays as the reader left it across a reload and a regrouping", async () => {
    const page = await open("?tab=breakdown", 1440);
    try {
      const fold = page.locator("[data-breakdown-fold]");
      await fold.waitFor({ timeout: WAIT_MS });
      expect(await fold.getAttribute("aria-expanded")).toBe("false");
      expect(await page.locator("table").count()).toBe(0);
      await fold.click();
      await page.locator("table").waitFor({ timeout: WAIT_MS });
      await page.reload();
      await page.locator("table").waitFor({ timeout: WAIT_MS });
      expect(await page.locator("[data-breakdown-fold]").getAttribute("aria-expanded")).toBe("true");
      await page.getByRole("button", { name: "Purpose", exact: true }).first().click();
      await page.locator("th", { hasText: "Purpose" }).waitFor({ timeout: WAIT_MS });
      expect(await page.locator("[data-breakdown-fold]").getAttribute("aria-expanded")).toBe("true");
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe("the day charts", () => {
  for (const width of WIDTHS) {
    test(`at ${width}px the three charts are drawn, their names apart, nothing scrolls sideways`, async () => {
      const page = await open("?tab=breakdown&group=day", width);
      try {
        await page.locator("[data-trend-chart]").first().waitFor({ timeout: WAIT_MS });
        const charts = await page.locator("[data-trend-chart]").evaluateAll((nodes) => nodes.map((chart) => {
          const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
          return {
            metric: chart.getAttribute("data-trend-chart"),
            drawn: [...chart.querySelectorAll("[data-trend-line]")].filter((line) => (line.getAttribute("d") ?? "") !== "").length,
            plot: box(chart.querySelector("svg")!),
            ends: [...chart.querySelectorAll("[data-trend-end]")].map(box),
            ticks: [...chart.querySelectorAll("[data-trend-tick]")].map(box)
          };
        }));
        expect(charts.map((chart) => chart.metric)).toEqual(["spend", "ttft", "failed"]);
        for (const chart of charts) {
          expect(chart.drawn).toBeGreaterThan(0);
          for (const tick of chart.ticks) expect(within(tick, chart.plot)).toBe(true);
          // A phone's plot has no room for them: the legend names the lines there.
          if (width < 480) expect(chart.ends.length).toBe(0);
          else expect(chart.ends.length).toBeGreaterThan(0);
          for (const [index, end] of chart.ends.entries()) {
            expect(within(end, chart.plot)).toBe(true);
            for (const other of chart.ends.slice(index + 1)) expect(apart(end, other)).toBe(true);
          }
        }
        expect(await pageOverflow(page)).toEqual([]);
      } finally {
        await page.close();
      }
    }, TEST_TIMEOUT_MS);
  }

  test("on a phone a day's first tap shows its card, the second opens its log", async () => {
    const page = await open("?tab=breakdown&group=day", 390);
    try {
      const days = page.locator('[data-trend-chart="failed"] [data-trend-day]');
      await days.first().waitFor();
      const day = days.nth(2);
      const date = await day.getAttribute("data-trend-day");
      await day.tap();
      await page.locator(`[data-trend-chart="failed"] [data-trend-card="${date}"]`).waitFor();
      expect(new URL(page.url()).searchParams.get("tab")).toBe("breakdown");
      await day.tap();
      await page.locator("#activity-panel-logs").waitFor({ state: "visible" });
      expect(new URL(page.url()).searchParams.get("day")).toBe(date);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("on a phone a day's card stays inside its chart, and the day opens its log", async () => {
    const page = await open("?tab=breakdown&group=day", 390);
    try {
      const days = page.locator('[data-trend-chart="spend"] [data-trend-day]');
      await days.first().waitFor({ timeout: WAIT_MS });
      const middle = days.nth(Math.floor((await days.count()) / 2));
      const date = await middle.getAttribute("data-trend-day");
      await middle.focus();
      const card = page.locator('[data-trend-chart="spend"] [data-trend-card]');
      await card.waitFor({ timeout: WAIT_MS });
      const inside = await card.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const p = el.closest('[data-slot="section-panel"]')!.getBoundingClientRect();
        return r.left >= p.left - 0.5 && r.right <= p.right + 0.5 && r.top >= p.top - 0.5 && r.bottom <= p.bottom + 0.5;
      });
      expect(inside).toBe(true);
      await page.keyboard.press("Enter");
      await page.locator("#activity-panel-logs").waitFor({ state: "visible", timeout: WAIT_MS });
      expect(new URL(page.url()).searchParams.get("day")).toBe(date);
      // Every call listed is from that day, the reader's day.
      await page.locator("[data-log-row]").first().waitFor({ timeout: WAIT_MS });
      const listed = await page.locator("[data-log-row] time").evaluateAll((nodes) => nodes.map((node) => {
        const at = new Date(node.getAttribute("datetime") ?? "");
        return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
      }));
      expect(listed.length).toBeGreaterThan(0);
      expect(new Set(listed)).toEqual(new Set([date!]));
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe("the log's model filter", () => {
  test("on a short phone screen (its keyboard up) the list fits, its search box on screen", async () => {
    // A phone with its keyboard open leaves about 400px; ten models and Any
    // would run past either side of the filter.
    const page = await browser.newPage({ viewport: { width: 390, height: 400 }, isMobile: true, hasTouch: true });
    attachPageDiagnostics(page);
    page.setDefaultTimeout(WAIT_MS);
    try {
      await page.goto(`${server.baseUrl}/activity?tab=logs`);
      await page.locator("[data-log-row]").first().waitFor();
      await page.getByRole("button", { name: "Model", exact: true }).tap();
      const input = page.getByPlaceholder("Search models…");
      await input.waitFor();
      const [inputBox, listBox] = await Promise.all([input.boundingBox(), page.locator("[cmdk-root]").boundingBox()]);
      expect(inputBox!.y).toBeGreaterThanOrEqual(0);
      expect(listBox!.y).toBeGreaterThanOrEqual(0);
      expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(400);
      // Across, inside the screen with a margin at either side; nothing scrolls sideways.
      expect(listBox!.x).toBeGreaterThanOrEqual(8);
      expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(390 - 8);
      expect(await pageOverflow(page)).toEqual([]);
      // What does not fit scrolls inside the list.
      expect(await page.locator("[cmdk-list]").evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);
});

