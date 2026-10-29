import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { artifactDir } from "./helpers/diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";

const browser = browserForFile();
let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ data: [
          { id: "deepseek/deepseek-v4-pro", architecture: { input_modalities: ["text"] }, supported_parameters: ["reasoning", "tools"] },
          { id: "plain-model", object: "model", owned_by: "openai" }
        ] });
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

// Settings' six sections do not fit a 390px phone (~390px of pills in 342px).
// The row scrolls sideways, fades where it has more, keeps the selected
// section in view, and never widens the page. First: the test after it saves
// models to this server's config.
// The sections scroll below the search and reserve a gutter for their
// scrollbar; the search reserves the same, so the two share both edges
// (the search ran 10px past the cards at every width).
test("the settings search lines up with the cards below it", async () => {
  for (const width of [1440, 1024]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(`${server.baseUrl}/settings`);
      const search = page.getByRole("combobox", { name: "Search settings" });
      const card = page.locator('[data-slot="settings-section"] [data-slot="section-panel"]').first();
      await card.waitFor();
      const [s, c] = [(await search.boundingBox())!, (await card.boundingBox())!];
      // The gutter is real in this browser, so the edges could differ.
      const gutter = await card.evaluate((el) => {
        let node = el.parentElement;
        while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;
        return node ? node.offsetWidth - node.clientWidth : 0;
      });
      expect(gutter).toBeGreaterThan(0);
      expect([Math.round(s.x), Math.round(s.x + s.width)]).toEqual([Math.round(c.x), Math.round(c.x + c.width)]);
    } finally {
      await page.close();
    }
  }
}, 30_000);

test("on a phone the settings sections scroll in their row, fade where there is more, and keep the chosen one in view", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    const row = page.locator('nav[aria-label="Settings sections"]');
    const box = async (name: string) => (await row.getByRole("button", { name, exact: true }).boundingBox())!;

    await page.goto(`${server.baseUrl}/settings`);
    await row.waitFor();
    const rowBox = (await row.boundingBox())!;
    // It overflows: Skills is past the row's right edge, and the row says so.
    expect((await box("Skills")).x + (await box("Skills")).width).toBeGreaterThan(rowBox.x + rowBox.width);
    expect(await row.getAttribute("data-more")).toBe("right");
    // The page itself never scrolls sideways.
    expect(await pageOverflow(page)).toEqual([]);
    const shots = artifactDir("settings-tabs-phone");
    await page.screenshot({ path: path.join(shots, "start.png") });

    // Opened on the last section, the row starts scrolled to it.
    await page.goto(`${server.baseUrl}/settings?tab=web-search`);
    await row.waitFor();
    const last = await box("Web search");
    expect(last.x).toBeGreaterThanOrEqual(rowBox.x);
    expect(last.x + last.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
    expect(await row.getAttribute("data-more")).toBe("left");
    expect(await row.getByRole("button", { name: "Web search", exact: true }).getAttribute("aria-current")).toBe("page");
    await page.screenshot({ path: path.join(shots, "web-search.png") });

    // Back to the first by tapping it: in view again, the fade on the right.
    await row.getByRole("button", { name: "Providers", exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('nav[aria-label="Settings sections"] [aria-current="page"]')?.textContent === "Providers");
    const providers = await box("Providers");
    expect(providers.x).toBeGreaterThanOrEqual(rowBox.x);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

// Capabilities default on: a model its provider's list
// declares text-only is added with Image input off and a line saying where
// that came from; changed by hand, a button puts the list's values back; a
// model the list says nothing about is added with both on.
test("adding models: declared text-only starts off and says so, a button puts the list's values back, undeclared starts on", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/settings?tab=providers`);
    await page.locator('[data-provider-row="openai"]').click();
    await page.getByRole("button", { name: "Add models" }).click();
    const adding = page.getByRole("dialog");
    await adding.locator("[data-catalog-item='deepseek/deepseek-v4-pro'] input[type=checkbox]").check();
    await adding.locator("[data-catalog-item='plain-model'] input[type=checkbox]").check();
    await adding.getByRole("button", { name: "Add 2 models" }).click();
    await adding.waitFor({ state: "detached" });

    await page.locator("[data-model-row='deepseek/deepseek-v4-pro'] button").first().click();
    const edit = page.getByRole("dialog");
    const image = edit.getByRole("switch", { name: "Image input" });
    const reasoning = edit.getByRole("switch", { name: "Reasoning" });
    expect([await image.getAttribute("aria-checked"), await reasoning.getAttribute("aria-checked")]).toEqual(["false", "true"]);
    expect(await edit.locator("[data-cap-note]").textContent()).toBe("From openai's model list");
    await image.click();
    expect(await edit.locator("button[data-cap-reset]").textContent()).toBe("Use openai's values");
    await edit.screenshot({ path: path.join(artifactDir("settings-add-model"), "changed-by-hand.png") });
    await edit.locator("button[data-cap-reset]").click();
    expect(await image.getAttribute("aria-checked")).toBe("false");
    expect(await edit.locator("[data-cap-note]").count()).toBe(1);
    await edit.getByRole("button", { name: "Cancel" }).click();
    await edit.waitFor({ state: "detached" });

    await page.locator("[data-model-row='plain-model'] button").first().click();
    const plain = page.getByRole("dialog");
    expect([
      await plain.getByRole("switch", { name: "Image input" }).getAttribute("aria-checked"),
      await plain.getByRole("switch", { name: "Reasoning" }).getAttribute("aria-checked")
    ]).toEqual(["true", "true"]);
    expect(await plain.locator("[data-cap-note], [data-cap-reset]").count()).toBe(0);
    await plain.getByRole("button", { name: "Cancel" }).click();
    await plain.waitFor({ state: "detached" });

    // Add saved them before its dialog closed.
    const settings = await (await fetch(`${server.baseUrl}/api/settings/config`)).json() as Record<string, any>;
    const models = (settings.config ?? settings).models.providers.openai.models as Array<Record<string, unknown>>;
    expect(models.find((m) => m.id === "deepseek/deepseek-v4-pro")).toMatchObject({ input: ["text"], supportsReasoning: true });
    expect(models.find((m) => m.id === "plain-model")).toMatchObject({ input: ["text", "image"], supportsReasoning: true });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

// On a phone a section's description was cut to one line, and Routing's
// lost the half that matters. It goes under the title and wraps there; the
// switch stays on the title's line.
test("on a phone a section's description wraps under its title, whole, its switch beside the title", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${server.baseUrl}/settings?tab=routing`);
    const headers = page.locator('[data-slot="settings-section"] > [data-slot="section-header"]');
    await page.getByRole("switch", { name: "Own route for workers" }).waitFor();
    const seen = await headers.evaluateAll((nodes) => nodes.map((header) => {
      const title = header.querySelector('[data-slot="section-title"]')!.getBoundingClientRect();
      const meta = header.querySelector<HTMLElement>('[data-slot="section-meta"]')!;
      const sw = header.querySelector('[role="switch"]')?.getBoundingClientRect() ?? null;
      const box = meta.getBoundingClientRect();
      return {
        text: meta.textContent,
        whole: meta.scrollWidth <= meta.clientWidth + 1,
        under: box.top >= title.bottom - 0.5,
        inside: box.right <= header.getBoundingClientRect().right + 0.5,
        switchBesideTitle: sw ? sw.bottom > title.top && sw.top < title.bottom : null
      };
    }));
    expect(seen.map((s) => s.text)).toEqual([
      "Used wherever a route of its own isn't set.",
      "Your agent, with its compaction.",
      "Every thread's manager, with its compaction.",
      "The agent inside each worker, with its compaction.",
      "The subagents an agent starts for a self-contained job, with their compaction.",
      "The subagents that change Your agent's page.",
      "The background pass that reviews, merges and prunes memories, and writes the briefs agents read first.",
      "Picks what to remember from conversations as they leave context.",
      "The models Mandate asks for quick judgements. Each use below runs on them unless it has its own.",
      "While a manager thread works on, tells Your agent when a request it sent there is done.",
      "When a manager thread stops, sorts what its last reply leaves for you: a decision, a result to read, or nothing.",
      "Before memory extraction stores a memory, reads the stored ones most like it, and leaves it out when one already says it."
    ]);
    for (const s of seen) {
      expect(s.whole).toBe(true);
      expect(s.under).toBe(true);
      expect(s.inside).toBe(true);
    }
    expect(seen.map((s) => s.switchBesideTitle)).toEqual([null, true, true, true, true, true, true, true, true, true, true, true]);
    expect(await pageOverflow(page)).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

// On a phone a row's control goes under its name and description, 10px
// below, in every row: one field used to add that gap itself and the rest
// sat flush (the theme buttons touched their description).
test("on a phone every setting's control sits 10px under its description", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${server.baseUrl}/settings`);
    await page.getByRole("radio", { name: "Dark theme" }).waitFor();
    const gaps = await page.locator("[data-setting-anchor]").evaluateAll((rows) => rows.flatMap((row) => {
      const grid = row.firstElementChild!;
      const [text, control] = [grid.children[0], grid.children[1]];
      if (!text || !control) return [];
      return [{
        anchor: row.getAttribute("data-setting-anchor"),
        gap: Math.round(control.getBoundingClientRect().top - text.getBoundingClientRect().bottom)
      }];
    }));
    expect(gaps.map((g) => g.anchor)).toContain("theme");
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (const g of gaps) expect(g).toEqual({ anchor: g.anchor, gap: 10 });
  } finally {
    await page.close();
  }
}, 30_000);

// Native controls (a checkbox, a scrollbar, a select's menu) follow the
// theme: with no color-scheme the browser drew them light on the dark theme,
// a white checkbox in Voice's API key row.
test("native controls take the theme's colour scheme", async () => {
  for (const theme of ["dark", "light"] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.addInitScript((theme) => {
        localStorage.setItem("mandate.ui", JSON.stringify({ state: { theme }, version: 0 }));
      }, theme);
      await page.goto(`${server.baseUrl}/settings`);
      await page.getByRole("radio", { name: "Dark theme" }).waitFor();
      const seen = await page.evaluate(() => {
        const box = document.createElement("input");
        box.type = "checkbox";
        document.querySelector("main")!.append(box);
        return { theme: document.documentElement.dataset.theme, scheme: getComputedStyle(box).colorScheme };
      });
      expect(seen).toEqual({ theme, scheme: theme });
    } finally {
      await page.close();
    }
  }
}, 30_000);

// Tab into a token count and type: the typed digits replace it. Swapping
// "170,000" for plain digits on focus used to drop the selection Tab made, so
// typing appended (170000250000, which Save would store).
test("tabbing into a token count and typing replaces it", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${server.baseUrl}/settings`);
    const threshold = page.locator("#compression-threshold");
    await threshold.waitFor();
    await page.locator("textarea").first().focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("compression-threshold");
    await page.keyboard.type("250000");
    expect(await threshold.inputValue()).toBe("250000");
    // And a fill, which selects and types.
    await threshold.fill("123456");
    expect(await threshold.inputValue()).toBe("123456");
  } finally {
    await page.close();
  }
}, 30_000);
