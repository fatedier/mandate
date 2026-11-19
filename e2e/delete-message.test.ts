import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";

/**
 * Deleting a message of one's own that the agent has not answered, through
 * the compiled server: Delete on the message's own line beside Copy, shown
 * as that line is (on hover with a mouse, always on a touch screen), asked
 * once, then gone for good.
 */

const browser = browserForFile();
let server: RunningServer;
const ids = { thread: "", answered: "", stray: "", phoneThread: "", phoneStray: "" };

beforeAll(async () => {
  server = await startServer({
    configured: true,
    label: "delete-message",
    seed(dataDir) {
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        // One conversation per page that deletes: an answered message, then
        // one a stopped turn left with nothing after it.
        const seedThread = (title: string) => {
          const thread = agents.createManagerThread(title);
          const answered = agents.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Compare the two recipe sources." } });
          agents.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "The first covers most of the recipes; the rest come from the second." } });
          const stray = agents.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "waf" } });
          return { thread: thread.id, answered: answered.id, stray: stray.id };
        };
        const desktop = seedThread("Recipe sources");
        const phone = seedThread("Recipe sources on a phone");
        Object.assign(ids, { thread: desktop.thread, answered: desktop.answered, stray: desktop.stray, phoneThread: phone.thread, phoneStray: phone.stray });
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => { server?.cleanup(); });

async function open(viewport: { width: number; height: number }, route: string): Promise<Page> {
  const phone = viewport.width < 768;
  const page = await browser.newPage({ viewport, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}${route}`);
  return page;
}

async function lookBoth(page: Page, name: string): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  await look(page, `${name}-light`, { animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await look(page, `${name}-dark`, { animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
}

const row = (page: Page, messageId: string) => page.locator(`[data-slot="transcript-row"][data-row-key="${messageId}"]`);
const lineOpacity = (page: Page, messageId: string) => row(page, messageId).locator('[data-slot="row-actions"]').evaluate((el) => getComputedStyle(el).opacity);

test("on a desktop Delete shows on the unanswered message's line as Copy does, asks once, and the message is gone for good", async () => {
  const page = await open({ width: 1440, height: 900 }, `/threads/${ids.thread}`);
  try {
    const stray = row(page, ids.stray);
    await stray.waitFor({ timeout: 15_000 });
    const remove = stray.locator('[data-slot="delete-message"]');
    // The answered message's line is as it was; the unanswered one's ends with Delete.
    expect(await row(page, ids.answered).locator('[data-slot="row-actions"] button').evaluateAll((all) => all.map((b) => b.getAttribute("aria-label")))).toEqual(["Copy message", "Share as image"]);
    expect(await stray.locator('[data-slot="row-actions"] button').evaluateAll((all) => all.map((b) => b.getAttribute("aria-label")))).toEqual(["Copy message", "Share as image", "Delete message"]);
    // Out of sight until the row is hovered, as the line is today.
    await page.mouse.move(5, 5);
    await page.waitForFunction((id) => getComputedStyle(document.querySelector(`[data-slot="transcript-row"][data-row-key="${id}"] [data-slot="row-actions"]`)!).opacity === "0", ids.stray);
    await stray.hover();
    await page.waitForFunction((id) => getComputedStyle(document.querySelector(`[data-slot="transcript-row"][data-row-key="${id}"] [data-slot="row-actions"]`)!).opacity === "1", ids.stray);
    await lookBoth(page, "desktop-line-hovered");

    // Asked first; Cancel leaves it.
    await remove.click();
    const dialog = page.locator("[data-confirm-dialog]");
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain("Delete this message?");
    expect(await dialog.textContent()).toContain("It is removed from the conversation for good. The agent will not see it.");
    await lookBoth(page, "desktop-confirm");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    expect(await stray.count()).toBe(1);

    // Confirmed: gone here, and still gone after a reload.
    await stray.hover();
    await remove.click();
    await page.locator("[data-confirm-dialog]").getByRole("button", { name: "Delete", exact: true }).click();
    await stray.waitFor({ state: "detached" });
    expect(await row(page, ids.answered).count()).toBe(1);
    await page.reload();
    await row(page, ids.answered).waitFor({ timeout: 15_000 });
    expect(await row(page, ids.stray).count()).toBe(0);
    expect(await pageOverflow(page)).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("on a phone the line always shows, with Delete on it", async () => {
  const page = await open({ width: 390, height: 844 }, `/threads/${ids.phoneThread}`);
  try {
    const stray = row(page, ids.phoneStray);
    await stray.waitFor({ timeout: 15_000 });
    expect(await lineOpacity(page, ids.phoneStray)).toBe("1");
    const remove = stray.locator('[data-slot="delete-message"]');
    expect(await remove.isVisible()).toBe(true);
    // The buttons stand far enough apart for their touch areas not to overlap.
    const boxes = await stray.locator('[data-slot="row-actions"] button').evaluateAll((all) => all.map((b) => { const r = b.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
    expect(boxes.length).toBe(3);
    expect(boxes.slice(1).map((box, i) => box.left - boxes[i]!.right >= 16)).toEqual([true, true]);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "phone-line");
    await remove.tap();
    await page.locator("[data-confirm-dialog]").getByRole("button", { name: "Delete", exact: true }).tap();
    await stray.waitFor({ state: "detached" });
  } finally {
    await page.close();
  }
}, 60_000);
