import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { assertStubProvider, respond, seedStubProvider } from "./helpers/responses-stub.js";

/**
 * Back in the personal agent's conversation after a while: a line marks
 * where what the user has not read begins, and while it is above the view a
 * bar above the composer says how many replies are new and goes to it. The
 * replies since the point read to are more than the first page holds, so the
 * page before it is loaded to reach the point.
 */

const NEW_REPLIES = 60;
let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      return respond("n1", { text: "Noted." });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port, (config) => {
        config.agent = { ...config.agent, personalAgentName: "Juno" };
      });
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const thread = agents.getOrCreatePersonalThread();
        agents.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Did CI pass?" } });
        const read = agents.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Still running; I will tell you." } });
        agents.markThreadSeen(thread.id, read.seq);
        for (let n = 1; n <= NEW_REPLIES; n += 1) {
          agents.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: `Update ${n}: the duty check ran.` } });
        }
      } finally {
        store.db.close();
      }
    }
  });
  await assertStubProvider(server.baseUrl, stub.port);
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}/agent`);
  return page;
}

/** The visible box of an element inside the chat's scroller, clipped to it. */
async function shownBox(page: Page, selector: string): Promise<{ top: number; bottom: number } | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const scroller = el?.closest(".overflow-y-auto");
    if (!el || !scroller) return null;
    const box = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    return { top: Math.max(box.top, view.top) - view.top, bottom: Math.min(box.bottom, view.bottom) - view.top };
  }, selector);
}

test("a line marks the first new reply, a bar goes to it, and the line goes once the user writes", async () => {
  const page = await open();
  try {
    const chat = page.locator('[data-slot="agent-chat"]');
    await chat.getByText(`Update ${NEW_REPLIES}: the duty check ran.`).waitFor({ timeout: 15_000 });
    // The first page holds the last 50 rows: the one before it is loaded to reach the point.
    const line = page.locator('[data-slot="new-replies-line"]');
    await line.waitFor({ state: "attached", timeout: 15_000 });
    expect(await line.textContent()).toBe("New");
    expect(await page.evaluate(() => document.querySelector('[data-slot="new-replies-line"]')?.nextElementSibling?.textContent ?? "")).toContain("Update 1: the duty check ran.");

    // At the newest, with the line far above: the bar, clear of the last reply.
    const bar = page.getByRole("button", { name: "Jump to the first new reply" });
    await bar.waitFor({ timeout: 10_000 });
    expect(await bar.textContent()).toBe(`${NEW_REPLIES} new replies`);
    const barBox = (await bar.boundingBox())!;
    const lastReply = chat.getByText(`Update ${NEW_REPLIES}: the duty check ran.`);
    const lastBox = (await lastReply.boundingBox())!;
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barBox.y);

    await bar.click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-slot="new-replies-line"]');
      const scroller = el?.closest(".overflow-y-auto");
      if (!el || !scroller) return false;
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      return top >= 0 && top < 48;
    }, undefined, { timeout: 5_000 });
    await bar.waitFor({ state: "detached", timeout: 5_000 });
    await page.getByRole("button", { name: "Scroll to latest message" }).waitFor({ timeout: 5_000 });
    expect(await shownBox(page, '[data-slot="new-replies-line"]')).not.toBeNull();
    // Read on past the line: it is above the view again, and the bar stays gone.
    await page.locator('[data-slot="new-replies-line"]').evaluate((el) => {
      const scroller = el.closest(".overflow-y-auto")!;
      scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-slot="new-replies-line"]');
      const scroller = el?.closest(".overflow-y-auto");
      return !!el && !!scroller && el.getBoundingClientRect().bottom < scroller.getBoundingClientRect().top;
    }, undefined, { timeout: 5_000 });
    await page.waitForTimeout(300);
    expect(await bar.count()).toBe(0);

    // The user writes: the line goes.
    const box = page.getByPlaceholder("Ask about any thread or worker, or tell one what to do");
    await box.fill("Thanks, I read them.");
    await box.press("Enter");
    await line.waitFor({ state: "detached", timeout: 10_000 });

    // Back later, all of it read: no line.
    await page.reload();
    await chat.getByText("Thanks, I read them.").waitFor({ timeout: 15_000 });
    await chat.getByText("Noted.").waitFor({ timeout: 15_000 });
    expect(await line.count()).toBe(0);
  } finally {
    await page.close();
  }
}, 60_000);
