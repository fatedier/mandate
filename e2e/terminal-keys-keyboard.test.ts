import { expect, test } from "bun:test";
import type { BrowserContextOptions } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { waitUntil } from "../tests/helpers/wait.js";
import { terminalsAtPaneSize } from "./helpers/terminal-display.js";

// The terminal's key bar (Esc, Tab, Ctrl, arrows) sits above the phone's
// keyboard however the keyboard resizes the page. When it shrinks only the
// visible area — an iPhone always — the page keeps its height, and a bar at
// the page's bottom was behind the keyboard.
const browser = browserForFile();

const PHONE: BrowserContextOptions = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const KEYBOARD = 320;

test("with a keyboard that shrinks only the visible area, the terminal's keys sit just above it", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  await terminalsAtPaneSize(page);
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    // A visual viewport the test moves: a headless browser opens no keyboard.
    await page.addInitScript(() => {
      const viewport = new EventTarget() as EventTarget & Record<string, number>;
      Object.assign(viewport, { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
      (window as unknown as { __keyboard: (height: number) => void }).__keyboard = (height) => {
        viewport.height = innerHeight - height;
        viewport.dispatchEvent(new Event("resize"));
      };
    });
    await page.routeWebSocket("**/api/terminal?*", (socket) => { socket.send("user@mac zoom % "); });
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}/pane/%250`);
    await page.getByRole("button", { name: "Terminal actions" }).tap();
    await page.getByRole("menuitem", { name: "Show keys" }).tap();
    const escape = page.getByRole("button", { name: "Escape" });
    await escape.waitFor();
    // Positive control: no keyboard, the keys at the bottom of the screen.
    const before = (await escape.boundingBox())!;
    expect(before.y + before.height).toBeGreaterThan(915 - 80);

    await page.evaluate((height) => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(height), KEYBOARD);
    await page.waitForFunction((top) => {
      const key = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Escape");
      return key ? key.getBoundingClientRect().bottom <= top : false;
    }, 915 - KEYBOARD);
    const after = (await escape.boundingBox())!;
    expect(after.y + after.height).toBeLessThanOrEqual(915 - KEYBOARD);
    expect(after.y + after.height).toBeGreaterThan(915 - KEYBOARD - 80);

    // The keyboard goes: the keys go back down.
    await page.evaluate(() => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(0));
    await page.waitForFunction(() => {
      const key = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Escape");
      return key ? key.getBoundingClientRect().bottom > 915 - 80 : false;
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

// On a desktop too: the keys under the terminal, which gives them the room
// (nothing of it is under them), each typed into the pane.
test("on a desktop the terminal's keys sit under it and type into its pane", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await terminalsAtPaneSize(page);
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const sent: string[] = [];
  try {
    await page.routeWebSocket("**/api/terminal?*", (socket) => {
      socket.onMessage((message) => { if (typeof message === "string") sent.push(message); });
      socket.send("user@mac zoom % ");
    });
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}/pane/%250`);
    await page.locator(".xterm-screen").waitFor();
    // A worker's terminal page has its options in its header on a desktop.
    await page.getByRole("button", { name: "Show keys" }).click();
    const tab = page.getByRole("button", { name: "Tab" });
    await tab.waitFor();
    const screen = (await page.locator(".xterm-screen").boundingBox())!;
    const bar = (await page.getByRole("button", { name: "Escape" }).boundingBox())!;
    expect(screen.y + screen.height).toBeLessThanOrEqual(bar.y);
    await tab.click();
    const typed = () => sent.map((m) => JSON.parse(m) as { type: string; data?: string }).filter((m) => m.type === "input").map((m) => m.data);
    expect(await waitUntil(() => (typed().includes("\t") ? typed() : null), { label: "the Tab key typed" })).toContain("\t");
    // Hidden again from the same place.
    await page.getByRole("button", { name: "Hide keys" }).click();
    await tab.waitFor({ state: "detached" });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

// Not fitted to the browser, a terminal keeps its pane's rows: the keys
// shorten its room, and its viewport, which cuts what does not fit, keeps the
// cursor's row in sight between the header and the keys, wherever the cursor
// is and however the pane changes size; hidden, the keys give the top back.
async function desktopKeys(height: number, output: string) {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 1440, height } });
  try {
    const page = await context.newPage();
    await terminalsAtPaneSize(page);
    page.setDefaultTimeout(8000);
    await page.routeWebSocket("**/api/terminal?*", (socket) => { socket.send(output); });
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}/pane/%250`);
    const prompt = page.locator(".xterm-rows > div", { hasText: "user@mac zoom %" });
    await prompt.waitFor();
    await page.getByRole("button", { name: "Show keys" }).click();
    const escape = page.getByRole("button", { name: "Escape" });
    await escape.waitFor();
    const header = (await page.locator("header").last().boundingBox())!;
    const promptInSight = (label: string) => waitUntil(async () => {
      const row = (await prompt.boundingBox())!;
      const keys = (await escape.boundingBox())!;
      return row.y + row.height <= keys.y && row.y >= header.y + header.height ? true : null;
    }, { label });
    return { fixture, context, page, header, promptInSight };
  } catch (err) {
    await context.close();
    fixture.stop();
    throw err;
  }
}
const rows = (count: number) => Array.from({ length: count }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`).join("\r\n");

test("on a desktop a terminal taller than its room with the keys shown keeps its cursor's row in sight, and its top when the keys go", async () => {
  const { fixture, context, page, header, promptInSight } = await desktopKeys(520, `${rows(30)}\r\nuser@mac zoom % `);
  try {
    await promptInSight("the cursor's row on the last line between the header and the keys");
    // What is scrolled past is cut, under the header, never over it.
    expect(await page.evaluate((y) => document.elementFromPoint(720, y + 5)?.closest("header") !== null, header.y)).toBe(true);
    await page.getByRole("button", { name: "Hide keys" }).click();
    const first = page.locator(".xterm-rows > div").first();
    await waitUntil(async () => ((await first.boundingBox())!.y >= header.y + header.height ? true : null), { label: "the screen's first row back in sight" });
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

test("on a desktop with the keys shown a prompt on a cleared screen's first row stays in sight", async () => {
  const { fixture, context, promptInSight } = await desktopKeys(520, `${rows(30)}\x1b[2J\x1b[Huser@mac zoom % `);
  try {
    await promptInSight("the first row's prompt between the header and the keys");
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

test("on a desktop with the keys shown a pane that grows keeps its cursor's row in sight", async () => {
  const { fixture, context, page, header, promptInSight } = await desktopKeys(700, `${rows(60)}\r\nuser@mac zoom % `);
  try {
    await promptInSight("the prompt in sight at 24 rows");
    // Resized a while after the keys opened, as a pane is in use.
    await page.waitForTimeout(1000);
    const next = fixture.connectState().snapshot;
    Object.assign(next.sessions[0]!.windows[0]!.panes![0]!, { paneHeight: 44 });
    fixture.emit("snapshot", next);
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.children.length === 44);
    // Grown, the screen is taller than its room between the header and the keys.
    const screen = (await page.locator(".xterm-screen").boundingBox())!;
    const keys = (await page.getByRole("button", { name: "Escape" }).boundingBox())!;
    expect(screen.height).toBeGreaterThan(keys.y - (header.y + header.height));
    await promptInSight("the prompt in sight at 44 rows");
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

// In a tab row the keys are in the ⋯ menu; chosen there, the terminal has
// the focus once the menu closes, not the menu's button.
test("on the Terminals page Show keys from the ⋯ menu leaves the terminal focused, so what is typed next reaches it", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await terminalsAtPaneSize(page);
  page.setDefaultTimeout(8000);
  const sent: string[] = [];
  try {
    await page.routeWebSocket("**/api/terminal?*", (socket) => {
      socket.onMessage((message) => { if (typeof message === "string") sent.push(message); });
      socket.send("user@mac zoom % ");
    });
    await page.goto(`${fixture.baseUrl}/terminals/pane/%250`);
    await page.locator(".xterm-screen").waitFor();
    await page.getByRole("button", { name: "Terminal actions" }).click();
    await page.getByRole("menuitem", { name: "Show keys" }).click();
    await page.getByRole("button", { name: "Tab" }).waitFor();
    await waitUntil(() => page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ? true : null), { label: "the terminal focused" });
    await page.keyboard.press("x");
    const typed = () => sent.map((m) => JSON.parse(m) as { type: string; data?: string }).filter((m) => m.type === "input").map((m) => m.data).join("");
    expect(await waitUntil(() => (typed().includes("x") ? typed() : null), { label: "x typed into the terminal" })).toContain("x");
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);
