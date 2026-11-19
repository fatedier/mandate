// Settings › Routing as rows: every lane closed, and one open, at a full and
// a half pane and on a phone, nothing wider than the screen. Pictures for a
// look are taken when MANDATE_E2E_CAPTURE_FRAMES=1.
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { browserForFile } from "./helpers/browser.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { look, trackPageErrors } from "./helpers/page-diagnostics.js";
import { openLane } from "./helpers/routing.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

const browser = browserForFile();
let server: RunningServer;

const step = (model: string, reasoningEffort = "provider-default") => ({ model, reasoningEffort });

beforeAll(async () => {
  server = await startServer({
    configured: true,
    // Routes of their own on three lanes (one a chain of three), Decisions on.
    seed: (dataDir) => {
      const file = path.join(dataDir, "config.json");
      const config = (flatFromFile(JSON.parse(fs.readFileSync(file, "utf8"))) as Record<string, any>);
      config.models.providers.openai.models = ["gpt-5.5", "gpt-5.5-mini", "gpt-5.5-nano"].map((id) => ({ id, input: ["text"], supportsReasoning: true }));
      config.models.providers.anthropic = {
        type: "anthropic",
        apiKey: "not-a-real-key",
        models: ["claude-opus-4-5", "claude-sonnet-4-5"].map((id) => ({ id, input: ["text"], supportsReasoning: true }))
      };
      config.models.default = { ...step("anthropic/claude-sonnet-4-5"), modelFallbacks: [step("openai/gpt-5.5")] };
      config.agent.personalModel = step("anthropic/claude-opus-4-5", "high");
      config.agent.personalModelFallbacks = [step("anthropic/claude-sonnet-4-5"), step("openai/gpt-5.5")];
      config.agent.workerModel = step("openai/gpt-5.5", "high");
      config.agent.workerModelFallbacks = [step("anthropic/claude-sonnet-4-5")];
      config.agent.dreamModel = step("openai/gpt-5.5");
      config.agent.dreamModelFallbacks = [];
      config.agent.decisionsEnabled = true;
      config.agent.decisionsModel = step("openai/gpt-5.5-nano");
      config.agent.decisionsModelFallbacks = [step("openai/gpt-5.5-mini")];
      config.agent.managerRequestCheckEnabled = true;
      config.agent.managerStopCheckEnabled = true;
      config.agent.memoryRepeatCheckEnabled = true;
      fs.writeFileSync(file, JSON.stringify(fileFromFlat(config), null, 2));
    }
  });
}, 60_000);

afterAll(() => server?.cleanup());

test("the Routing rows at a full and a half pane and on a phone, closed and with one open", async () => {
  for (const [width, name] of [[1440, "desktop"], [720, "half"], [390, "phone"]] as const) {
    const phone = width < 600;
    // Tall enough for the whole page in one picture.
    const page = await browser.newPage({ viewport: { width, height: phone ? 1300 : 1100 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    const errors = trackPageErrors(page);
    try {
      await page.goto(`${server.baseUrl}/settings?tab=routing`);
      await page.locator('[data-route="toolReviewSecondLook"] [data-slot="section-summary"]').waitFor();
      expect(await page.locator('[data-route] button[aria-expanded="true"]').count()).toBe(0);
      expect(await pageOverflow(page)).toEqual([]);
      await look(page, name);
      await openLane(page, "worker");
      await page.locator('[data-route="worker"] [data-step]').first().waitFor();
      expect(await pageOverflow(page)).toEqual([]);
      await look(page, `${name}-open`);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }
}, 90_000);

test("a search hit on a lane scrolls to its row and tints it over the panel", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } });
  // Less motion: the flash is a steady tint while it lasts, read at once.
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await page.goto(`${server.baseUrl}/settings?tab=routing`);
    await page.locator('[data-route="toolReviewSecondLook"] [data-slot="section-summary"]').waitFor();
    await page.getByRole("combobox", { name: "Search settings" }).fill("memory extraction route");
    await page.keyboard.press("Enter");
    const row = page.locator('[data-route="extraction"] [data-slot="section-header"]');
    await page.locator('[data-route="extraction"] [data-slot="section-header"][data-setting-flash]').waitFor();
    // The jump scrolls smoothly: the row is read once the scroll has brought
    // it into view (the tint lasts 1.4 s), and never if it does not.
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-route="extraction"] [data-slot="section-header"]')!.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight;
    }, null, { timeout: 1000 });
    const seen = await row.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + 4, box.top + box.height / 2);
      return { tint: getComputedStyle(el).backgroundColor, inView: box.top >= 0 && box.bottom <= innerHeight, onTop: el.contains(top) };
    });
    expect(seen.tint).not.toBe("rgba(0, 0, 0, 0)");
    expect([seen.inView, seen.onTop]).toEqual([true, true]);
    // The jump does not open the row.
    expect(await row.locator("button[aria-expanded]").getAttribute("aria-expanded")).toBe("false");
  } finally {
    await page.close();
  }
}, 30_000);
