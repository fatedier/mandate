import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";

// Decision models and manager request check in Settings: a custom provider's model
// marked as a decision model in Providers, then Decisions and Manager request check
// set up in Routing. Nothing here asks a model: the provider's address is a
// closed local port.
const browser = browserForFile();
let server: RunningServer;

const FLASH = "provider-1/deepseek/deepseek-flash";
const JUDGE = "provider-1/vendor/judge-1";

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const file = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.models.providers["provider-1"] = {
        type: "openai-compatible",
        baseURL: "http://127.0.0.1:9/v1",
        apiKey: "not-a-real-key",
        models: [{ id: "deepseek/deepseek-flash", input: ["text"] }, { id: "vendor/judge-1", input: ["text"] }]
      };
      // The default route falls back to deepseek-flash: it cannot become a decision model.
      config.models.default.modelFallbacks = [{ model: FLASH, reasoningEffort: "provider-default" }];
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
    }
  });
}, 60_000);

afterAll(() => {
  server?.cleanup();
});

type SavedConfig = {
  models: { providers: Record<string, { models: Array<{ id: string; kind?: string }> }> };
  agent: Record<string, unknown> & { modelOverrides: Record<string, boolean> };
};

async function saved(): Promise<SavedConfig> {
  const response = await fetch(`${server.baseUrl}/api/settings/config`);
  return (await response.json()) as SavedConfig;
}

/** The saved config, once `ready` holds of it (each change saves on its own). */
async function savedWhen(ready: (config: SavedConfig) => boolean): Promise<SavedConfig> {
  let config = await saved();
  for (let i = 0; i < 40 && !ready(config); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    config = await saved();
  }
  return config;
}

test("a custom provider's model is marked a decision model; one the default route uses cannot be", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=providers&provider=provider-1`);
    const dialog = page.getByRole("dialog");

    // The fallback's model: Decision model is off, and says why.
    await page.locator('[data-model-row="deepseek/deepseek-flash"] button').first().click();
    expect(await dialog.getByRole("radio", { name: "Decision model" }).isDisabled()).toBe(true);
    await dialog.getByText("In use by Routing (fallback). Change that first.").waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });

    await page.locator('[data-model-row="vendor/judge-1"] button').first().click();
    await dialog.getByRole("radio", { name: "Decision model" }).click();
    await dialog.getByText("Answers typed questions through OpenRouter's Decisions API instead of chatting. Only Decisions can use it.").waitFor();
    expect([await dialog.getByText("Protocol", { exact: true }).count(), await dialog.getByRole("switch", { name: "Reasoning" }).count()]).toEqual([0, 0]);
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.locator('[data-model-row="vendor/judge-1"]').getByText("Decision model", { exact: true }).waitFor();
    const config = await savedWhen((c) => c.models.providers["provider-1"]!.models.some((m) => m.kind === "decision"));
    expect(config.models.providers["provider-1"]!.models.map((m) => [m.id, m.kind ?? "chat"])).toEqual([["deepseek/deepseek-flash", "chat"], ["vendor/judge-1", "decision"]]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("Decisions is given the decision model and switched on; Manager request check then uses it, and the agents' menus never list it", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=routing`);
    const decisions = page.locator('[data-route="decisions"]');
    const managerRequestCheck = page.locator('[data-route="managerRequestCheck"]');
    await decisions.locator("[data-step]").first().waitFor();
    await managerRequestCheck.getByText("Off: Your agent hears when the whole thread stops.").waitFor();

    // A fresh chain asks for a model: the decision model is picked, and has no effort.
    await decisions.locator("[data-step]").first().click();
    const editor = page.locator('[data-slot="step-editor"]');
    await editor.getByRole("button", { name: "Model" }).click();
    await page.locator(`[role="menuitem"][data-ref="${JUDGE}"]`).click();
    expect(await editor.getByText("Reasoning effort").count()).toBe(0);
    await editor.getByRole("button", { name: "Done" }).click();
    await decisions.locator("[data-step]").first().getByText("provider-1 · Decision model").waitFor();

    await decisions.getByRole("switch", { name: "Decisions on" }).click();
    await managerRequestCheck.getByText("Not set: uses Decisions.").waitFor();
    const config = await savedWhen((c) => c.agent.decisionsEnabled === true);
    expect([config.agent.decisionsEnabled, (config.agent.decisionsModel as { model: string }).model]).toEqual([true, JUDGE]);

    // An agent's menu leaves it out: the default route's + has nothing left
    // to add, and a step's model menu lists every chat model but it.
    const defaultLane = page.locator('[data-route="default"]');
    expect(await defaultLane.getByRole("button", { name: "Add a step" }).isDisabled()).toBe(true);
    await defaultLane.locator("[data-step]").first().click();
    await editor.getByRole("button", { name: "Model" }).click();
    await page.locator(`[role="menuitem"][data-ref="${FLASH}"]`).waitFor();
    expect(await page.locator(`[role="menuitem"][data-ref="${JUDGE}"]`).count()).toBe(0);
    await page.keyboard.press("Escape");
    await editor.getByRole("button", { name: "Done" }).click();
    await editor.waitFor({ state: "detached" });

    // Manager request check's own route starts from Decisions' chain and saves as its own.
    await managerRequestCheck.getByRole("switch", { name: "Own route for manager request check" }).click();
    await managerRequestCheck.getByRole("button", { name: "Save" }).click();
    const own = await savedWhen((c) => c.agent.modelOverrides.managerRequestCheck === true);
    expect([own.agent.modelOverrides.managerRequestCheck, (own.agent.managerRequestCheckModel as { model: string }).model]).toEqual([true, JUDGE]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("on a phone Decisions and each use of it fit the screen, each with its switches", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${server.baseUrl}/settings?tab=routing`);
    const decisions = page.locator('[data-route="decisions"]');
    await decisions.locator("[data-step]").first().waitFor();
    await decisions.scrollIntoViewIfNeeded();
    expect(await pageOverflow(page)).toEqual([]);
    await page.locator('[data-route="managerStopCheck"]').scrollIntoViewIfNeeded();
    expect(await pageOverflow(page)).toEqual([]);
    await page.locator('[data-route="memoryRepeatCheck"]').scrollIntoViewIfNeeded();
    expect(await pageOverflow(page)).toEqual([]);
    // Each lane, and every switch in its header, inside the screen.
    const outside = await page.evaluate(() => ["decisions", "managerRequestCheck", "managerStopCheck", "memoryRepeatCheck"].flatMap((route) => {
      const lane = document.querySelector(`[data-route="${route}"]`)!;
      return [lane, ...lane.querySelectorAll('[role="switch"]')]
        .filter((el) => { const box = el.getBoundingClientRect(); return box.left < 0 || box.right > window.innerWidth; })
        .map((el) => `${route}: ${el.getAttribute("aria-label") ?? "lane"}`);
    }));
    expect(outside).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
