// Settings: the tool-call review's switch and the user's rules in General ›
// Agents, saved with the section and still there after a reload (its two
// routes in Routing: tests/client/settings-judgement-routes.test.tsx).
// Pictures of each at desktop and phone width, for a look, are taken when
// MANDATE_E2E_CAPTURE_FRAMES=1.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { look, trackPageErrors } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

const browser = browserForFile();
let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    configured: true,
    // Decisions with a chat model: the review's second look has one to run on.
    seed: (dataDir) => {
      const file = path.join(dataDir, "config.json");
      const config = flatFromFile(JSON.parse(fs.readFileSync(file, "utf8"))) as unknown as { agent: Record<string, unknown> };
      config.agent.decisionsEnabled = true;
      config.agent.decisionsModel = { model: "openai/gpt-5.5", reasoningEffort: "provider-default" };
      config.agent.decisionsModelFallbacks = [];
      fs.writeFileSync(file, JSON.stringify(fileFromFlat(config), null, 2));
    }
  });
}, 60_000);

afterAll(() => server?.cleanup());

const RULES = "Agents may push their own feature branches.\nAlways ask me before anything touches production.";

async function openPage(width: number): Promise<Page> {
  const phone = width < 600;
  return browser.newPage({ viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
}

test("the review is turned on with the user's rules, saved with Agents and still there after a reload", async () => {
  const page = await openPage(1440);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=general`);
    const toggle = page.getByRole("switch", { name: "Review tool calls" });
    await toggle.waitFor();
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    expect(await page.getByRole("textbox", { name: "Your rules" }).count()).toBe(0);
    await look(page, "general-off-desktop");

    await toggle.click();
    await page.getByRole("textbox", { name: "Your rules" }).fill(RULES);
    const section = page.locator('[data-slot="settings-section"]').filter({ hasText: "Delegation preferences" });
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/settings/config") && response.request().method() === "POST");
    await section.getByRole("button", { name: "Save" }).click();
    expect((await saved).status()).toBe(200);

    await page.reload();
    const after = page.getByRole("switch", { name: "Review tool calls" });
    await after.waitFor();
    expect(await after.getAttribute("aria-checked")).toBe("true");
    expect(await page.getByRole("textbox", { name: "Your rules" }).inputValue()).toBe(RULES);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

// After the test above turned the review on.
test("the switch and the rules read at desktop and phone width", async () => {
  for (const [width, name] of [[1440, "general-on-desktop"], [390, "general-on-phone"]] as const) {
    const page = await openPage(width);
    try {
      await page.goto(`${server.baseUrl}/settings?tab=general`);
      const rules = page.getByRole("textbox", { name: "Your rules" });
      await rules.waitFor();
      // The field stays inside the page: nothing scrolls sideways.
      expect(await pageOverflow(page)).toEqual([]);
      const box = await rules.boundingBox();
      expect(box !== null && box.width > 0 && box.x >= 0 && box.x + box.width <= width).toBe(true);
      await look(page, name);
    } finally {
      await page.close();
    }
  }
}, 90_000);
