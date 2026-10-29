import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { waitUntil } from "../tests/helpers/wait.js";

/**
 * Your agent's page in a real browser: it is given the app's colors and
 * fonts, they follow a theme switch in place, and the page's own styles win.
 */

const PAGE = `<title>Today</title>
<h1 id="head">Today</h1>
<p id="note" style="color: var(--mandate-muted)">Two things wait on you.</p>
<p id="own" style="color: rgb(1, 2, 3)">Its own color.</p>`;

let server: RunningServer;
const browser = browserForFile();

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed(dataDir) {
      // Named, so the agent's page opens rather than its first-run setup.
      const file = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.agent = { ...config.agent, globalAgentName: "Juno" };
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        new PageStore(store.db).publish(PAGE, "seed");
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => {
  server?.cleanup();
});

interface Painted { bg: string; fg: string; note: string; own: string; font: string; scheme: string; marker: number | null }

test("the page takes the app's colors and fonts, follows a theme switch in place, and keeps its own", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
  try {
    const page = await context.newPage();
    attachPageDiagnostics(page);
    await page.goto(`${server.baseUrl}/agent`);
    const frame = page.frameLocator('[data-slot="agent-page"] iframe');
    await frame.locator("#head").waitFor({ timeout: 15_000 });
    const painted = () => frame.locator("html").evaluate((): Painted => {
      const of = (el: Element) => getComputedStyle(el);
      return {
        bg: of(document.body).backgroundColor,
        fg: of(document.body).color,
        note: of(document.getElementById("note")!).color,
        own: of(document.getElementById("own")!).color,
        font: of(document.body).fontFamily,
        scheme: of(document.documentElement).colorScheme,
        marker: (window as unknown as { __marker?: number }).__marker ?? null
      };
    });
    // The dark theme's tokens (globals.css).
    const dark = await painted();
    expect(dark).toMatchObject({ bg: "rgb(20, 20, 22)", fg: "rgb(237, 237, 240)", note: "rgb(161, 161, 170)", own: "rgb(1, 2, 3)", scheme: "dark" });
    expect(dark.font).toContain("-apple-system");

    // Light, in the same document: no reload.
    await frame.locator("html").evaluate(() => { (window as unknown as { __marker: number }).__marker = 1; });
    await page.emulateMedia({ colorScheme: "light" });
    await waitUntil(async () => (await painted()).bg === "rgb(255, 255, 255)", { label: "the light ground", timeout: 5000 });
    expect(await painted()).toMatchObject({ bg: "rgb(255, 255, 255)", fg: "rgb(26, 26, 28)", note: "rgb(95, 95, 104)", own: "rgb(1, 2, 3)", scheme: "light", marker: 1 });
  } finally {
    await context.close();
  }
}, 60_000);
