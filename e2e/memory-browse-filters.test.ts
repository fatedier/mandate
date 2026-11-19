import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BrowserContextOptions } from "playwright";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";

// Browse's filters on a phone took four rows: five selects wrapped 2+2+1 and
// the search sat half-width on a row of its own. They keep to one row now,
// scrolling sideways and fading at the edge that has more, and the search
// fills the row under them. Where there is room nothing changes: one line,
// the search at its end.
const browser = browserForFile();
let server: RunningServer;
beforeAll(async () => { server = await startServer({ configured: true }); }, 60_000);
afterAll(async () => { server?.cleanup(); });

async function filters(options: BrowserContextOptions) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  await page.goto(`${server.baseUrl}/memory?view=browse`);
  await page.locator('input[aria-label="Search memories"]').waitFor();
  const shape = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-slot="memory-filters"]')!;
    const selects = [...row.querySelectorAll<HTMLElement>('[data-slot="select-trigger"]')].map((el) => el.getBoundingClientRect());
    const search = document.querySelector<HTMLElement>('input[aria-label="Search memories"]')!.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    return {
      tops: [...new Set(selects.map((r) => Math.round(r.top)))],
      selectsBottom: Math.max(...selects.map((r) => r.bottom)),
      overflows: row.scrollWidth > row.clientWidth + 0.5,
      more: row.dataset.more ?? null,
      mask: style.maskImage || style.webkitMaskImage,
      rowLeft: box.left,
      rowRight: box.right,
      search: { top: search.top, left: search.left, right: search.right, width: search.width },
      lastSelectRight: Math.max(...selects.map((r) => r.right)),
      // A touch 4px above and below the first select, inside its 44px touch
      // area: the row's overflow must not cut that area off.
      touchEdges: (() => {
        const first = row.querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
        const r = first.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const lands = (y: number) => document.elementFromPoint(x, y)?.closest('[data-slot="select-trigger"]') === first;
        return { above: lands(r.top - 4), below: lands(r.bottom + 4) };
      })()
    };
  });
  await context.close();
  return { shape, errors };
}

test("on a phone the four filters are one sideways-scrolling row that fades at its right edge, and the search fills the row below", async () => {
  const { shape, errors } = await filters({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  expect(shape.tops).toHaveLength(1);
  expect(shape.overflows).toBe(true);
  expect(shape.more).toBe("right");
  expect(shape.mask).toContain("linear-gradient");
  expect(shape.touchEdges).toEqual({ above: true, below: true });
  // Under the selects, as wide as the content: from the row's left edge to
  // its right (the row reaches 4px past each side for the focus rings).
  expect(shape.search.top).toBeGreaterThan(shape.selectsBottom);
  expect(Math.abs(shape.search.left - (shape.rowLeft + 4))).toBeLessThan(1);
  expect(Math.abs(shape.search.right - (shape.rowRight - 4))).toBeLessThan(1);
  expect(errors).toEqual([]);
});

test("on a wide screen the filters and the search share one line, the search at its end, nothing faded", async () => {
  const { shape, errors } = await filters({ viewport: { width: 1440, height: 900 } });
  expect(shape.tops).toHaveLength(1);
  expect(shape.overflows).toBe(false);
  expect(shape.more).toBe(null);
  expect(shape.mask === "none" || shape.mask === "").toBe(true);
  expect(Math.abs(shape.search.top - shape.tops[0]!)).toBeLessThan(2);
  expect(shape.search.left).toBeGreaterThan(shape.lastSelectRight);
  expect(errors).toEqual([]);
});

// Between the two (an 870px window, the content about 570px), nothing changes
// either: the selects and the search wrap as one line of items, the search
// beside Sort on the second line, as before the narrow row existed.
test("in a window just wide enough, the selects and the search wrap together, the search beside the last select", async () => {
  // 870, not 900: four selects (Status went) fit one line at
  // 900; the content is about 570px here, still above the 34rem narrow row.
  const context = await browser.newContext({ viewport: { width: 870, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  await page.goto(`${server.baseUrl}/memory?view=browse`);
  await page.locator('input[aria-label="Search memories"]').waitFor();
  const shape = await page.evaluate(() => {
    const selects = [...document.querySelectorAll<HTMLElement>('[data-slot="memory-filters"] [data-slot="select-trigger"]')];
    const search = document.querySelector<HTMLElement>('input[aria-label="Search memories"]')!.getBoundingClientRect();
    const sort = selects[selects.length - 1]!.getBoundingClientRect();
    return { lines: new Set(selects.map((el) => Math.round(el.getBoundingClientRect().top))).size, sortTop: sort.top, searchTop: search.top, searchLeft: search.left, sortRight: sort.right };
  });
  await context.close();
  expect(shape.lines).toBe(2);
  expect(Math.abs(shape.searchTop - shape.sortTop)).toBeLessThan(2);
  expect(shape.searchLeft).toBeGreaterThan(shape.sortRight);
  expect(errors).toEqual([]);
});

// Tabbing along the phone's row brings each select clear of the fade, ring
// and all, rather than leaving it half under the edge.
test("on a phone, tabbing along the filters scrolls each select clear of the fade", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  await page.goto(`${server.baseUrl}/memory?view=browse`);
  await page.locator('input[aria-label="Search memories"]').waitFor();
  await page.locator('[data-slot="memory-filters"] [data-slot="select-trigger"]').first().focus();
  const clear = () => page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-slot="memory-filters"]')!;
    const focused = document.activeElement as HTMLElement;
    const box = row.getBoundingClientRect();
    const r = focused.getBoundingClientRect();
    const atStart = row.scrollLeft <= 0.5;
    const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 0.5;
    // Clear of a fade on each side that has one (24px), inside the row.
    return { label: focused.getAttribute("aria-label"), left: r.left >= box.left + (atStart ? 0 : 24) - 0.5, right: r.right <= box.right - (atEnd ? 0 : 24) + 0.5 };
  });
  const seen: Array<{ label: string | null; left: boolean; right: boolean }> = [];
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("Tab");
    seen.push(await clear());
  }
  await context.close();
  expect(seen).toEqual(["Type", "Source", "Sort"].map((label) => ({ label, left: true, right: true })));
  expect(errors).toEqual([]);
});
