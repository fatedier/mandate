import { expect, test } from "bun:test";
import type { BrowserContext, Page } from "playwright";
import type { AgentClientMessageDto } from "../src/shared/api-contracts";
import { startWorkspaceFixture, THREAD_ID, workerPath } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { trackRequests } from "./helpers/settle";

// A link to a canvas in a reply opened a new browser tab and left the chat
// behind; the canvas's card in the same chat opens it in place. The link does
// that now, and so does the canvas's path written as code or bare in the
// text: on a desktop as a tab of the thread's panel, on a phone over the
// screen. Which tab a click lands in, what a modifier key does, and whether
// the layer covers a phone's screen are the browser's, which happy-dom is not.

const browser = browserForFile();
const LINK = "the 3.21 release notes";
const CANVAS = "/canvas/zoom-canvas";
/** A canvas whose id has the shape every canvas's id has, for its path bare in
 *  the text: only that shape is read as one. */
const BARE_ID = "cnv_e2eBarePath";
const BARE = `/canvas/${BARE_ID}`;
/** Its title, which its path bare in the text is drawn as once read. */
const BARE_TITLE = "Garden planner layout";
const row = { threadId: "zoom-thread", sourceThreadId: null, wakeId: null, createdAt: "2026-09-13T00:00:00.000Z" } as const;

/** The worker's chat with one reply that names the canvas three ways: a link,
 *  its path as code, and its address on another host; and a second canvas by
 *  its path bare in the text. */
function startChat() {
  const fixture = startWorkspaceFixture();
  const elsewhere = new URL(fixture.baseUrl);
  elsewhere.hostname = "localhost";
  const reply = [
    `The write-up is ready: [${LINK}](${CANVAS}). It covers the two breaking changes.`,
    "",
    `The defaults, old and new, are in the same canvas, at \`${CANVAS}\`.`,
    "",
    // Glued to CJK text with no space between, as a Chinese reply writes it.
    `报告：${BARE}`,
    "",
    `The staging copy is at [the other host](${elsewhere.origin}${CANVAS}).`
  ].join("\n");
  const messages: AgentClientMessageDto[] = [
    { ...row, id: "m-1", seq: 1, role: "user", source: "user", content: { type: "text", text: "Write up what changed in project-1 3.21." } },
    { ...row, id: "m-2", seq: 2, role: "assistant", source: "self", content: { type: "assistant", text: reply } }
  ];
  fixture.setMessages(messages);
  fixture.addCanvas(BARE_ID, BARE_TITLE);
  return { fixture, elsewhere: `${elsewhere.origin}${CANVAS}` };
}

/** The worker's chat, in its thread's panel (a phone's sheet), with what it
 *  reads loaded: the bare path's title comes by a read of its own. */
async function openChat(page: Page, baseUrl: string) {
  const loads = await trackRequests(page);
  await page.goto(`${baseUrl}${workerPath("chat")}`);
  await page.getByRole("link", { name: LINK, exact: true }).waitFor();
  await loads.idle();
}

/** Where the page is, whether the canvas is over it, and whether the chat is
 *  still drawn behind. */
/** The canvas once it has stopped moving (it fades and grows in). */
const settled = (page: Page) => page.waitForFunction(() => {
  const dialog = document.querySelector('[role="dialog"][aria-label="Canvas"]');
  return !dialog || [dialog, dialog.parentElement].every((el) => !el || el.getAnimations().length === 0);
});
const state = async (page: Page) => { await settled(page); return measure(page); };
const measure = (page: Page) => page.evaluate((link) => {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Canvas"]');
  const box = dialog?.getBoundingClientRect();
  return {
    path: `${location.pathname}${location.search}`,
    canvas: box ? [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)] : null,
    chatBehind: [...document.querySelectorAll('[data-slot="transcript-row"] a')].some((a) => a.textContent === link)
  };
}, LINK);

const tabs = (context: BrowserContext) => context.pages().length;

/** The link the second canvas's path bare in the text became, drawn as the
 *  canvas's title. */
const bare = (page: Page) => page.locator('[data-slot="transcript-row"] a', { hasText: BARE_TITLE });

test("on a desktop a click on a canvas link, on its path written as code, or on its path bare opens the canvas in a tab of the thread's panel", async () => {
  const { fixture } = startChat();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const panel = page.locator('[data-slot="worker-panel"]');
  /** The canvas tab shown in the panel, with no Canvas modal and no new browser tab. */
  const shown = async (canvasId: string) => {
    await panel.locator(`[data-canvas-tab="${canvasId}"][aria-selected="true"]`).waitFor();
    await panel.locator('[data-slot="canvas-tab-view"]:not(.hidden) iframe').waitFor();
    expect([new URL(page.url()).pathname, await page.getByRole("dialog", { name: "Canvas", exact: true }).count(), tabs(context)])
      .toEqual([`/threads/${THREAD_ID}`, 0, 1]);
  };
  /** Back to the worker's chat in the panel. */
  const backToChat = async () => {
    await panel.locator('[data-worker-tab="zoom-worker"]').click();
    await panel.getByRole("link", { name: LINK, exact: true }).waitFor();
  };
  try {
    await openChat(page, fixture.baseUrl);
    expect(await state(page)).toEqual({ path: `/threads/${THREAD_ID}`, canvas: null, chatBehind: true });

    await panel.getByRole("link", { name: LINK, exact: true }).click();
    await shown("zoom-canvas");

    // The path as code is a link of the same kind: drawn as code, inside it.
    await backToChat();
    const code = panel.locator('[data-slot="transcript-row"] a > code', { hasText: CANVAS });
    expect(await code.evaluate((el) => {
      const link = el.parentElement!;
      const text = getComputedStyle(el);
      return { href: link.getAttribute("href"), sameColorAsLink: text.color === getComputedStyle(link).color, underlined: getComputedStyle(link).textDecorationLine, mono: /mono/i.test(text.fontFamily) };
    })).toEqual({ href: CANVAS, sameColorAsLink: true, underlined: "none", mono: true });
    await code.click();
    // The same canvas: its tab again, not a second one.
    await shown("zoom-canvas");
    expect(await panel.locator("[data-canvas-tab]").count()).toBe(1);

    // The path bare in the text is a link of the same kind, named by the canvas's title.
    await backToChat();
    expect(await bare(page).evaluate((link) => [link.getAttribute("href"), link.querySelector('[data-slot="canvas-link-icon"]') !== null])).toEqual([BARE, true]);
    await bare(page).click();
    await shown(BARE_ID);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60000);

test("with the new-tab key held the link opens a tab, and a canvas address on another host always does", async () => {
  const { fixture, elsewhere } = startChat();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const chat = `/threads/${THREAD_ID}`;
  try {
    await openChat(page, fixture.baseUrl);

    const [held] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("link", { name: LINK, exact: true }).click({ modifiers: ["ControlOrMeta"] })
    ]);
    // The new tab goes to the canvas's own address, and this one stayed a
    // chat. Only its address is waited for: the canvas as a page of its own
    // is canvas-report's, and driving the second full app here hung twice
    // under load in Playwright's wait for its load.
    await held.waitForURL(`${fixture.baseUrl}${CANVAS}`, { waitUntil: "commit" });
    expect(await state(page)).toEqual({ path: chat, canvas: null, chatBehind: true });
    await held.close();

    // Another host's canvas is not this app's: a plain click opens a tab.
    const [other] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("link", { name: "the other host", exact: true }).click()
    ]);
    await other.waitForURL(elsewhere, { waitUntil: "commit" });
    expect(await state(page)).toEqual({ path: chat, canvas: null, chatBehind: true });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60000);

test("on a phone a tap on the link opens the canvas over the whole screen", async () => {
  const { fixture } = startChat();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const canvas = page.getByRole("dialog", { name: "Canvas", exact: true });
  try {
    await openChat(page, fixture.baseUrl);
    await page.getByRole("link", { name: LINK, exact: true }).tap();
    await canvas.waitFor();
    await canvas.getByRole("button", { name: "Close canvas", exact: true }).waitFor();
    expect(await state(page)).toEqual({ path: CANVAS, canvas: [0, 0, 390, 844], chatBehind: true });
    expect(tabs(context)).toBe(1);

    await canvas.getByRole("button", { name: "Close canvas", exact: true }).tap();
    await canvas.waitFor({ state: "detached" });
    expect(await state(page)).toEqual({ path: `/threads/${THREAD_ID}`, canvas: null, chatBehind: true });

    // So does a tap on its path bare in the text.
    await bare(page).tap();
    await canvas.waitFor();
    expect(await state(page)).toEqual({ path: BARE, canvas: [0, 0, 390, 844], chatBehind: true });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60000);
