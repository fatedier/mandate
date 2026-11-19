import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";

/**
 * Files an agent links, through the compiled server: on a desktop each opens
 * as a tab of the thread's panel (a report with its picture, a line of code
 * marked and in sight, an image, a file that is gone, a JSON file formatted
 * and coloured); on a phone a file opens over the chat and Back closes it.
 */

// A UTF-8 locale, as a Mac or a phone has: in the image's plain one, Chromium
// on Linux cannot write a non-ASCII download name and saves it as "download".
const browser = browserForFile({ env: { ...process.env, LANG: "C.UTF-8" } });
// A 1x1 PNG, the report's picture and the image linked.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let server: RunningServer;
let threadId = "";
let files = { report: "", code: "", image: "", gone: "", list: "", json: "" };
const LIST = "id,name,team\n1,Alex Lee,Platform\n2,Bo Chen,Garden\n";
// Stored as one line, as a check's data file often is.
const JSON_FILE = '{"qwerasdfzxcv1234":{"sig":"north|dry|soil_dry||bed-3|bed-3/row-2","count":12,"moisture":0.120,"last_trace":1234567890123456789,"muted":false,"note":null},"asdfzxcvqwer5678":{"sig":"south|cold|frost_risk||bed-5|bed-5/row-1","count":3,"moisture":0.300,"last_trace":1234567890123456920,"muted":true,"note":"seedlings moved"}}';

beforeAll(async () => {
  server = await startServer({
    configured: true,
    label: "file-links",
    seed(dataDir) {
      // In Mandate's resources folder: one of the folders a file may open from.
      const root = path.join(dataDir, "resources", "e2e-files", "project-1");
      fs.mkdirSync(path.join(root, "docs"), { recursive: true });
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      files = {
        report: path.join(root, "docs", "report.md"),
        code: path.join(root, "src", "expiry.ts"),
        image: path.join(root, "docs", "shot.png"),
        gone: path.join(root, "docs", "old-plan.md"),
        list: path.join(root, "docs", "名单-12345678.csv"),
        json: path.join(root, "docs", "known.json")
      };
      fs.writeFileSync(files.json, JSON_FILE);
      fs.writeFileSync(files.list, LIST);
      fs.writeFileSync(files.report, "# Cache expiry\n\nHit rate before and after:\n\n![hit rate](shot.png)\n");
      fs.writeFileSync(files.code, Array.from({ length: 120 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n") + "\n");
      fs.writeFileSync(files.image, PNG);
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const thread = agents.createManagerThread("project-1 cache expiry");
        threadId = thread.id;
        agents.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Is the expiry bug fixed?" } });
        agents.appendMessage({
          threadId: thread.id, role: "assistant", source: "self",
          content: {
            type: "assistant",
            text: `Fixed. The write-up is in [report.md](${files.report}); the cause is at [expiry.ts:90](${files.code}#L90); the picture is [shot.png](${files.image}); the old plan, [old-plan.md](${files.gone}), is gone. The list is in [名单-12345678.csv](${files.list}); the signatures in [known.json](${files.json}).`
          }
        });
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => { server?.cleanup(); });

async function open(viewport: { width: number; height: number }, colorScheme: "light" | "dark" = "light"): Promise<Page> {
  const page = await browser.newPage({ viewport, colorScheme, ...(viewport.width < 768 ? { hasTouch: true, isMobile: true } : {}) });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}/threads/${threadId}`);
  await page.locator("a[data-file-link]").first().waitFor({ timeout: 15_000 });
  return page;
}

/** A tab switched to fades in (150 ms): what a screenshot shows once it has. */
const still = (page: Page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), undefined, { timeout: 5_000 });
const link = (page: Page, name: string) => page.locator("a[data-file-link]", { hasText: name }).first();
const view = (page: Page, file: string) => page.locator(`[data-slot="file-view"][data-path="${file}"]`);
/** How light a file view's text and the ground under it read, 0 black to 1
 *  white: drawn on a canvas, so any colour the theme writes reads alike. */
const shades = (page: Page, file: string, text: string) => page.evaluate(([file, text]) => {
  const pen = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  const drawn = (color: string) => {
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = color;
    pen.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pen.getImageData(0, 0, 1, 1).data;
    return { light: (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255, clear: a === 0 };
  };
  const ink = document.querySelector(`[data-slot="file-view"][data-path="${file}"] ${text}`)!;
  let under: Element | null = ink;
  while (under && drawn(getComputedStyle(under).backgroundColor).clear) under = under.parentElement;
  return { ink: drawn(getComputedStyle(ink).color).light, ground: under ? drawn(getComputedStyle(under).backgroundColor).light : 1 };
}, [file, text] as const);

test("desktop: a report, a line of code, an image and a file that is gone open as tabs of the panel", async () => {
  const page = await open({ width: 1440, height: 900 });
  try {
    await link(page, "report.md").click();
    const tab = page.locator(`[data-file-tab="${files.report}"]`);
    await tab.waitFor({ timeout: 10_000 });
    expect(await tab.getAttribute("aria-selected")).toBe("true");
    // The report reads as it reads, its picture loaded from the server.
    await view(page, files.report).locator('[data-slot="markdown"]', { hasText: "Cache expiry" }).waitFor({ timeout: 10_000 });
    await page.waitForFunction((file) => {
      const img = document.querySelector<HTMLImageElement>(`[data-slot="file-view"][data-path="${file}"] [data-slot="markdown"] img`);
      return img !== null && img.complete && img.naturalWidth > 0;
    }, files.report, { timeout: 10_000 });
    // Still the thread's page, nothing over it.
    expect(new URL(page.url()).pathname).toBe(`/threads/${threadId}`);
    expect(await page.locator('[role="dialog"][aria-label="File"]').count()).toBe(0);

    await link(page, "expiry.ts:90").click();
    const code = view(page, files.code);
    await code.locator('[data-slot="file-highlight"]').waitFor({ timeout: 10_000 });
    // The marked line is in sight inside the scrolled text.
    const inSight = await page.evaluate((file) => {
      const root = document.querySelector(`[data-slot="file-view"][data-path="${file}"]`)!;
      const box = root.querySelector('[data-slot="file-code"]')!.getBoundingClientRect();
      const mark = root.querySelector('[data-slot="file-highlight"]')!.getBoundingClientRect();
      return mark.top >= box.top && mark.bottom <= box.bottom && mark.height > 0;
    }, files.code);
    expect(inSight).toBe(true);
    expect(await code.locator('[data-slot="file-meta"]').textContent()).toContain("Line 90");
    await look(page, "desktop-code-light");

    await link(page, "shot.png").click();
    await page.waitForFunction((file) => {
      const img = document.querySelector<HTMLImageElement>(`[data-slot="file-view"][data-path="${file}"] [data-slot="file-image"]`);
      return img !== null && img.complete && img.naturalWidth > 0;
    }, files.image, { timeout: 10_000 });

    await link(page, "old-plan.md").click();
    await view(page, files.gone).getByText("File not found").waitFor({ timeout: 10_000 });
    expect(await page.locator("[data-file-tab]").count()).toBe(4);
  } finally {
    await page.close();
  }
}, 90_000);

test("desktop, dark: the report and the code read in the dark theme", async () => {
  const page = await open({ width: 1440, height: 900 }, "dark");
  try {
    await link(page, "report.md").click();
    await view(page, files.report).locator('[data-slot="markdown"]', { hasText: "Cache expiry" }).waitFor({ timeout: 10_000 });
    await still(page);
    // Light text on a dark ground, the report's and the code's alike.
    const report = await shades(page, files.report, '[data-slot="markdown"]');
    expect([report.ink > 0.6, report.ground < 0.2]).toEqual([true, true]);
    await look(page, "desktop-report-dark");
    await link(page, "expiry.ts:90").click();
    await view(page, files.code).locator('[data-slot="file-highlight"]').waitFor({ timeout: 10_000 });
    await still(page);
    const code = await shades(page, files.code, '[data-slot="file-text"]');
    expect([code.ink > 0.6, code.ground < 0.2]).toEqual([true, true]);
    await look(page, "desktop-code-dark");
  } finally {
    await page.close();
  }
}, 60_000);

// A JSON file reads formatted first, each kind of token in its own colour;
// Source shows it as stored, one line.
test("a JSON file reads formatted and coloured, on a desktop and a phone, light and dark; Source shows it as stored", async () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await open(viewport, scheme);
      try {
        await link(page, "known.json").click();
        const json = view(page, files.json);
        await json.locator('[data-slot="file-text"] [data-token="key"]').first().waitFor({ timeout: 10_000 });
        expect(await json.getByRole("button", { name: "Formatted" }).getAttribute("aria-pressed")).toBe("true");
        expect((await json.locator('[data-slot="file-text"]').textContent())!.split("\n").slice(0, 4)).toEqual([
          "{", '  "qwerasdfzxcv1234": {', '    "sig": "north|dry|soil_dry||bed-3|bed-3/row-2",', '    "count": 12,'
        ]);
        // Keys, text, numbers, true/false/null and the rest: five colours.
        const colours = await json.locator('[data-slot="file-text"]').evaluate((text) => {
          const of = (el: Element) => getComputedStyle(el).color;
          return [of(text), ...["key", "string", "number", "literal"].map((kind) => of(text.querySelector(`[data-token="${kind}"]`)!))];
        });
        expect(new Set(colours).size).toBe(5);
        await still(page);
        await look(page, `json-${viewport.width < 768 ? "phone" : "desktop"}-${scheme}`);
        await json.getByRole("button", { name: "Source" }).click();
        expect(await json.locator('[data-slot="file-line-numbers"]').textContent()).toBe("1");
        expect(await json.locator('[data-slot="file-text"]').textContent()).toBe(JSON_FILE);
      } finally {
        await page.close();
      }
    }
  }
}, 120_000);

test("phone: a file opens over the chat and Back closes it", async () => {
  const page = await open({ width: 390, height: 844 });
  try {
    await link(page, "expiry.ts:90").click();
    const dialog = page.locator('[role="dialog"][aria-label="File"]');
    await dialog.locator('[data-slot="file-highlight"]').waitFor({ timeout: 10_000 });
    // It covers the screen.
    const box = await dialog.boundingBox();
    expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([390, 844]);
    await look(page, "phone-code");
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="File"]') === null, undefined, { timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe(`/threads/${threadId}`);
    // The close button does the same.
    await link(page, "report.md").click();
    await dialog.getByRole("button", { name: "Close file" }).click();
    await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="File"]') === null, undefined, { timeout: 10_000 });
  } finally {
    await page.close();
  }
}, 60_000);

// A file opened from a link can be kept: downloaded as it is, under its own
// name, by a desktop browser and a phone's alike.
test("Download saves the file as it is, under its own name, on a desktop and on a phone", async () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await open(viewport);
    try {
      await link(page, "名单-12345678.csv").click();
      const download = view(page, files.list).locator('[data-slot="file-download"]');
      await download.waitFor({ timeout: 10_000 });
      // An icon after Copy path, named for a screen reader and on hover.
      expect([await download.getAttribute("aria-label"), await download.getAttribute("title"), (await download.innerText()).trim()]).toEqual(["Download", "Download", ""]);
      await look(page, viewport.width < 768 ? "phone-download" : "desktop-download");
      // On a phone the icons keep one row, Close with them: the name and its
      // time give way first.
      if (viewport.width < 768) {
        const tops = await Promise.all(["Copy path", "Download", "Close file"].map(async (name) => Math.round((await view(page, files.list).getByLabel(name, { exact: true }).boundingBox())!.y)));
        expect(new Set(tops).size).toBe(1);
      }
      const at = page.url();
      // On a phone a tap at Download's very edge is Download's, not Copy path's beside it.
      const edge = (await download.boundingBox())!;
      const tap = viewport.width < 768 ? page.touchscreen.tap(edge.x + 2, edge.y + edge.height / 2) : download.click();
      const [saved] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }), tap]);
      expect(saved.suggestedFilename()).toBe("名单-12345678.csv");
      expect(fs.readFileSync((await saved.path())!, "utf8")).toBe(LIST);
      // The page stays where it was, the file still open.
      expect(page.url()).toBe(at);
      await view(page, files.list).locator('[data-slot="file-text"]').waitFor();
    } finally {
      await page.close();
    }
  }
}, 60_000);
