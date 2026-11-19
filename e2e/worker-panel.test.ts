import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { emptyPlan, type WorkerPlanDto } from "../src/shared/api/plans";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { look, trackPageErrors } from "./helpers/page-diagnostics";
import { settle } from "./helpers/settle";

const browser = browserForFile();

const at = "2026-09-27T10:00:00.000Z";
const plan: WorkerPlanDto = {
  ...emptyPlan("zoom-worker"),
  steps: [{
    id: 1, title: "Cut the release branch", status: "in_progress", note: "",
    createdAt: at, startedAt: at, blockedAt: null, completedAt: null, updatedAt: at
  }],
  updatedAt: at
};

test("a thread opens its worker in the panel beside the chat, and either side maximizes", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setPlan(plan);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.locator('[data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
    // The worker is not waiting on the user: it opens on its plan.
    await panel.getByText("Cut the release branch").waitFor();
    // The param has done its job.
    expect(new URL(page.url()).search).toBe("");
    // The thread's measured context use shows in its header (a container
    // query decides how much of the pill fits; it needs a container to ask).
    await page.locator('[data-slot="pane-header"] [aria-label$="compression budget."]').waitFor({ state: "visible" });

    await panel.getByRole("tab", { name: "Chat", exact: true }).click();
    await panel.getByPlaceholder("Message the worker…").waitFor();

    // An even split at 1440 minus the sidebar leaves each side over 560px.
    const chat = page.locator('[data-slot="thread-chat"]');
    const chatBox = (await chat.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    expect(chatBox.width).toBeGreaterThanOrEqual(560);
    expect(panelBox.width).toBeGreaterThanOrEqual(560);

    await panel.getByRole("button", { name: "Maximize panel" }).click();
    await chat.waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await chat.waitFor({ state: "visible" });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20000);

// ── the worker chat fills its space: the composer sits at the bottom ──────
// The chat tab was "at least 60vh" rather than the height it had, so an empty
// chat floated its composer mid-panel (y 562–668 of 900) and a chat with
// history stretched its pane (3705px) and opened on its oldest message with
// the composer off-screen (y 3607).

/** Where the composer is, and what scrolls: the chat's own list (the one in
 *  `scope`: the thread's own chat sits beside the panel), or the pane. */
async function layout(page: Page, scope = "main") {
  return page.evaluate((scope) => {
    const composer = document.querySelector('textarea[placeholder="Message the worker…"]')!;
    let box = composer.parentElement!;
    while (box.parentElement && box.getBoundingClientRect().height < 60) box = box.parentElement;
    const main = document.querySelector("main")!;
    const list = [...document.querySelector(scope)!.querySelectorAll<HTMLElement>('[data-slot="transcript-column"]')]
      .map((column) => column.parentElement!)
      .find((scroller) => scroller.contains(composer) === false && scroller.closest('[data-slot="worker-panel"], main') !== null && scroller.querySelector("*") !== null && getComputedStyle(scroller).overflowY === "auto" && (scroller.closest('[role="dialog"]') === null));
    const rect = box.getBoundingClientRect();
    return {
      composerBottom: Math.round(rect.bottom),
      viewport: window.innerHeight,
      mainScrolls: main.scrollHeight > main.clientHeight + 1,
      listScrolls: list ? list.scrollHeight > list.clientHeight + 1 : false,
      listAtBottom: list ? list.scrollHeight - list.scrollTop - list.clientHeight < 4 : false
    };
  }, scope);
}

async function openChat(page: Page, url: string, empty: boolean) {
  if (empty) {
    // A worker with nothing said yet.
    await page.route((u) => u.pathname.endsWith("/thread") || u.pathname.includes("/threads/zoom-thread"), (route) =>
      route.fulfill({ json: { thread: { id: "zoom-thread" }, messages: [], hasMore: false, contextUsage: null } }));
  }
  await page.goto(url);
  await page.getByRole("tab", { name: "Chat", exact: true }).first().click();
  await page.getByPlaceholder("Message the worker…").waitFor();
  if (!empty) await page.getByText("Message 35.", { exact: false }).first().waitFor();
  await settle(page);
}

test("a worker chat with history in the thread's panel keeps its composer at the panel's bottom and scrolls its own list", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setPlan(plan);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    await openChat(page, `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, false);
    const panel = (await page.locator('[data-slot="worker-panel"]').boundingBox())!;
    const seen = await layout(page, '[data-slot="worker-panel"]');
    await look(page, "panel-full");
    // At the panel's bottom, and the pane itself does not scroll.
    expect(seen.composerBottom).toBeGreaterThan(panel.y + panel.height - 90);
    expect(seen.composerBottom).toBeLessThanOrEqual(panel.y + panel.height);
    expect(seen.mainScrolls).toBe(false);
    // History scrolls in the chat's own list, opened on the latest message.
    expect(seen.listScrolls).toBe(true);
    expect(seen.listAtBottom).toBe(true);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);

test("an empty worker chat in the thread's panel keeps its composer at the panel's bottom", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setPlan(plan);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    await openChat(page, `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, true);
    const panel = (await page.locator('[data-slot="worker-panel"]').boundingBox())!;
    const seen = await layout(page);
    await look(page, "panel-empty");
    expect(seen.composerBottom).toBeGreaterThan(panel.y + panel.height - 60);
    expect(seen.composerBottom).toBeLessThanOrEqual(panel.y + panel.height);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);

test("on a phone, an empty worker chat in the full-height sheet keeps its composer at the sheet's bottom", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setPlan(plan);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page.setDefaultTimeout(8000);
  try {
    // ?worker= opens the sheet at full height on that worker.
    await openChat(page, `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, true);
    const sheet = (await page.locator('[data-slot="worker-sheet"]').boundingBox())!;
    const seen = await layout(page);
    await look(page, "sheet-phone-empty");
    expect(seen.composerBottom).toBeGreaterThan(sheet.y + sheet.height - 70);
    expect(seen.composerBottom).toBeLessThanOrEqual(sheet.y + sheet.height);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);

// The sheet holds its height around a chat only (other views
// grow so the worker's tabs stay pinned): a chat with history still keeps
// its composer at the sheet's bottom and scrolls its own list.
test("on a phone, a worker chat with history in the full-height sheet keeps its composer at the sheet's bottom and scrolls its own list", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setPlan(plan);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page.setDefaultTimeout(8000);
  try {
    await openChat(page, `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, false);
    const sheet = (await page.locator('[data-slot="worker-sheet"]').boundingBox())!;
    const seen = await page.evaluate(() => {
      const body = document.querySelector('[data-slot="worker-panel-sheet"]')!.parentElement!;
      const composer = document.querySelector('textarea[placeholder="Message the worker…"]')!;
      const list = document.querySelector('[data-slot="worker-sheet"] [data-slot="transcript-column"]')!.parentElement!;
      return {
        composerBottom: Math.round(composer.getBoundingClientRect().bottom),
        bodyScrolls: body.scrollHeight > body.clientHeight + 1,
        listScrolls: list.scrollHeight > list.clientHeight + 1
      };
    });
    await look(page, "sheet-phone-full");
    expect(seen.composerBottom).toBeGreaterThan(sheet.y + sheet.height - 90);
    expect(seen.composerBottom).toBeLessThanOrEqual(sheet.y + sheet.height);
    expect(seen.bodyScrolls).toBe(false);
    expect(seen.listScrolls).toBe(true);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);

test("on a phone, a long plan in the full-height sheet scrolls the sheet's own body, the one the sheet resets at half height", async () => {
  const fixture = startWorkspaceFixture();
  const step = (id: number) => ({
    id, title: `Step ${id}: cut, test and tag the release branch`, status: "pending" as const, note: "",
    createdAt: at, startedAt: null, blockedAt: null, completedAt: null, updatedAt: at
  });
  fixture.setPlan({ ...plan, steps: Array.from({ length: 40 }, (_, i) => step(i + 1)) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page.setDefaultTimeout(8000);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
    const sheet = page.locator('[data-slot="worker-sheet"]');
    await sheet.getByRole("tab", { name: "Plan", exact: true }).click();
    await sheet.getByText("Step 40:", { exact: false }).waitFor({ state: "attached" });
    const box = (await sheet.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 900);
    // Until the wheel has moved something: the sheet's body, or anything in it.
    await page.waitForFunction(() => {
      const body = document.querySelector<HTMLElement>('[data-slot="bottom-sheet-body"]')!;
      return body.scrollTop > 0 || [...body.querySelectorAll<HTMLElement>("*")].some((el) => el.scrollTop > 0);
    });
    const scrolled = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('[data-slot="bottom-sheet-body"]')!;
      const inner = [...body.querySelectorAll<HTMLElement>("*")].filter((el) => el.scrollTop > 0).map((el) => el.className.slice(0, 40));
      return { body: body.scrollTop, inner };
    });
    // The sheet's body owns the scroll (BottomSheet resets it when the sheet
    // settles at half); nothing inside it scrolls on its own.
    expect(scrolled.body).toBeGreaterThan(0);
    expect(scrolled.inner).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);
