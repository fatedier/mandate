import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";

// Settings › Providers: a list whose rows open a page per provider, with
// the browser's Back between them; a check that lists the provider's
// models; a model's protocol chosen in its dialog and saved.

const browser = browserForFile();
let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  // The provider: an OpenAI-compatible endpoint that lists two models.
  stub = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "model-a" }, { id: "gpt-5.5" }] });
      }
      return new Response("not here", { status: 404 });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const file = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.models.providers.openai.type = "openai-compatible";
      config.models.providers.openai.baseURL = `http://127.0.0.1:${stub.port}/v1`;
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
    }
  });
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

const providerParam = (url: string) => new URL(url).searchParams.get("provider");

test("a row opens the provider's page, which says the check's answer; the browser's Back returns to the list", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=providers`);
    const row = page.locator('[data-provider-row="openai"]');
    await row.getByText("Ready").waitFor();
    await row.click();
    await page.locator('[data-slot="provider-page"]').waitFor();
    expect(providerParam(page.url())).toBe("openai");
    await page.locator('[data-slot="provider-check"]').getByText("Ready — the key works and 2 models are listed.").waitFor();
    await page.goBack();
    await page.locator('[data-provider-row="openai"]').waitFor();
    expect(providerParam(page.url())).toBeNull();
    expect(await page.locator('[data-slot="provider-page"]').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("a model's protocol chosen in its dialog is saved by its Save, before the dialog closes; no save bar is left", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=providers&provider=openai`);
    await page.locator('[data-model-row="gpt-5.5"] button').first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /Messages/ }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.waitFor({ state: "detached" });
    // Closed means saved: no polling.
    const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
    const saved = (settings.models.providers.openai.models as Array<Record<string, unknown>>).find((m) => m.id === "gpt-5.5");
    expect(saved).toMatchObject({ id: "gpt-5.5", protocol: "messages" });
    await page.locator('[data-model-row="gpt-5.5"]').getByText("Messages").waitFor();
    // The row's name is what it shows, its tags included, not its id alone.
    await page.getByRole("button", { name: /^Edit gpt-5\.5\b.*Messages/ }).waitFor();
    expect(await page.locator('[data-slot="provider-save-bar"]').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("on a phone: rows are a thumb tall, and an edit's Save is on screen", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=providers`);
    const row = page.locator('[data-provider-row="openai"]');
    await row.waitFor();
    expect(Math.round((await row.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
    await row.tap();
    await page.getByRole("textbox", { name: "Base URL" }).fill("http://127.0.0.1:9/v1");
    const save = page.locator('[data-slot="provider-save-bar"]').getByRole("button", { name: "Save" });
    await save.waitFor();
    const box = (await save.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(box.y).toBeGreaterThanOrEqual(0);
  } finally {
    await context.close();
  }
});

test("the default model cannot be removed: its menu's Remove is off and says what uses it", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=providers&provider=openai`);
    await page.getByRole("button", { name: "Actions for gpt-5.5" }).click();
    const remove = page.getByRole("menuitem", { name: "Remove" });
    expect(await remove.getAttribute("data-disabled")).not.toBeNull();
    // The seeded config's own routes for managers and workers are off: they follow the default.
    expect(await page.locator('[data-slot="remove-blocked"]').textContent()).toBe("In use by Routing (default model). Change that first.");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
