import { expect, test } from "bun:test";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// A turn that ends without a reply. The agent tidied up and had nothing to
// add; the last thing the turn drew was a folded run of tool calls, which is
// also what a turn still working looks like. Its last row now has an action
// line of its own, the one a reply has, without Copy: under the sentence the
// agent closed with, the time; with no such sentence, the words that it
// finished and the time. Most recent of its kind, it always shows.
//
// The fixture's chat ends on the user's Message 35, after reply 34.

const browser = browserForFile();
const CLOSING = "The install guide rewrite is finished and its review flag is cleared. Nothing is waiting on a worker.";

/** Appends to the fixture's chat a turn that calls tools and says nothing. */
async function withSilentTurn(page: Page, closes: boolean) {
  await page.route("**/api/agents/workers/*/thread*", async (route) => {
    const answer = await (await route.fetch()).json() as { messages: Array<{ createdAt: string }> } & Record<string, unknown>;
    const at = answer.messages.at(-1)!.createdAt;
    const started = new Date(Date.parse(at) - 20_000).toISOString();
    const base = { threadId: "zoom-thread", sourceThreadId: null, createdAt: at, wakeId: "wake-silent", source: "self" };
    const step = (id: string, seq: number, toolCalls: unknown[]) => ({ ...base, id, seq, role: "assistant", wakeStartedAt: started, content: { type: "assistant", text: "", toolCalls } });
    const result = (id: string, seq: number, toolCallId: string, toolName: string) => ({ ...base, id, seq, role: "tool", content: { type: "tool_result", toolCallId, toolName, result: { ok: true } } });
    await route.fulfill({ json: { ...answer, messages: [...answer.messages,
      step("silent-1", 36, [{ toolCallId: "s1", toolName: "read_plan", args: {} }]),
      result("silent-r1", 37, "s1", "read_plan"),
      step("silent-2", 38, [{ toolCallId: "s2", toolName: "dismiss_work_item", args: {} }, { toolCallId: "s3", toolName: "memory_update", args: {} }]),
      result("silent-r2", 39, "s2", "dismiss_work_item"),
      result("silent-r3", 40, "s3", "memory_update"),
      ...(closes ? [
        step("silent-3", 41, [{ toolCallId: "s4", toolName: "end_sweep", args: { reason: CLOSING } }]),
        result("silent-r4", 42, "s4", "end_sweep")
      ] : []),
      step("silent-end", 43, [])
    ] } });
  });
}

const lastRow = (page: Page) => page.locator('[data-slot="transcript-row"]').filter({ has: page.locator('[data-slot="tool-run-line"]') }).last();

/** The ending as drawn: what is above its line, how far, and what the line says and shows. */
async function endingOf(row: Locator) {
  return row.evaluate((el) => {
    const line = el.querySelector<HTMLElement>('[data-slot="row-actions"]')!;
    const run = el.querySelector<HTMLElement>('[data-slot="tool-run-line"]')!;
    const sentence = el.querySelector<HTMLElement>('[data-slot="turn-settled"]');
    const above = (sentence ?? run).getBoundingClientRect();
    const lineBox = line.getBoundingClientRect();
    // The words and the time share one padded span.
    const words = line.querySelector('[data-slot="row-stamp"]')!.parentElement!;
    const inset = (node: Element) => node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft);
    return {
      says: line.textContent,
      runSays: run.textContent,
      sentence: sentence?.textContent ?? null,
      sentenceUnderRun: sentence ? sentence.getBoundingClientRect().top >= run.getBoundingClientRect().bottom - 0.5 : null,
      sentenceColor: sentence ? getComputedStyle(sentence).color : null,
      runColor: getComputedStyle(run).color,
      opacity: getComputedStyle(line).opacity,
      lineHeight: lineBox.height,
      underLast: Math.round((lineBox.top - above.bottom) * 10) / 10,
      controls: line.querySelectorAll("button").length,
      // The line's words begin on the row's left edge, as its run line's do.
      leftOfWords: Math.round((inset(words) - inset(run)) * 10) / 10,
      withinRow: lineBox.right <= el.getBoundingClientRect().right + 0.5
    };
  });
}

test("with a mouse a turn that closed with a sentence shows it under its run, and the time 4px under the sentence", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await withSilentTurn(page, true);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText(CLOSING).waitFor();
    await page.waitForTimeout(300);
    await page.mouse.move(5, 5);
    const seen = await endingOf(lastRow(page));
    await page.screenshot({ path: path.join(artifactDir("turn-endings"), "settled.png") });
    expect(seen.sentence).toBe(CLOSING);
    expect(seen.sentenceUnderRun).toBe(true);
    // The closing call left the run: two calls are counted beside the plan, not three.
    expect(seen.runSays).toBe("Read a plan, used 2 tools");
    // The agent's words in the secondary colour, as its run line is.
    expect(seen.sentenceColor).toBe(seen.runColor);
    expect(seen.says).toMatch(/^\d{2}:\d{2}$/);
    expect({ opacity: seen.opacity, lineHeight: seen.lineHeight, underLast: seen.underLast, controls: seen.controls })
      .toEqual({ opacity: "1", lineHeight: 24, underLast: 4, controls: 0 });
    // The last reply above keeps its line in sight: the silent turn after it does not hide it.
    const reply = page.locator('[data-slot="transcript-row"]').filter({ hasText: "Message 34." });
    expect(await reply.locator('[data-slot="row-actions"]').evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

test("with a mouse a turn that said nothing at all says that it finished, 4px under its run line", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await withSilentTurn(page, false);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Finished without a reply").waitFor();
    await page.waitForTimeout(300);
    await page.mouse.move(5, 5);
    const seen = await endingOf(lastRow(page));
    await page.screenshot({ path: path.join(artifactDir("turn-endings"), "silent.png") });
    expect(seen.sentence).toBe(null);
    expect(seen.says).toMatch(/^Finished without a reply · \d{2}:\d{2}$/);
    expect({ opacity: seen.opacity, lineHeight: seen.lineHeight, underLast: seen.underLast, controls: seen.controls, leftOfWords: seen.leftOfWords })
      .toEqual({ opacity: "1", lineHeight: 24, underLast: 4, controls: 0, leftOfWords: 0 });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

test("on a touch screen the line stands 10px under the turn's last thing and fits a phone's width", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await withSilentTurn(page, false);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Finished without a reply").waitFor();
    await page.waitForTimeout(300);
    const seen = await endingOf(lastRow(page));
    await page.screenshot({ path: path.join(artifactDir("turn-endings"), "phone-silent.png") });
    expect({ opacity: seen.opacity, lineHeight: seen.lineHeight, underLast: seen.underLast, withinRow: seen.withinRow })
      .toEqual({ opacity: "1", lineHeight: 24, underLast: 10, withinRow: true });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);
