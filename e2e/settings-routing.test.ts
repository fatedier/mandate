import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";

// Settings › Routing: each route drawn as the chain it is tried in, edited
// in place; a route that is on saves each change as it is made, a route's
// own switch waits for its Save.
const browser = browserForFile();
let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const file = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.models.providers.openai.models = ["gpt-5.5", "gpt-5.5-mini", "gpt-5.5-nano"].map((id) => ({ id, input: ["text"], supportsReasoning: true }));
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
    }
  });
}, 60_000);

afterAll(() => {
  server?.cleanup();
});

async function savedDefault(): Promise<unknown> {
  const response = await fetch(`${server.baseUrl}/api/settings/config`);
  return ((await response.json()) as { models: { default: unknown } }).models.default;
}

const titles = (cards: import("playwright").Locator) => cards.evaluateAll((els) => els.map((el) => el.getAttribute("title")));

/** The default route as saved, once it is what is expected (each change saves on its own). */
async function savedDefaultBecomes(expected: unknown): Promise<unknown> {
  let saved: unknown;
  for (let i = 0; i < 40; i++) {
    saved = await savedDefault();
    if (JSON.stringify(saved) === JSON.stringify(expected)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return saved;
}

test("a step is added from +, moved earlier, given an effort, dragged back, each saved as it is made", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=routing`);
    const lane = page.locator('[data-route="default"]');
    const cards = lane.locator("[data-step]");
    await cards.first().waitFor();
    expect(await cards.count()).toBe(1);

    await lane.getByRole("button", { name: "Add a step" }).click();
    await page.locator('[role="menuitem"][data-ref="openai/gpt-5.5-mini"]').click();
    await cards.nth(1).waitFor();

    // A card is the editor's toggle.
    const editor = page.locator('[data-slot="step-editor"]');
    await cards.nth(1).click();
    await editor.waitFor();
    await cards.nth(1).click();
    await editor.waitFor({ state: "detached" });
    await cards.nth(1).click();
    await editor.getByRole("radio", { name: "High", exact: true }).click();
    await editor.getByRole("button", { name: "Earlier" }).click();
    // The editor stays with its step, now the first choice.
    await editor.getByText("First choice", { exact: true }).waitFor();
    await editor.getByRole("button", { name: "Done" }).click();
    await editor.waitFor({ state: "detached" });
    // Focus goes back to the card that was being edited.
    // (Radix moves it a task after the editor goes.)
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-step") === "0", null, { timeout: 2_000 });
    expect(await titles(cards)).toEqual(["openai/gpt-5.5-mini", "openai/gpt-5.5"]);

    // The browser's own drag and drop puts it back.
    await cards.nth(1).dragTo(cards.nth(0));
    expect(await titles(cards)).toEqual(["openai/gpt-5.5", "openai/gpt-5.5-mini"]);

    const expected = {
      model: "openai/gpt-5.5",
      reasoningEffort: "provider-default",
      modelFallbacks: [{ model: "openai/gpt-5.5-mini", reasoningEffort: "high" }]
    };
    expect(await savedDefaultBecomes(expected)).toEqual(expected);
    // Nothing is left to save.
    expect(await lane.getByRole("button", { name: "Save" }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("on a phone a chain runs top to bottom, each card and + the chain's width, each arrow reading if it fails; a card's × is there without a pointer", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${server.baseUrl}/settings?tab=routing`);
    const lane = page.locator('[data-route="default"]');
    await lane.locator("[data-step]").first().waitFor();
    await lane.getByRole("button", { name: "Add a step" }).tap();
    await page.locator('[role="menuitem"][data-ref="openai/gpt-5.5-nano"]').tap();
    await lane.locator("[data-step]").nth(1).waitFor();
    const seen = await lane.evaluate((root) => {
      const chain = root.querySelector('[data-slot="step-card"]')!.parentElement!.getBoundingClientRect();
      const boxes = Array.from(root.querySelectorAll('[data-slot="step-card"]')).map((el) => el.getBoundingClientRect());
      const arrow = root.querySelector<HTMLElement>('[data-slot="step-arrow"]')!;
      return {
        stacked: boxes[1]!.top >= boxes[0]!.bottom,
        fullWidth: [...boxes, root.querySelector('[aria-label="Add a step"]')!.getBoundingClientRect()].every((box) => Math.abs(box.width - chain.width) <= 1),
        arrow: arrow.innerText.trim()
      };
    });
    expect(seen).toEqual({ stacked: true, fullWidth: true, arrow: "if it fails" });
    expect(await pageOverflow(page)).toEqual([]);
    // No pointer to hover: the × is there, and takes the step away (asking first).
    const remove = lane.getByRole("button", { name: "Remove openai/gpt-5.5-nano" });
    expect(await remove.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await remove.tap();
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).tap();
    await lane.locator('[aria-label="Remove openai/gpt-5.5-nano"]').waitFor({ state: "detached" });
  } finally {
    await page.close();
  }
}, 30_000);

test("the dream gets a route of its own: switched on, its first step changed, saved, and still there after a reload; memory extraction's stays the default's", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=routing`);
    const lane = page.locator('[data-route="dream"]');
    await lane.locator('[data-slot="route-follows"]').waitFor();
    await page.locator('[data-route="extraction"] [data-slot="route-follows"]').waitFor();
    await lane.getByRole("switch", { name: "Own route for the dream" }).click();
    await lane.locator("[data-step]").first().click();
    const editor = page.locator('[data-slot="step-editor"]');
    await editor.getByLabel("Model").click();
    await page.locator('[role="menuitem"][data-ref="openai/gpt-5.5-nano"]').click();
    await editor.getByRole("button", { name: "Done" }).click();
    await lane.getByRole("button", { name: "Save" }).click();
    await lane.getByText("Saved", { exact: true }).waitFor();
    const saved = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as { agent: { dreamModel: { model: string }; extractionModel: { model: string }; modelOverrides: Record<string, boolean> } };
    expect(saved.agent.dreamModel.model).toBe("openai/gpt-5.5-nano");
    expect(saved.agent.modelOverrides.dream).toBe(true);
    // Memory extraction's route is not touched by it.
    expect(saved.agent.modelOverrides.extraction).toBe(false);
    expect(saved.agent.extractionModel.model).not.toBe("openai/gpt-5.5-nano");
    await page.reload();
    await lane.locator("[data-step]").first().waitFor();
    expect(await titles(lane.locator("[data-step]"))).toContain("openai/gpt-5.5-nano");
    expect(await page.locator('[data-route="extraction"] [data-slot="route-follows"]').count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("the subagents' lane says it is unset, gets a route of its own that a reload keeps, and is unset again when switched off", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = trackPageErrors(page);
  const read = async () => (await (await fetch(`${server.baseUrl}/api/settings/config`)).json()) as { agent: { subagentModel: { model: string }; modelOverrides: Record<string, boolean> } };
  try {
    await page.goto(`${server.baseUrl}/settings?tab=routing`);
    const lane = page.locator('[data-route="subagent"]');
    const unset = lane.locator('[data-slot="route-unset"]');
    await unset.waitFor();
    expect(await unset.textContent()).toBe("Not set: uses the model of the agent that asks.");
    expect(await lane.locator('[data-slot="route-follows"]').count()).toBe(0);
    await lane.getByRole("switch", { name: "Own route for subagents" }).click();
    await lane.locator("[data-step]").first().click();
    const editor = page.locator('[data-slot="step-editor"]');
    await editor.getByLabel("Model").click();
    await page.locator('[role="menuitem"][data-ref="openai/gpt-5.5-nano"]').click();
    await editor.getByRole("button", { name: "Done" }).click();
    await lane.getByRole("button", { name: "Save" }).click();
    await lane.getByText("Saved", { exact: true }).waitFor();
    const saved = await read();
    expect(saved.agent.subagentModel.model).toBe("openai/gpt-5.5-nano");
    expect(saved.agent.modelOverrides.subagent).toBe(true);
    await page.reload();
    await lane.locator("[data-step]").first().waitFor();
    expect(await titles(lane.locator("[data-step]"))).toContain("openai/gpt-5.5-nano");
    // Switched off and saved: unset again on the server, and the lane says so.
    await lane.getByRole("switch", { name: "Own route for subagents" }).click();
    await lane.getByRole("button", { name: "Save" }).click();
    let after = await read();
    for (let i = 0; i < 40 && after.agent.modelOverrides.subagent; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = await read();
    }
    expect(after.agent.modelOverrides.subagent).toBe(false);
    await unset.waitFor();
    expect(await lane.locator("[data-step]").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("a card's × shows on the pointer, asks first, and its step is gone from the saved route", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=routing`);
    const lane = page.locator('[data-route="default"]');
    await lane.locator("[data-step]").first().waitFor();
    if (await lane.locator("[data-step]").count() < 2) {
      await lane.getByRole("button", { name: "Add a step" }).click();
      await page.locator('[role="menuitem"][data-ref="openai/gpt-5.5-mini"]').click();
    }
    const remove = lane.getByRole("button", { name: "Remove openai/gpt-5.5-mini" });
    await page.mouse.move(0, 0);
    expect(await remove.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    await lane.locator('[data-step="1"]').hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="Remove openai/gpt-5.5-mini"]')!).opacity === "1");
    await remove.click();
    const dialog = page.getByRole("dialog");
    expect(await dialog.getByText("Remove openai/gpt-5.5-mini from the default route?").count()).toBe(1);
    await dialog.getByRole("button", { name: "Remove" }).click();
    const expected = { model: "openai/gpt-5.5", reasoningEffort: "provider-default", modelFallbacks: [] };
    expect(await savedDefaultBecomes(expected)).toEqual(expected);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
