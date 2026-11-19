import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";

/**
 * A report's pictures through the compiled server: on a desktop a picture in
 * the report's panel tab opens over the whole page, pages with the arrow keys
 * (round to the first), and Esc closes it leaving the report's tab; a picture
 * in a link to a picture opens there too; on a phone the report comes up over
 * the chat and a picture over it, which × closes, leaving the report.
 */

const browser = browserForFile();
let server: RunningServer;
let threadId = "";
let canvasId = "";

beforeAll(async () => {
  // Pictures with a size worth showing, made from the app's own icon.
  const icon = new Uint8Array(fs.readFileSync("assets/pwa/icon-512.png"));
  const png = async (width: number, height: number) => new Bun.Image(icon).resize(width, height).png().bytes();
  const [a, b, bFull, c] = await Promise.all([png(640, 400), png(320, 200), png(1280, 800), png(640, 400)]);
  server = await startServer({
    configured: true,
    label: "report-pictures",
    seed(dataDir) {
      const store = new MandateStore(dataDir);
      try {
        const thread = new AgentStore(store.db).createManagerThread("Garden planner check");
        threadId = thread.id;
        const canvases = new CanvasStore(store.db, dataDir);
        const canvas = canvases.create({ title: "Garden planner screens", scope: "manager", scopeId: thread.id, threadId: thread.id });
        canvasId = canvas.id;
        const shots = path.join(path.dirname(canvas.filePath), "shots");
        fs.mkdirSync(shots, { recursive: true });
        fs.writeFileSync(path.join(shots, "a.png"), a);
        fs.writeFileSync(path.join(shots, "b.png"), b);
        fs.writeFileSync(path.join(shots, "b-full.png"), bFull);
        fs.writeFileSync(path.join(shots, "c.png"), c);
        canvases.writeSource(canvas.id, [
          "<h1>Garden planner screens</h1>",
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">',
          '<figure><img id="a" src="shots/a.png" style="width:100%"><figcaption>a Bed added and saved</figcaption></figure>',
          '<figure><a href="shots/b-full.png"><img id="b" src="shots/b.png" style="width:100%"></a><figcaption>b Cleared bed shows empty</figcaption></figure>',
          '<figure><img id="c" src="shots/c.png" alt="c Bad sowing date blocked" style="width:100%"></figure>',
          '<p><img id="icon" src="shots/a.png" width="16"> an icon</p>',
          "</div>"
        ].join(""));
        if (canvases.publishSource(canvas.id).error) throw new Error("canvas did not publish");
        new AgentStore(store.db).appendMessage({
          threadId: thread.id, role: "assistant", source: "self",
          content: { type: "assistant", text: `The check is done: [the report](/canvas/${canvas.id}).` }
        });
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => { server?.cleanup(); });

async function open(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport, ...(viewport.width < 768 ? { hasTouch: true, isMobile: true } : {}) });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}/threads/${threadId}`);
  const link = page.locator(`a[href="/canvas/${canvasId}"]`).first();
  await link.waitFor({ timeout: 15_000 });
  await link.click();
  return page;
}

const report = (page: Page) => page.frameLocator('iframe[title="Garden planner screens"]');
const lightbox = (page: Page) => page.locator('[role="dialog"]').filter({ has: page.locator('[data-slot="lightbox-count"]') });
const counter = (page: Page) => page.locator('[data-slot="lightbox-count"]');
const shownSrc = (page: Page) => lightbox(page).locator("img").getAttribute("src");
const still = (page: Page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), undefined, { timeout: 5_000 });

test("desktop: a report's picture opens over the whole page, pages round with the arrow keys, and Esc leaves the report's tab", async () => {
  const page = await open({ width: 1440, height: 900 });
  try {
    await report(page).locator("#a").waitFor({ timeout: 15_000 });
    // The icon is no picture to open.
    await report(page).locator("#icon").click();
    expect(await counter(page).count()).toBe(0);
    await report(page).locator("#a").click();
    await counter(page).waitFor({ timeout: 5_000 });
    expect(await counter(page).textContent()).toBe("1 / 3 · a Bed added and saved");
    // Over the whole window, not the panel (once it has grown in).
    await still(page);
    const box = await lightbox(page).boundingBox();
    expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([1440, 900]);
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('[role="dialog"] img');
      return img !== null && img.complete && img.naturalWidth === 640;
    }, undefined, { timeout: 5_000 });
    await look(page, "desktop");
    await page.keyboard.press("ArrowRight");
    expect(await counter(page).textContent()).toBe("2 / 3 · b Cleared bed shows empty");
    // The picture in a link to a picture: the full one.
    expect(await shownSrc(page)).toContain("shots/b-full.png");
    await page.keyboard.press("ArrowRight");
    expect(await counter(page).textContent()).toBe("3 / 3 · c Bad sowing date blocked");
    await page.keyboard.press("ArrowRight");
    expect(await counter(page).textContent()).toBe("1 / 3 · a Bed added and saved");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('[data-slot="lightbox-count"]') === null, undefined, { timeout: 5_000 });
    // The report's tab is still open, beside the chat.
    expect(await page.locator(`[data-canvas-tab="${canvasId}"]`).getAttribute("aria-selected")).toBe("true");
    expect(new URL(page.url()).pathname).toBe(`/threads/${threadId}`);
    // The linked picture opens here too, not in a new tab.
    const tabs = page.context().pages().length;
    await report(page).locator("#b").click();
    await counter(page).waitFor({ timeout: 5_000 });
    expect(await counter(page).textContent()).toBe("2 / 3 · b Cleared bed shows empty");
    expect(page.context().pages().length).toBe(tabs);
  } finally {
    await page.close();
  }
}, 90_000);

test("phone: the report over the chat, a picture over it full screen; × closes the picture and leaves the report", async () => {
  const page = await open({ width: 390, height: 844 });
  try {
    await report(page).locator("#a").click();
    await counter(page).waitFor({ timeout: 10_000 });
    await still(page);
    const box = await lightbox(page).boundingBox();
    expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([390, 844]);
    await look(page, "phone");
    await lightbox(page).getByRole("button", { name: "Close" }).click();
    await page.waitForFunction(() => document.querySelector('[data-slot="lightbox-count"]') === null, undefined, { timeout: 5_000 });
    expect(await page.locator('[role="dialog"][aria-label="Canvas"]').count()).toBe(1);
  } finally {
    await page.close();
  }
}, 60_000);
