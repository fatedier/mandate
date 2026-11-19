import { expect, test } from "bun:test";
import type { Locator, Page } from "playwright";
import type { AgentClientMessageDto } from "../src/shared/api-contracts";
import { startWorkspaceFixture, workerPath } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { look, trackPageErrors } from "./helpers/page-diagnostics";
import { settle } from "./helpers/settle";

// Sharing picks messages in the chat itself, then makes the picked ones an
// image (a PNG at twice the card's 480px, in the page's theme) or Markdown,
// to save or copy. What happy-dom cannot do is checked here: the image is
// really drawn, has its size and the theme's background, a save is a real
// download, and how picking and the dialog look on a desktop and a phone.

const browser = browserForFile();
const at = (minute: number) => `2026-11-06T10:${String(minute).padStart(2, "0")}:00.000Z`;
const row = { threadId: "zoom-thread", sourceThreadId: null } as const;
const said = (seq: number, text: string): AgentClientMessageDto =>
  ({ ...row, id: `m-${seq}`, seq, role: "user", source: "user", wakeId: null, createdAt: at(seq), content: { type: "text", text } });
const reply = (seq: number, wakeId: string, text: string, command?: string): AgentClientMessageDto => ({
  ...row, id: `m-${seq}`, seq, role: "assistant", source: "self", wakeId, createdAt: at(seq),
  content: { type: "assistant", text, ...(command ? { toolCalls: [{ toolCallId: `call-${seq}`, toolName: "bash", args: { command } }] } : {}) }
});
const ran = (seq: number, wakeId: string, callSeq: number): AgentClientMessageDto => ({
  ...row, id: `m-${seq}`, seq, role: "tool", source: "self", wakeId, createdAt: at(seq),
  content: { type: "tool_result", toolCallId: `call-${callSeq}`, toolName: "bash", result: "stdout:\nthumbs.go:88: img, err := image.Decode(file)" }
});
const MESSAGES = [
  said(1, "Can the gallery make thumbnails for large photos, or does it skip them?"),
  reply(2, "w1", "Looking at the thumbnail code.", "rg -n Decode thumbs.go"),
  ran(3, "w1", 2),
  reply(4, "w1", "It skips them: **the whole photo must fit in memory** before a thumbnail is made, in `thumbs.go`. Large ones need the decoder to scale as it reads."),
  said(5, "Raise the limit to 4096 px first?"),
  reply(6, "w2", "Yes, a safe first step. Set `max_photo_px` to `4096` and restart.")
];

/** The worker's chat: its thread's panel on a desktop, its sheet on a phone. */
const chat = (page: Page) => page.locator((page.viewportSize()?.width ?? 1280) < 768 ? '[data-slot="worker-sheet"]' : '[data-slot="worker-panel"]');
const rowOf = (page: Page, text: string) => chat(page).locator('[data-slot="transcript-row"]').filter({ hasText: text });
const shareRow = (page: Page, text: string) => chat(page).locator('[data-slot="share-row"]').filter({ hasText: text });
const bar = (page: Page) => chat(page).locator('[data-slot="share-bar"]');
const dialog = (page: Page) => page.locator('[data-slot="share-dialog"]');

async function open(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}${workerPath("chat")}`);
  await rowOf(page, "a safe first step").waitFor();
  await settle(page);
}

/** The shown image: its pixel size, and whether its corner is the card's
 *  background (the page's, in its theme), both read as a canvas draws them. */
async function imageOf(page: Page) {
  const img = dialog(page).locator('img[data-slot="share-image"]');
  await img.waitFor();
  return img.evaluate(async (el: HTMLImageElement) => {
    await el.decode();
    const pixel = (draw: (g: CanvasRenderingContext2D) => void) => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(el.naturalWidth, 8);
      canvas.height = Math.max(el.naturalHeight, 8);
      const g = canvas.getContext("2d")!;
      draw(g);
      return [...g.getImageData(4, 4, 1, 1).data.slice(0, 3)];
    };
    const corner = pixel((g) => g.drawImage(el, 0, 0));
    const background = pixel((g) => {
      g.fillStyle = getComputedStyle(document.querySelector('[data-slot="share-card"]')!).backgroundColor;
      g.fillRect(0, 0, 8, 8);
    });
    return {
      width: el.naturalWidth,
      height: el.naturalHeight,
      cornerIsBackground: corner.every((v, i) => Math.abs(v - background[i]!) <= 2)
    };
  });
}
const buttons = (scope: Locator) => scope.locator("button").evaluateAll((els) => els.map((el) => el.textContent?.trim()).filter((text) => text));

test("on a desktop: picking from a reply, a Shift range and toggles; the image, the Markdown, a save and a copy, in both themes", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setMessages(MESSAGES);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "light" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.baseUrl });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await open(page, fixture.baseUrl);
    expect(await chat(page).locator('[data-slot="tool-run"]').count()).toBe(1);
    // From the first turn's answer: its question, what it said on the way, the answer.
    const answer = rowOf(page, "It skips them");
    await answer.hover();
    await answer.getByRole("button", { name: "Share as image" }).click();
    await bar(page).getByText("3 selected").waitFor();
    expect(await chat(page).locator('[data-slot="tool-run"]').count()).toBe(0);
    expect(await chat(page).locator('[data-slot="composer"]').count()).toBe(0);
    // Shift from the answer to the next question; the one on the way out; the last answer in.
    await shareRow(page, "Raise the limit").click({ modifiers: ["Shift"] });
    await shareRow(page, "Looking at the thumbnail code").click();
    await shareRow(page, "a safe first step").click();
    await bar(page).getByText("4 selected").waitFor();
    expect(await chat(page).locator('[data-slot="share-row"][aria-checked="true"]').count()).toBe(4);
    await page.mouse.move(5, 5);
    await settle(page);
    await look(chat(page), "desktop-light-picking");

    await bar(page).getByRole("button", { name: "Share" }).click();
    const four = await imageOf(page);
    expect({ ...four, height: four.height > 0 }).toEqual({ width: 960, height: true, cornerIsBackground: true });
    expect(await buttons(dialog(page))).toEqual(["Image", "Markdown", "Save image", "Copy image"]);
    await settle(page);
    await look(page, "desktop-light-image");
    await dialog(page).getByRole("tab", { name: "Markdown" }).click();
    expect(await dialog(page).locator('[data-slot="share-markdown"]').textContent()).toBe([
      "**You:** Can the gallery make thumbnails for large photos, or does it skip them?",
      "…",
      "It skips them: **the whole photo must fit in memory** before a thumbnail is made, in `thumbs.go`. Large ones need the decoder to scale as it reads.",
      "**You:** Raise the limit to 4096 px first?",
      "Yes, a safe first step. Set `max_photo_px` to `4096` and restart."
    ].join("\n\n") + "\n");
    await look(page, "desktop-light-markdown");
    await dialog(page).getByRole("tab", { name: "Image" }).click();
    const download = page.waitForEvent("download");
    await dialog(page).getByRole("button", { name: "Save image" }).click();
    expect((await download).suggestedFilename()).toMatch(/^mandate-share-\d{8}-\d{6}\.png$/);
    await page.getByText("Image saved").waitFor();
    // Saved: picking is over, the composer is back.
    expect(await dialog(page).count()).toBe(0);
    expect(await bar(page).count()).toBe(0);
    await chat(page).locator('[data-slot="composer"]').waitFor();

    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
    // The latest answer's line always shows.
    await rowOf(page, "a safe first step").getByRole("button", { name: "Share as image" }).click();
    await bar(page).getByText("2 selected").waitFor();
    await page.mouse.move(5, 5);
    await settle(page);
    await look(chat(page), "desktop-dark-picking");
    await bar(page).getByRole("button", { name: "Share" }).click();
    const two = await imageOf(page);
    // Two messages: as wide, shorter.
    expect({ ...two, height: two.height < four.height }).toEqual({ width: 960, height: true, cornerIsBackground: true });
    await settle(page);
    await look(page, "desktop-dark-image");
    await dialog(page).getByRole("button", { name: "Copy image" }).click();
    await page.getByText("Image copied").waitFor();
    expect(await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => item.types))).toContain("image/png");
    expect(await bar(page).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60_000);

test("a table wider than the card wraps to fit it: the image holds every column", async () => {
  const fixture = startWorkspaceFixture();
  const table = [
    "| Option | What it changes | Risk | Effort |",
    "| --- | --- | --- | --- |",
    "| Raise the photo limit | Accepts photos up to 4096 px without touching the resize loop | Memory per thumbnail grows with the photo | An hour, with a restart |",
    "| Decode in strips | Reads rows as they decode, so memory stays flat for any size | The resize loop must scale and handle partial strips | Two days, with tests |"
  ].join("\n");
  fixture.setMessages([said(1, "Compare the two ways to handle large images."), reply(2, "w1", `Here they are side by side:\n\n${table}`)]);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}${workerPath("chat")}`);
    const answer = rowOf(page, "side by side");
    await answer.waitFor();
    await answer.getByRole("button", { name: "Share as image" }).click();
    await bar(page).getByRole("button", { name: "Share" }).click();
    expect((await imageOf(page)).width).toBe(960);
    const fit = await page.locator('[data-slot="share-card"]').evaluate((card) => {
      const box = card.getBoundingClientRect();
      const table = card.querySelector("table")!.getBoundingClientRect();
      const scroller = card.querySelector<HTMLElement>('[data-slot="table-scroll"]')!;
      return { inside: table.right <= box.right - 28 + 0.5, scrolls: scroller.scrollWidth > scroller.clientWidth };
    });
    expect(fit).toEqual({ inside: true, scrolls: false });
    await settle(page);
    await look(page, "desktop-table-image");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60_000);

test("a pick taller than a canvas can be is drawn smaller, whole, never as an empty image", async () => {
  const fixture = startWorkspaceFixture();
  // About 40,000px of card: twice that is past every browser's canvas.
  const long = Array.from({ length: 1700 }, (_, i) => `Step ${i + 1}: check the photo's size before the next resize.`).join("\n\n");
  fixture.setMessages([said(1, "List every step of the import."), reply(2, "w1", long)]);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}${workerPath("chat")}`);
    const answer = rowOf(page, "Step 1700:");
    await answer.waitFor();
    await answer.getByRole("button", { name: "Share as image" }).click();
    await bar(page).getByRole("button", { name: "Share" }).click();
    const card = (await page.locator('[data-slot="share-card"]').boundingBox())!;
    expect(card.height).toBeGreaterThan(32_767 / 2);
    const image = await imageOf(page);
    expect(image.cornerIsBackground).toBe(true);
    expect(image.width).toBeLessThan(960);
    expect(image.height).toBeLessThanOrEqual(32_767);
    // All of it: the same shape as the card.
    const shape = (image.height / image.width) / (card.height / card.width);
    expect(Math.abs(shape - 1)).toBeLessThan(0.005);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 90_000);

test("on a phone over http: the sheet saves the image and copies the text, with no image copy; closing it goes back to picking", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setMessages(MESSAGES);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "light" });
  // The fixture is on loopback, a secure origin; the phone reaches the app over http.
  await context.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false }));
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await open(page, fixture.baseUrl);
    await rowOf(page, "a safe first step").getByRole("button", { name: "Share as image" }).tap();
    await bar(page).getByText("2 selected").waitFor();
    await shareRow(page, "It skips them").tap();
    await bar(page).getByText("3 selected").waitFor();
    await settle(page);
    await look(page, "phone-light-picking");
    await bar(page).getByRole("button", { name: "Share" }).tap();
    expect({ ...(await imageOf(page)), height: 0 }).toEqual({ width: 960, height: 0, cornerIsBackground: true });
    expect(await buttons(dialog(page))).toEqual(["Image", "Markdown", "Save image"]);
    await settle(page);
    await look(page, "phone-light-image");
    await dialog(page).getByRole("tab", { name: "Markdown" }).tap();
    expect(await buttons(dialog(page))).toEqual(["Image", "Markdown", "Save file", "Copy text"]);
    await look(page, "phone-light-markdown");
    await dialog(page).getByRole("tab", { name: "Image" }).tap();
    // Pulled down part way by its title and let go, it springs back: its actions stay on the screen.
    const title = (await dialog(page).getByText("Share", { exact: true }).boundingBox())!;
    await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
    await page.mouse.down();
    await page.mouse.move(title.x + title.width / 2, title.y + 250, { steps: 20 });
    // Slowly: a flick would be a close.
    await page.waitForTimeout(1200);
    await page.mouse.up();
    await settle(page);
    expect(await dialog(page).locator('[role="tab"][aria-selected="true"]').textContent()).toBe("Image");
    const save = (await dialog(page).getByRole("button", { name: "Save image" }).boundingBox())!;
    expect(save.y + save.height).toBeLessThanOrEqual(844);
    // Closed: the picks stand.
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "detached" });
    await bar(page).getByText("3 selected").waitFor();

    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
    await settle(page);
    await look(page, "phone-dark-picking");
    await bar(page).getByRole("button", { name: "Share" }).tap();
    expect({ ...(await imageOf(page)), height: 0 }).toEqual({ width: 960, height: 0, cornerIsBackground: true });
    await settle(page);
    await look(page, "phone-dark-image");
    const download = page.waitForEvent("download");
    await dialog(page).getByRole("button", { name: "Save image" }).tap();
    expect((await download).suggestedFilename()).toMatch(/^mandate-share-\d{8}-\d{6}\.png$/);
    await page.getByText("Image saved").waitFor();
    expect(await bar(page).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60_000);
