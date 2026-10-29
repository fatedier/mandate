import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { trackRequests } from "./helpers/settle.js";

// Every scroller in the app draws the same thin bar (or none, where a row
// fades instead): the sidebar drew the browser's own wide bar with its track.
const browser = browserForFile();
let server: RunningServer;
beforeAll(async () => {
  server = await startServer({
    configured: true,
    // The providers list checks the keyed provider: a closed local port
    // answers at once, inside the container, not the real OpenAI with the
    // placeholder key.
    seed(dataDir) {
      const configFile = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
      config.models.providers.openai.baseURL = "http://127.0.0.1:9/v1";
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }
  });
}, 60_000);
afterAll(() => server?.cleanup());

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
