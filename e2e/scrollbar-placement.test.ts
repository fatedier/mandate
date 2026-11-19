import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { look, trackPageErrors } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { trackRequests } from "./helpers/settle.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

/**
 * Every scrollbar runs at the edge of the region it scrolls, and every one is
 * the same faint thumb. A manager thread wrapped its whole conversation in a
 * centred 55rem box and Settings capped its frame, so their scrollers were the
 * reading column itself and the bar floated beside the text, some 170px in from
 * the pane's edge. The thumb was the border colour, far louder than a
 * scrollbar should be. Classic scrollbars, so
 * the bars take width as they do with a mouse or "always show".
 */

const browser = browserForFile({ ignoreDefaultArgs: ["--hide-scrollbars"] });
let server: RunningServer;
let threadId = "";

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed(dataDir) {
      // The providers list checks the keyed provider: a closed local port
      // answers at once, inside the container, not the real OpenAI with the
      // placeholder key.
      const configFile = path.join(dataDir, "config.json");
      const config = (flatFromFile(JSON.parse(fs.readFileSync(configFile, "utf8"))) as unknown as Record<string, any>);
      config.models.providers.openai.baseURL = "http://127.0.0.1:9/v1";
      fs.writeFileSync(configFile, JSON.stringify(fileFromFlat(config), null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        threadId = agent.latestManagerThread("Release checklist").id;
        for (let i = 0; i < 16; i++) {
          const ask = agent.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: `Question ${i + 1}: what does the nightly job keep?` } });
          const wake = agent.createWake({ threadId, reason: "user", triggerMessageId: ask.id });
          agent.appendMessage({ threadId, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "It keeps the last seven days of build cache and removes the rest, at night, so it never competes with a build. ".repeat(3) } });
          agent.finishWake(wake.id, "finished");
        }
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);
afterAll(() => server?.cleanup());

/** A scroller's right edge against the pane's: main's box less its own gutter. */
function edgeOf(page: Page, scroller: string) {
  return page.evaluate((scroller) => {
    const main = document.querySelector("main")!;
    const el = (scroller === "transcript"
      ? document.querySelector('[data-slot="transcript-column"]')!.parentElement
      : [...main.querySelectorAll<HTMLElement>("*")].find((node) => {
          const style = getComputedStyle(node);
          return ["auto", "scroll"].includes(style.overflowY) && node.scrollHeight > node.clientHeight;
        }))!;
    const box = el.getBoundingClientRect();
    return {
      paneRight: Math.round(main.getBoundingClientRect().left + main.clientLeft + main.clientWidth),
      right: Math.round(box.right),
      bar: el.offsetWidth - el.clientWidth - el.clientLeft * 2,
      scrolls: el.scrollHeight > el.clientHeight,
      color: getComputedStyle(el).scrollbarColor
    };
  }, scroller);
}

for (const [scheme, thumb] of [["dark", "rgba(255, 255, 255, 0.06)"], ["light", "rgba(0, 0, 0, 0.07)"]] as const) {
  test(`a thread's chat bar runs at the pane's edge, a faint thumb on a clear track (${scheme})`, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const errors = trackPageErrors(page);
    try {
      await page.goto(`${server.baseUrl}/threads/${threadId}`);
      await page.locator('[data-slot="transcript-row"]').last().waitFor();
      const seen = await edgeOf(page, "transcript");
      await look(page, `thread-${scheme}`);
      // A real bar, taking width: the case the edge is about.
      expect([seen.scrolls, seen.bar > 0]).toEqual([true, true]);
      expect(seen.right).toBe(seen.paneRight);
      expect(seen.color).toBe(`${thumb} rgba(0, 0, 0, 0)`);
      // One rule for every scroller: the sidebar's list and the page's own too.
      const others = await page.evaluate(() => [
        getComputedStyle(document.querySelector("[data-slot='app-nav'] [class*='overflow-y-auto']")!).scrollbarColor,
        getComputedStyle(document.querySelector("main")!).scrollbarColor
      ]);
      expect(others).toEqual([seen.color, seen.color]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
}

test("Settings' bar runs at the pane's edge, its search box over the same column as its sections", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings`);
    await page.locator('[data-slot="settings-section"]').first().waitFor();
    const seen = await edgeOf(page, "settings");
    await look(page, "settings");
    expect([seen.scrolls, seen.bar > 0]).toEqual([true, true]);
    expect(seen.right).toBe(seen.paneRight);
    const columns = await page.evaluate(() => {
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; };
      return {
        search: box(document.querySelector('input[placeholder="Search settings…"]')!),
        section: box(document.querySelector('[data-slot="settings-section"]')!)
      };
    });
    // Still a reading column, not the full pane.
    expect(columns.section[1]! - columns.section[0]!).toBeLessThan(900);
    expect(columns.search).toEqual(columns.section);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

// Every scroller in the app draws the same thin bar (or none, where a row
// fades instead): the sidebar drew the browser's own wide bar with its track.
// The bar's width is a style, the same with classic scrollbars as without.

/** Every element that can scroll, with how its bar is drawn. */
const scrollers = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")]
  .filter((el) => {
    const style = getComputedStyle(el);
    return ["auto", "scroll"].includes(style.overflowY) || ["auto", "scroll"].includes(style.overflowX);
  })
  .map((el) => ({ at: `${el.tagName.toLowerCase()}${el.dataset.slot ? `[data-slot=${el.dataset.slot}]` : ""}.${[...el.classList].slice(0, 3).join(".")}`, width: getComputedStyle(el).scrollbarWidth })));

/** What each page draws once its own code (which can come after the load)
 *  is in. */
const READY: Record<string, string> = {
  "/": "text=What should we work on?",
  "/settings?tab=providers": '[data-slot="settings-section"]',
  "/memory": 'nav[aria-label="Memory views"]'
};

test("every scroller on the main pages draws a thin bar or none", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const requests = await trackRequests(page);
  try {
    const wide: Array<{ at: string; width: string }> = [];
    for (const path of Object.keys(READY)) {
      await page.goto(`${server.baseUrl}${path}`);
      await page.locator(READY[path]!).first().waitFor();
      await requests.idle();
      const found = await scrollers(page);
      expect(found.length).toBeGreaterThan(0);
      wide.push(...found.filter((s) => s.width !== "thin" && s.width !== "none"));
    }
    // The sidebar's nav list is among them.
    await page.goto(`${server.baseUrl}/`);
    await requests.idle();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("[data-slot='app-nav'] [class*='overflow-y-auto']")!).scrollbarWidth)).toBe("thin");
    expect(wide).toEqual([]);
  } finally {
    await page.close();
  }
});
