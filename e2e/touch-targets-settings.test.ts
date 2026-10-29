import { afterAll, beforeAll, test } from "bun:test";
import type { Page } from "playwright";
import type { RunningServer } from "./helpers/server.js";
import { startTouchHarness, stopTouchHarness, onPhone, onDevice, expectFit, PHONE, NARROW } from "./helpers/touch-targets";

// Touch targets: Settings. The rule and the measurement are in
// helpers/touch-targets.ts.
let server: RunningServer;
beforeAll(async () => {
  const harness = await startTouchHarness({ server: true });
  server = harness.server!;
}, 60_000);
afterAll(stopTouchHarness);

test("Settings: general, providers, memory, routing, and a section with unsaved edits", async () => {
  for (const tab of ["", "?tab=providers", "?tab=memory", "?tab=routing"]) {
    expectFit(`settings${tab}`, await onPhone(`${server.baseUrl}/settings${tab}`, '[data-slot="page-tabs"]'));
  }
  // An edit shows the section's Save at the bottom of its panel.
  expectFit("settings, an unsaved edit", await onPhone(`${server.baseUrl}/settings`, '[data-slot="page-tabs"]', async (page) => {
    await page.locator('#compression-threshold').fill("123456");
    // In view: a control scrolled out of the page is not measured.
    await page.getByRole("button", { name: "Save" }).first().scrollIntoViewIfNeeded();
  }));
  // A route's step opened: its editor, model, efforts and moves.
  expectFit("settings, a route's step opened", await onPhone(`${server.baseUrl}/settings?tab=routing`, '[data-slot="page-tabs"]', async (page) => {
    await page.locator('[data-route="default"] [data-step="0"]').tap();
    await page.locator('[data-slot="step-editor"]').waitFor();
  }));
  // A provider's page, opened from its row (drawn after the tabs this state
  // waited for, so the tap waits for it).
  const openProvider = async (page: Page, name = "openai") => {
    await page.locator(`[data-provider-row="${name}"]`).tap();
    await page.locator('[data-slot="provider-page"]').waitFor();
  };
  expectFit("settings, a provider's page", await onPhone(`${server.baseUrl}/settings?tab=providers`, '[data-slot="page-tabs"]', async (page) => {
    await openProvider(page);
    await page.locator("[data-model-row]").first().scrollIntoViewIfNeeded();
  }));
  expectFit("settings, a provider's page at 320", await onDevice(NARROW, `${server.baseUrl}/settings?tab=providers`, '[data-slot="page-tabs"]', async (page) => {
    await openProvider(page);
    await page.locator("[data-model-row]").last().scrollIntoViewIfNeeded();
  }));
  // A model's dialog, then the catalog to add some.
  expectFit("settings, a model's dialog", await onPhone(`${server.baseUrl}/settings?tab=providers`, '[data-slot="page-tabs"]', async (page) => {
    await openProvider(page);
    await page.locator('[data-model-row="gpt-5.5"] button').first().tap();
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).waitFor();
  }));
  expectFit("settings, adding models", await onPhone(`${server.baseUrl}/settings?tab=providers`, '[data-slot="page-tabs"]', async (page) => {
    await openProvider(page);
    await page.getByRole("button", { name: "Add models" }).tap();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).waitFor();
  }));
  // A search typed: Clear in the field, results as rows.
  // A refresh that fails keeps what loaded, with a Retry.
  expectFit("settings, a refresh failed", await onPhone(`${server.baseUrl}/settings`, '[data-slot="page-tabs"]', async (page) => {
    await page.getByRole("button", { name: "Refresh settings" }).tap();
    await page.getByRole("button", { name: "Retry" }).waitFor();
  }, async (page) => {
    let reads = 0;
    await page.route("**/api/settings/config", (route) => route.request().method() === "GET" && ++reads > 1
      ? route.fulfill({ status: 500, json: { error: "config unreadable" } })
      : route.fallback());
  }));
  // That failure with a search typed, on a 430px phone: Retry's line sits
  // right under the search field.
  expectFit("settings, a refresh failed while searching at 430", await onDevice({ ...PHONE, viewport: { width: 430, height: 932 } }, `${server.baseUrl}/settings`, '[data-slot="page-tabs"]', async (page) => {
    await page.getByRole("button", { name: "Refresh settings" }).tap();
    await page.getByRole("button", { name: "Retry" }).waitFor();
    await page.getByRole("combobox", { name: "Search settings" }).fill("model");
    await page.getByRole("button", { name: "Clear search" }).waitFor();
  }, async (page) => {
    let reads = 0;
    await page.route("**/api/settings/config", (route) => route.request().method() === "GET" && ++reads > 1
      ? route.fulfill({ status: 500, json: { error: "HTTP 500" } })
      : route.fallback());
  }));
  expectFit("settings, adding models at 320", await onDevice(NARROW, `${server.baseUrl}/settings?tab=providers`, '[data-slot="page-tabs"]', async (page) => {
    await openProvider(page);
    await page.getByRole("button", { name: "Add models" }).tap();
    await page.getByRole("dialog").getByRole("button", { name: "Refresh" }).waitFor();
  }));
  expectFit("settings, searching", await onPhone(`${server.baseUrl}/settings`, '[data-slot="page-tabs"]', async (page) => {
    await page.getByRole("combobox", { name: "Search settings" }).fill("model");
    await page.getByRole("button", { name: "Clear search" }).waitFor();
  }));
  // Provider x: a one-letter name, one short model.
  expectFit("settings, provider x's page", await onPhone(`${server.baseUrl}/settings?tab=providers`, '[data-slot="page-tabs"]', async (page) => {
    await openProvider(page, "x");
    await page.locator('[data-model-row="x-1"]').scrollIntoViewIfNeeded();
  }));
  // A provider in use: its menu says why it cannot be removed.
  expectFit("settings, a provider in use, its menu", await onPhone(`${server.baseUrl}/settings?tab=providers`, '[data-slot="page-tabs"]', async (page) => {
    await openProvider(page);
    await page.getByRole("button", { name: "Provider actions" }).tap();
    await page.locator('[data-slot="remove-blocked"]').waitFor();
  }));
  // A confirmation dialog: on a phone its buttons stack. Provider x is not
  // in use, so it can be removed.
  expectFit("settings, removing a provider", await onPhone(`${server.baseUrl}/settings?tab=providers`, '[data-slot="page-tabs"]', async (page) => {
    await openProvider(page, "x");
    await page.getByRole("button", { name: "Provider actions" }).tap();
    await page.getByRole("menuitem", { name: "Remove provider…" }).tap();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).waitFor();
  }));
  // A route of two steps: each card has its ×, beside the step's button (last:
  // the step added is saved, and stays on the default route).
  expectFit("settings, a route of two steps, each card's ×", await onPhone(`${server.baseUrl}/settings?tab=routing`, '[data-slot="page-tabs"]', async (page) => {
    await page.locator('[data-route="default"] [aria-label="Add a step"]').tap();
    await page.locator('[role="menuitem"][data-ref="openai/gpt-5.6-sol"]').tap();
    await page.locator('[data-route="default"] [aria-label="Remove openai/gpt-5.6-sol"]').waitFor();
  }));
}, 120_000);
