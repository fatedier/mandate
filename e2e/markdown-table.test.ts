import { expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";

// A markdown table in the chat keeps its words whole and, when it cannot fit,
// scrolls sideways in its own box. The chat's text breaks anywhere (so a long
// link wraps), and the table inherited that: every column could shrink to one
// letter, the table squeezed into the column and its scroller never engaged —
// on a phone "change" took 6 lines, and 20 of 24 cells split a word.
const browser = browserForFile();

const TABLE = [
  "Two files changed:",
  "",
  "| file | change | reason | owner | status | risk | reviewed | notes |",
  "|---|---|---|---|---|---|---|---|",
  "| `expiry.go` | +8 −4 | one timer guards every sweep | acmecorp | done | low | yes | merged into the release branch after the whole test-suite run |",
  "| `storage.go` | +21 −3 | sweep loop exits on expiry | acmecorp | in review | medium | no | 需要再跑一次压力测试 |",
  "",
  "| step | note |",
  "|---|---|",
  "| 1 | Run the race detector again on the release branch before tagging, then compare the benchmark numbers against the last release |",
  "| 2 | `go test -race -count=20 -run TestCacheExpiry -timeout 10m ./pkg/rendering/pagecaching/cache/... ./engine/...` |",
  "",
  "Next: a https://github.com/acmecorp/project-1/blob/rel/pkg/util/text/some/really/long/path/that/keeps/going/text_test.go link still wraps."
].join("\n");

/** Latin words in the table's cells that break across lines, and whether the
 *  table scrolls in its own box rather than overflowing the page. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const table = [...document.querySelectorAll("table")].find((t) => t.textContent?.includes("one timer guards"))!;
    const split: string[] = [];
    let words = 0;
    for (const cell of table.querySelectorAll("th, td")) {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        for (const match of node.data.matchAll(/[A-Za-z0-9+\-−._]+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
          words++;
          if (lines.size > 1) split.push(match[0]);
        }
      }
    }
    // Scrolls, not merely overflows: moved sideways, it moves. (A box that
    // overflows without scrolling would be clipped by the transcript.)
    const scroller = table.parentElement!;
    const start = scroller.scrollLeft;
    scroller.scrollLeft = start + 40;
    // Hidden overflow moves under a script too, but not under a finger.
    const moved = scroller.scrollLeft > start && ["auto", "scroll"].includes(getComputedStyle(scroller).overflowX);
    scroller.scrollLeft = start;
    const main = document.querySelector("main")!;
    const link = [...document.querySelectorAll("a")].find((a) => a.textContent?.includes("text_test.go"));
    // A table that fits once its prose wraps does wrap, and does not scroll.
    const fitting = [...document.querySelectorAll("table")].find((t) => t.textContent?.includes("race detector again"))!;
    const note = [...fitting.querySelectorAll("td")].find((td) => td.textContent?.includes("race detector again"))!;
    const noteRange = document.createRange();
    noteRange.selectNodeContents(note);
    // Its code too: a long command made of words wraps between them.
    const command = fitting.querySelector("td code")!;
    return {
      headers: table.querySelectorAll("th").length,
      words,
      split,
      tableScrolls: moved,
      pageOverflows: main.scrollWidth > main.clientWidth + 1,
      linkLines: link ? new Set([...link.getClientRects()].map((rect) => Math.round(rect.top))).size : 0,
      fittingScrolls: fitting.parentElement!.scrollWidth > fitting.parentElement!.clientWidth,
      noteLines: new Set([...noteRange.getClientRects()].map((rect) => Math.round(rect.top))).size,
      commandLines: new Set([...command.getClientRects()].map((rect) => Math.round(rect.top))).size
    };
  });
}

test("on a phone a chat table keeps its words whole and scrolls sideways in its own box", async () => {
  const fixture = startWorkspaceFixture();
  fixture.appendMessage(TABLE);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
    await page.getByRole("tab", { name: "Chat", exact: true }).first().tap();
    await page.locator("table", { hasText: "one timer guards" }).waitFor();
    const seen = await measure(page);
    expect(seen.headers).toBe(8);
    expect(seen.words).toBeGreaterThan(40);
    expect(seen.split).toEqual([]);
    expect(seen.tableScrolls).toBe(true);
    expect(seen.pageOverflows).toBe(false);
    // Outside the table the text still breaks anywhere: the long link wraps.
    expect(seen.linkLines).toBeGreaterThan(1);
    expect(seen.fittingScrolls).toBe(false);
    expect(seen.noteLines).toBeGreaterThan(1);
    expect(seen.commandLines).toBeGreaterThan(1);
    await page.locator("table", { hasText: "one timer guards" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifactDir("markdown-table"), "phone.png") });
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("in the worker panel at a half split a chat table keeps its words whole", async () => {
  const fixture = startWorkspaceFixture();
  fixture.appendMessage(TABLE);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.getByRole("tab", { name: "Chat", exact: true }).click();
    await panel.locator("table", { hasText: "one timer guards" }).waitFor();
    const seen = await measure(page);
    expect(seen.headers).toBe(8);
    expect(seen.split).toEqual([]);
    expect(seen.tableScrolls).toBe(true);
    expect(seen.pageOverflows).toBe(false);
    expect(seen.fittingScrolls).toBe(false);
    expect(seen.noteLines).toBeGreaterThan(1);
    expect(seen.commandLines).toBeGreaterThan(1);
    await panel.locator("table", { hasText: "one timer guards" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifactDir("markdown-table"), "panel.png") });
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

/**
 * Long cells in a phone-width box. The table above scrolls because its words
 * stay whole; this one would still fit with its words whole, squeezed until a
 * notes cell ran to ten lines in the phone's 358px column. In a box under
 * 30rem a cell wider than 22ch keeps 28ch, so the table scrolls at readable
 * columns. In a wider box (the half-split panel, the worker page) nothing
 * gets a minimum and the table fills its box as before.
 */
const LONG_CELLS = [
  "The fixes:",
  "",
  "| PR | Area | Change | Notes |",
  "| --- | --- | --- | --- |",
  "| #22 | cache | A project-2 cache expiry now clears the whole page index | Anyone running project-1 with a short cache TTL will see reloads instead of a stale page; the old behaviour hid the expiry and left half-built pages |",
  "| #39 | settings | Import rejects empty files | Breaks setups that relied on an empty settings file; the release notes should say how to write one |",
  "",
  "| 模块 | 说明 |",
  "| --- | --- |",
  "| 页面 | 缓存过期以后会看到重载，而不是一直显示的旧页；旧行为会把过期藏起来，留下半建的页 |",
  "",
  "| 分类 | 主要用途 | 命令 |",
  "| --- | --- | --- |",
  "| **文件与搜索** | 读取项目文件、搜索文件内容，修改指定目录中的文件和子目录 | `file_content_search`、`file_content_read`、`folder_search`、`folder_get` |"
].join("\n");

/** The long-cell tables: box, scrolling, each cell's width (its inner box where it has one), min-width and lines, and 28ch in px. */
async function longCells(page: Page) {
  return page.evaluate(() => {
    const find = (text: string) => [...document.querySelectorAll("table")].find((t) => t.textContent?.includes(text))!;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;width:28ch;font-size:14px";
    find("cache TTL").appendChild(probe);
    const ch28 = probe.getBoundingClientRect().width;
    probe.remove();
    const shape = (table: HTMLTableElement) => {
      const box = table.parentElement!;
      const lineHeight = parseFloat(getComputedStyle(table).lineHeight);
      return {
        boxWidth: box.clientWidth,
        tableWidth: Math.round(table.getBoundingClientRect().width),
        scrolls: box.scrollWidth > box.clientWidth + 1,
        cells: [...table.querySelectorAll("td")].map((td) => ({
          text: td.textContent ?? "",
          width: (td.firstElementChild ?? td).getBoundingClientRect().width,
          minWidth: getComputedStyle(td.firstElementChild ?? td).minWidth,
          lines: Math.round((td.getBoundingClientRect().height - 8) / lineHeight),
          // The text's own lines (a cell is as tall as its row's tallest).
          textLines: (() => {
            const range = document.createRange();
            range.selectNodeContents(td);
            return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
          })()
        }))
      };
    };
    // What a copy of the table carries: its rows, cells apart by tabs.
    const range = document.createRange();
    range.selectNodeContents(find("cache TTL"));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const copied = selection.toString().split("\n").filter(Boolean);
    selection.removeAllRanges();
    return { ch28, wide: shape(find("cache TTL")), chinese: shape(find("缓存过期以后")), labels: shape(find("文件与搜索")), copied };
  });
}

test("on a phone a long cell keeps 28ch and its table scrolls; short cells stay narrow", async () => {
  const fixture = startWorkspaceFixture();
  fixture.appendMessage(LONG_CELLS);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
    await page.getByRole("tab", { name: "Chat", exact: true }).first().tap();
    await page.locator("table", { hasText: "cache TTL" }).waitFor();
    const { ch28, wide, chinese, labels, copied } = await longCells(page);
    await page.locator("table", { hasText: "cache TTL" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifactDir("markdown-table"), "phone-long-cells.png") });
    expect(wide.boxWidth).toBeLessThan(480);
    expect(wide.scrolls).toBe(true);
    expect(wide.cells.find((c) => c.text.startsWith("Anyone running"))!.width).toBeGreaterThanOrEqual(ch28 - 1);
    expect(Math.max(...wide.cells.map((c) => c.lines))).toBeLessThanOrEqual(5);
    expect(wide.cells.find((c) => c.text === "#22")!.width).toBeLessThan(ch28 / 2);
    // A short Han label stays on one line, beside long cells that take their minimum.
    expect(labels.cells.find((c) => c.text === "文件与搜索")!.textLines).toBe(1);
    // A Han cell counts double: these 39 characters are long.
    expect(chinese.cells.find((c) => c.text.startsWith("缓存过期"))!.width).toBeGreaterThanOrEqual(ch28 - 1);
    // Copied, each row is one line with its cells tab-separated.
    expect(copied).toEqual(["PR\tArea\tChange\tNotes", expect.stringMatching(/^#22\tcache\tA project-2/), expect.stringMatching(/^#39\tsettings\tImport/)]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

// Both boxes are 30rem or more and lay out alike; the panel is the one nearest
// the threshold.
for (const where of ["panel"] as const) {
  test(`in a box of 30rem or more (the ${where === "panel" ? "half-split worker panel" : "worker page"}) a long-cell table fills its box as before`, async () => {
    const fixture = startWorkspaceFixture();
    fixture.appendMessage(LONG_CELLS);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(5000);
    try {
      if (where === "panel") {
        await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
        await page.locator('[data-slot="worker-panel"]').getByRole("tab", { name: "Chat", exact: true }).click();
      } else {
        await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
        await page.getByRole("tab", { name: "Chat", exact: true }).first().click();
      }
      await page.locator("table", { hasText: "cache TTL" }).waitFor();
      const { wide, chinese, copied } = await longCells(page);
      expect(wide.boxWidth).toBeGreaterThanOrEqual(480);
      expect(copied[0]).toBe("PR\tArea\tChange\tNotes");
      expect(copied).toHaveLength(3);
      expect(wide.scrolls).toBe(false);
      expect(Math.abs(wide.tableWidth - wide.boxWidth)).toBeLessThanOrEqual(1);
      for (const cell of [...wide.cells, ...chinese.cells]) expect(cell.minWidth).toBe("0px");
    } finally {
      await page.close();
      fixture.stop();
    }
  }, 20_000);
}
