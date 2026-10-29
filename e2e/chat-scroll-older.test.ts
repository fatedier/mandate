import { expect, test } from "bun:test";
import path from "node:path";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// Older messages load as the reader scrolls near the top, in
// place of a "Load 50 older" button: the message the reader was on stays
// where it was while the older page lands above it.
const browser = browserForFile();

function message(seq: number) {
  const at = new Date(Date.UTC(2026, 9, 9, 8, 0, seq)).toISOString();
  return seq % 2
    ? { id: `msg_${seq}`, threadId: "zoom-thread", seq, role: "user", source: "user", sourceThreadId: null, wakeId: null, createdAt: at, content: { type: "text", text: `Question ${seq}: check the dispatcher's read side once more.` } }
    : { id: `msg_${seq}`, threadId: "zoom-thread", seq, role: "assistant", source: "self", sourceThreadId: null, wakeId: null, createdAt: at, content: { type: "assistant", text: `Answer ${seq}: the read deadline is set before close, and the test covers it.`, toolCalls: [] } };
}

test("scrolling to the top of a worker's chat loads older messages and keeps the reader's place", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    const olderReads: string[] = [];
    await page.route("**/api/agents/workers/*/thread*", async (route) => {
      const url = new URL(route.request().url());
      const answer = await (await route.fetch()).json() as Record<string, unknown>;
      const before = Number(url.searchParams.get("before") ?? "0");
      if (before) olderReads.push(url.search);
      const seqs = before ? Array.from({ length: before - 1 }, (_, i) => i + 1) : Array.from({ length: 50 }, (_, i) => i + 51);
      await route.fulfill({ json: { ...answer, thread: { id: "zoom-thread" }, messages: seqs.map(message), hasMore: !before } });
    });
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Answer 100:", { exact: false }).waitFor();
    expect(await page.getByRole("button", { name: /older/i }).count()).toBe(0);
    // The reader scrolls up to the oldest message loaded; it is noted.
    const scroller = page.locator('[data-slot="transcript-column"]').locator("xpath=..");
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    const anchorTop = await page.getByText("Question 51:", { exact: false }).evaluate((el) => el.getBoundingClientRect().top);
    await page.getByText("Question 1:", { exact: false }).waitFor({ state: "attached" });
    const after = await page.getByText("Question 51:", { exact: false }).evaluate((el) => el.getBoundingClientRect().top);
    expect(Math.abs(after - anchorTop)).toBeLessThan(2);
    expect(olderReads).toHaveLength(1);
    await page.screenshot({ path: path.join(artifactDir("chat-scroll-older"), "desktop.png") });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

/** A worker's conversation served by the test: the first read and each older
 *  read answered from `pages`, older reads held until released. */
async function serveConversation(page: import("playwright").Page, first: { messages: unknown[]; hasMore: boolean }, older: (before: number) => { messages: unknown[]; hasMore: boolean }) {
  const held: Array<() => void> = [];
  await page.route("**/api/agents/workers/*/thread*", async (route) => {
    const url = new URL(route.request().url());
    const answer = await (await route.fetch()).json() as Record<string, unknown>;
    const before = Number(url.searchParams.get("before") ?? "0");
    if (before) await new Promise<void>((release) => held.push(release));
    const body = before ? older(before) : first;
    await route.fulfill({ json: { ...answer, thread: { id: "zoom-thread" }, ...body } });
  });
  return { held };
}
const seqs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => message(from + i));
const top = (page: import("playwright").Page, text: string) => page.getByText(text, { exact: false }).evaluate((el) => el.getBoundingClientRect().top);
const scrollerOf = (page: import("playwright").Page) => page.locator('[data-slot="transcript-column"]').locator("xpath=..");

// More pages to come, the reader scrolling while one loads: the row they are
// on stays put through the page landing and the loading line going.
test("a page landing with more to come keeps the reader's row, though they scrolled while it loaded", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    const { held } = await serveConversation(page, { messages: seqs(51, 100), hasMore: true }, (before) => (
      before === 51 ? { messages: seqs(26, 50), hasMore: true } : { messages: seqs(1, 25), hasMore: false }
    ));
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Answer 100:", { exact: false }).waitFor();
    await scrollerOf(page).evaluate((el) => { el.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('[data-slot="loading-line"]') !== null);
    await scrollerOf(page).evaluate((el) => { el.scrollTop = 40; });
    const before = await top(page, "Question 53:");
    held.shift()!();
    await page.getByText("Question 27:", { exact: false }).waitFor({ state: "attached" });
    await page.waitForFunction(() => document.querySelector('[data-slot="loading-line"]') === null);
    expect(Math.abs((await top(page, "Question 53:")) - before)).toBeLessThan(2);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);

// A short conversation that just overflows loads older at once; a reader
// who scrolls 70px up from the end meanwhile has left it (following goes by
// what the reader did, not by distance), and stays on their row when the
// page lands.
test("a reader who scrolled up from the end stays on their row when an older page lands, not pinned to the end", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    // Twelve one-line messages: over one screen and under two, each row now
    // being a line taller for its action line (it was eighteen).
    const { held } = await serveConversation(page, { messages: seqs(89, 100), hasMore: true }, () => ({ messages: seqs(33, 88), hasMore: false }));
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Answer 100:", { exact: false }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-slot="loading-line"]') !== null);
    await scrollerOf(page).evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 70; });
    const before = await top(page, "Answer 96:");
    held.shift()!();
    await page.getByText("Question 33:", { exact: false }).waitFor({ state: "attached" });
    await page.waitForFunction(() => document.querySelector('[data-slot="loading-line"]') === null);
    expect(Math.abs((await top(page, "Answer 96:")) - before)).toBeLessThan(2);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);

// The first paint shows a window of the newest rows; a long reply before a
// folded tool run fills the pane once the window opens. It is shown then, not
// held until an older page lands.
test("a first page that fills the pane once its window opens is shown without waiting for an older page", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    const at = (seq: number) => new Date(Date.UTC(2026, 9, 9, 9, 0, seq)).toISOString();
    const long = Array.from({ length: 60 }, (_, i) => `Finding ${i + 1}: the dispatcher reads after close.`).join("\n\n");
    const tools = Array.from({ length: 24 }, (_, i) => {
      const callId = `call_w${i}`;
      return [
        { id: `msg_w${i}a`, threadId: "zoom-thread", seq: 3 + i * 2, role: "assistant", source: "self", sourceThreadId: null, wakeId: "wake_w", createdAt: at(3 + i * 2), content: { type: "assistant", text: "", toolCalls: [{ toolCallId: callId, toolName: "bash", args: { command: `go test ./w${i}` } }] } },
        { id: `msg_w${i}b`, threadId: "zoom-thread", seq: 4 + i * 2, role: "tool", source: "self", sourceThreadId: null, wakeId: "wake_w", createdAt: at(4 + i * 2), content: { type: "tool_result", toolCallId: callId, toolName: "bash", result: "ok" } }
      ];
    }).flat();
    const first = [
      { id: "msg_q", threadId: "zoom-thread", seq: 1, role: "user", source: "user", sourceThreadId: null, wakeId: null, createdAt: at(1), content: { type: "text", text: "Review the parser." } },
      { id: "msg_long", threadId: "zoom-thread", seq: 2, role: "assistant", source: "self", sourceThreadId: null, wakeId: "wake_long", createdAt: at(2), content: { type: "assistant", text: long, toolCalls: [] } },
      ...tools
    ];
    const { held } = await serveConversation(page, { messages: first, hasMore: true }, () => ({ messages: seqs(1, 50), hasMore: false }));
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Finding 60:", { exact: false }).waitFor({ state: "attached" });
    await page.waitForFunction(() => {
      const column = document.querySelector('[data-slot="transcript-column"]');
      return column !== null && !column.hasAttribute("data-filling");
    }, null, { timeout: 3000 });
    // Shown while any older read is still held.
    expect(held.length).toBeLessThanOrEqual(1);
    held.forEach((release) => release());
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);

// Following goes by what the reader did: a turn of the wheel up
// leaves the end at once, and the view shrinking under them (a shorter
// window, as the phone keyboard does) does not pull them back. Under the
// 100px stick-to-bottom distance it replaced, a reader 60px up was still
// "following" and pinned again.
test("a reader who turns the wheel up stays put as the view shrinks, until they ask for the latest", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await serveConversation(page, { messages: seqs(51, 100), hasMore: false }, () => ({ messages: [], hasMore: false }));
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Answer 100:", { exact: false }).waitFor();
    const fromEnd = () => scrollerOf(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(await fromEnd()).toBeLessThanOrEqual(2);
    const latest = page.getByRole("button", { name: "Scroll to latest message" });
    expect(await latest.count()).toBe(0);
    const box = (await scrollerOf(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -60);
    await latest.waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-slot="transcript-column"]')!.parentElement!;
      return el.scrollHeight - el.scrollTop - el.clientHeight > 30;
    });
    const before = await fromEnd();
    // 200px shorter: the end moves 200px farther below the reader.
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await fromEnd()).toBeGreaterThan(before);
    expect(await latest.isVisible()).toBe(true);
    await latest.click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-slot="transcript-column"]')!.parentElement!;
      return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    });
    await latest.waitFor({ state: "detached" });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);
