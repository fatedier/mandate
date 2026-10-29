import { expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { featureMessageReplyMetadata } from "../src/shared/feature-message";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// A row's own time: hidden at rest, it shows on hover in the 16px
// gap above the row, right-aligned, touching neither the row nor the one
// above; a touch screen, which cannot hover, never shows it.
// That is for the rows with no action line (a worker's reply here): the
// user's message and a reply carry their time on the line under them
// (e2e/message-copy.test.ts).

const browser = browserForFile();

/** Ends the fixture's chat with a worker's reply, a row that keeps its hover time. */
async function withWorkerReply(page: Page) {
  await page.route("**/api/agents/workers/*/thread*", async (route) => {
    const answer = await (await route.fetch()).json() as { messages: Array<{ createdAt: string }> } & Record<string, unknown>;
    await route.fulfill({ json: { ...answer, messages: [...answer.messages, {
      id: "worker-reply", threadId: "zoom-thread", seq: 36, role: "user", source: "feature-message", sourceThreadId: "thr-f1", wakeId: null,
      createdAt: answer.messages.at(-1)!.createdAt,
      content: { type: "text", text: "Harness saved; the patch passes.", metadata: featureMessageReplyMetadata({ featureId: "f1", featureName: "Issue 72" }) }
    }] } });
  });
}

test("a row's time shows only on hover, in the gap above it, clear of both rows", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await withWorkerReply(page);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Harness saved; the patch passes.").waitFor();
    await page.waitForTimeout(300);
    // The last row, the worker's reply, and the one above it.
    const rows = page.locator('[data-slot="transcript-row"]');
    const last = rows.last();
    const time = last.locator('[data-slot="row-time"]');
    const opacity = () => time.evaluate((el) => getComputedStyle(el).opacity);
    expect(await opacity()).toBe("0");
    await last.hover({ position: { x: 40, y: 20 } });
    await page.waitForTimeout(300);
    expect(await opacity()).toBe("1");
    const seen = await last.evaluate((row) => {
      const time = row.querySelector('[data-slot="row-time"]')!.getBoundingClientRect();
      const content = row.firstElementChild!.getBoundingClientRect();
      // The row above is the user's message: its bubble, and its action line.
      const above = row.previousElementSibling!;
      const aboveLine = above.querySelector('[data-slot="row-actions"]')!;
      const box = row.getBoundingClientRect();
      return {
        timeBottom: time.bottom, timeTop: time.top, timeRight: time.right,
        contentTop: content.top, aboveMessageBottom: above.firstElementChild!.getBoundingClientRect().bottom,
        aboveLineBottom: aboveLine.getBoundingClientRect().bottom, aboveLineOpacity: getComputedStyle(aboveLine).opacity,
        rowTop: box.top, rowRight: box.right,
        text: row.querySelector('[data-slot="row-time"]')!.textContent, title: row.querySelector('[data-slot="row-time"]')!.getAttribute("title")
      };
    });
    await page.screenshot({ path: path.join(artifactDir("row-time-hover"), "desktop-hover.png") });
    expect(seen.timeBottom).toBeLessThanOrEqual(seen.contentTop + 0.5);
    // The message above keeps a line for its Copy that ends 8px over this row,
    // so the 16px time reaches into the line's lower edge. The
    // line is hidden while another row is hovered, and the time is clear of
    // the message itself.
    expect(Math.round(seen.rowTop - seen.aboveLineBottom)).toBe(8);
    expect(seen.aboveLineOpacity).toBe("0");
    expect(seen.timeTop).toBeGreaterThanOrEqual(seen.aboveMessageBottom - 0.5);
    expect(Math.abs(seen.timeRight - seen.rowRight)).toBeLessThan(1);
    expect(seen.text).toMatch(/^\d{2}:\d{2}$/);
    expect(seen.title).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}:\d{2}$/);
    // Off the row, it goes again.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    expect(await opacity()).toBe("0");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("on a touch screen a row's time is never shown", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    await withWorkerReply(page);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Harness saved; the patch passes.").waitFor();
    await page.locator('[data-slot="transcript-row"]').last().tap();
    await page.waitForTimeout(300);
    const times = await page.locator('[data-slot="row-time"]').evaluateAll((all) => ({ count: all.length, shown: all.filter((el) => getComputedStyle(el).display !== "none").length }));
    expect(times).toEqual({ count: 1, shown: 0 });
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

// A step that draws nothing (a send whose card goes under the sentence the
// turn writes next) takes no room, as before rows were framed: the rows either
// side of it stand as far apart as two that touch. Here the row above is the
// user's message, whose action line stands 8px over the next row.
test("a step that draws nothing takes no room", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.route("**/api/agents/workers/*/thread*", async (route) => {
      const answer = await (await route.fetch()).json() as { messages: Array<{ createdAt: string }> } & Record<string, unknown>;
      // The fixture's own time: no divider comes between them.
      const base = { threadId: "zoom-thread", sourceThreadId: null, createdAt: answer.messages.at(-1)!.createdAt };
      await route.fulfill({ json: { ...answer, messages: [...answer.messages,
        { ...base, id: "send-step", seq: 36, role: "assistant", source: "self", wakeId: "wake-c", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "ch1", toolName: "send_to_thread", args: { threadId: "thr_docs", text: "Update the docs" } }] } },
        { ...base, id: "send-result", seq: 37, role: "tool", source: "self", wakeId: "wake-c", content: { type: "tool_result", toolCallId: "ch1", toolName: "send_to_thread", result: { handoff: {
          id: "ho_1", kind: "thread", state: "delivered", text: "Update the docs", spoken: false, featureId: null, featureName: null, ownerThreadTitle: null,
          threadId: "thr_docs", threadTitle: "Docs", newThreadTitle: null, reply: null, reason: null, stop: null,
          createdAt: base.createdAt, updatedAt: base.createdAt, repliedAt: null
        } } } },
        { ...base, id: "after-step", seq: 38, role: "assistant", source: "self", wakeId: "wake-c", content: { type: "assistant", text: "After the send." } }
      ] } });
    });
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("After the send.").waitFor();
    await page.waitForTimeout(300);
    const seen = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="transcript-row"]')];
      const empty = rows.filter((row) => [...row.children].every((child) => child.getAttribute("data-slot") === "row-time"));
      const shown = rows.filter((row) => getComputedStyle(row).display !== "none");
      const after = shown.find((row) => row.textContent?.includes("After the send."))!;
      const before = shown[shown.indexOf(after) - 1]!;
      const gapOver = (row: HTMLElement) => Math.round(row.getBoundingClientRect().top - (row.previousElementSibling as HTMLElement).getBoundingClientRect().bottom);
      return {
        empty: empty.length,
        emptyShown: empty.filter((row) => getComputedStyle(row).display !== "none").length,
        // The empty row lies between them in the document.
        between: before.nextElementSibling !== after,
        beforeHasLine: before.querySelector(':scope > [data-slot="row-actions"]') !== null,
        gap: Math.round(after.getBoundingClientRect().top - before.getBoundingClientRect().bottom),
        // Two rows of the same kinds that touch: a reply's line, then the user's message.
        touching: gapOver(before)
      };
    });
    expect(seen.empty).toBe(1);
    expect(seen.emptyShown).toBe(0);
    expect(seen.between).toBe(true);
    expect(seen.beforeHasLine).toBe(true);
    expect(seen.gap).toBe(8);
    expect(seen.touching).toBe(8);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);
