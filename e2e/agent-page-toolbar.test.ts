import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

/**
 * The page's bar on a phone with everything it can hold: its sources, its
 * scheduled updates and, while the user types, a new version waiting. Its
 * buttons go under the title rather than out of sight.
 */

let server: RunningServer;
let dataDir = "";
const browser = browserForFile();
const enc = (text: string) => new TextEncoder().encode(text);
const page = (n: number) => [{ path: "index.html", bytes: enc(`<h1>Today ${n}</h1><input id="q">`) }];

function publish(n: number): void {
  const store = new MandateStore(dataDir);
  try {
    new PageStore(store.db).publish(page(n), "seed");
  } finally {
    store.db.close();
  }
}

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed(dir) {
      dataDir = dir;
      const file = path.join(dir, "config.json");
      const config = (flatFromFile(JSON.parse(fs.readFileSync(file, "utf8"))) as unknown as Record<string, any>);
      config.agent = { ...config.agent, personalAgentName: "Juno" };
      fs.writeFileSync(file, JSON.stringify(fileFromFlat(config), null, 2));
      const store = new MandateStore(dir);
      try {
        new PageStore(store.db).publish(page(1), "seed");
        // A source that never comes due here, and a scheduled update.
        store.db.prepare("insert into agent_page_sources (name, position, run, every_ms, next_run_at, revision) values ('prom', 0, 'printf 1', 300000, '2099-01-01T00:00:00.000Z', 1)").run();
        store.db.prepare("insert into agent_page_updates (name, position, cron, task, next_run_at) values ('morning-summary', 0, '0 9 * * *', 'Sum up yesterday.', '2099-01-01T09:00:00.000Z')").run();
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => { server?.cleanup(); });

test("on a phone the page's bar keeps every button in sight while a new version waits", async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  const tab = await context.newPage();
  attachPageDiagnostics(tab);
  try {
    await tab.goto(`${server.baseUrl}/agent`);
    await tab.getByRole("tablist", { name: "View" }).getByRole("tab", { name: "Panel" }).click();
    const bar = tab.locator('[data-slot="page-toolbar"]');
    await bar.getByRole("button", { name: "Updates · 1" }).waitFor({ timeout: 15_000 });
    const inSight = () => bar.evaluate((el) => {
      const edge = el.getBoundingClientRect();
      return {
        overflows: el.scrollWidth > el.clientWidth,
        out: Array.from(el.querySelectorAll("button")).filter((b) => {
          const r = b.getBoundingClientRect();
          return r.left < edge.left || r.right > edge.right;
        }).map((b) => b.textContent)
      };
    });
    // One row while nothing waits.
    expect(await bar.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(44);
    // Typing in the page, a new version comes and waits.
    const frame = tab.frameLocator('[data-slot="agent-page"] [data-in-sight] iframe');
    await frame.locator("#q").click({ timeout: 15_000 });
    await frame.locator("#q").fill("typing");
    publish(2);
    await tab.evaluate(() => window.dispatchEvent(new CustomEvent("mandate:sse-open")));
    await bar.getByRole("button", { name: "New version — Reload" }).waitFor({ timeout: 15_000 });
    expect(await inSight()).toEqual({ overflows: false, out: [] });
  } finally {
    await context.close();
  }
}, 60_000);
