import { expect, test } from "bun:test";
import type { BrowserContext, Page } from "playwright";
import type { AgentClientMessageDto } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// A link to a canvas in a reply opened a new browser tab and left the chat
// behind; the canvas's card in the same chat opens it over the page. The link
// does that now, and so does the canvas's path written as code or bare in the
// text. Which tab a
// click lands in, what a modifier key does, and whether the layer covers a
// phone's screen are the browser's, which happy-dom is not.

const browser = browserForFile();
const LINK = "the 3.21 release notes";
const CANVAS = "/canvas/zoom-canvas";
/** A canvas whose id has the shape every canvas's id has, for its path bare in
 *  the text: only that shape is read as one. */
const BARE_ID = "cnv_e2eBarePath";
const BARE = `/canvas/${BARE_ID}`;
/** Its title, which its path bare in the text is drawn as once read. */
const BARE_TITLE = "Test Connection 带参数设计";
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

async function openChat(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}${WORKER_PATH}?tab=chat`);
  await page.getByRole("link", { name: LINK, exact: true }).waitFor();
  await page.waitForTimeout(300);
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

test("a click on a canvas link, or on its path written as code, opens the canvas over the chat; closing it returns to the chat", async () => {
  const { fixture } = startChat();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const canvas = page.getByRole("dialog", { name: "Canvas", exact: true });
  const chat = `${WORKER_PATH}?tab=chat`;
  try {
    await openChat(page, fixture.baseUrl);
    expect(await state(page)).toEqual({ path: chat, canvas: null, chatBehind: true });

    await page.getByRole("link", { name: LINK, exact: true }).click();
    await canvas.waitFor();
    await canvas.getByRole("button", { name: "Close canvas", exact: true }).waitFor();
    // Over the page, inset from its edges, in this tab: no second one opened.
    expect(await state(page)).toEqual({ path: CANVAS, canvas: [16, 16, 1408, 868], chatBehind: true });
    expect(tabs(context)).toBe(1);

    await canvas.getByRole("button", { name: "Close canvas", exact: true }).click();
    await canvas.waitFor({ state: "detached" });
    expect(await state(page)).toEqual({ path: chat, canvas: null, chatBehind: true });

    // The path as code is a link of the same kind: drawn as code, inside it.
    const code = page.locator('[data-slot="transcript-row"] a > code', { hasText: CANVAS });
    expect(await code.evaluate((el) => {
      const link = el.parentElement!;
      const text = getComputedStyle(el);
      return { href: link.getAttribute("href"), sameColorAsLink: text.color === getComputedStyle(link).color, underlined: getComputedStyle(link).textDecorationLine, mono: /mono/i.test(text.fontFamily) };
    })).toEqual({ href: CANVAS, sameColorAsLink: true, underlined: "underline", mono: true });
    await code.click();
    await canvas.waitFor();
    expect(await state(page)).toEqual({ path: CANVAS, canvas: [16, 16, 1408, 868], chatBehind: true });
    expect(tabs(context)).toBe(1);
    // Back is a way out of it too.
    await page.goBack();
    await canvas.waitFor({ state: "detached" });
    expect(await state(page)).toEqual({ path: chat, canvas: null, chatBehind: true });

    // The path bare in the text is a link of the same kind, named by the canvas's title.
    expect(await bare(page).evaluate((link) => [link.getAttribute("href"), link.querySelector('[data-slot="canvas-title-icon"]') !== null])).toEqual([BARE, true]);
    await bare(page).click();
    await canvas.waitFor();
    expect(await state(page)).toEqual({ path: BARE, canvas: [16, 16, 1408, 868], chatBehind: true });
    expect(tabs(context)).toBe(1);
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
  const chat = `${WORKER_PATH}?tab=chat`;
  try {
    await openChat(page, fixture.baseUrl);

    const [held] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("link", { name: LINK, exact: true }).click({ modifiers: ["ControlOrMeta"] })
    ]);
    await held.waitForURL(`${fixture.baseUrl}${CANVAS}`);
    // The new tab has the canvas as a page of its own; this one stayed a chat.
    await held.getByRole("button", { name: "Canvas menu", exact: true }).waitFor();
    expect(await held.locator('[role="dialog"][aria-label="Canvas"]').count()).toBe(0);
    expect(await state(page)).toEqual({ path: chat, canvas: null, chatBehind: true });
    await held.close();

    // Another host's canvas is not this app's: a plain click opens a tab.
    const [other] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("link", { name: "the other host", exact: true }).click()
    ]);
    await other.waitForURL(elsewhere);
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
    expect(await state(page)).toEqual({ path: `${WORKER_PATH}?tab=chat`, canvas: null, chatBehind: true });

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
