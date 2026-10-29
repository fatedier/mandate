import { expect, test } from "bun:test";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { settle } from "./helpers/settle";

// A message's action line: a Copy and the row's time on a line of
// their own under the message, inside its row, the line's height kept whether
// or not it shows. With a mouse it stands 4px under its message and 8px over
// the row after it (36px in all; at 10 and 16 a hidden line left a 50px hole
// between turns). A touch screen keeps 10 and 16: every
// line shows there, and Copy's 44px touch area needs the room. The most recent reply's always shows; an older reply's and
// the user's show while their row is hovered. A touch screen cannot hover, so
// there every line shows. A long turn's time also says how long it worked:
// on hover with a mouse, always on a touch screen.
//
// The fixture's chat alternates the user's messages and replies, none in a
// turn: Message 35 is the user's and the last row, 34 the most recent reply,
// 32 an older one.

const browser = browserForFile();
const message = (n: number) => `Message ${n}. ${"Keep the chat reading position. ".repeat(9)}`;

async function open(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}${WORKER_PATH}?tab=chat`);
  await page.getByText("Message 35.", { exact: false }).first().waitFor();
  await settle(page);
}
const rowOf = (page: Page, n: number) => page.locator('[data-slot="transcript-row"]').filter({ hasText: `Message ${n}.` });

/** Where a row's action line is drawn against the row, its message and the scroller. */
async function placeOf(row: Locator) {
  return row.evaluate((el) => {
    const line = el.querySelector<HTMLElement>('[data-slot="row-actions"]')!;
    const icon = line.querySelector("button[aria-label] svg")!.getBoundingClientRect();
    const stamp = line.querySelector('[data-slot="row-stamp"]')!.getBoundingClientRect();
    const content = el.firstElementChild!;
    // The bubble itself, for a message of the user's; the reply's text, for a reply.
    const edge = (content.querySelector('[data-slot="user-bubble"]') ?? content).getBoundingClientRect();
    const scroller = el.closest('[data-slot="transcript-column"]')!.parentElement!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const lineBox = line.getBoundingClientRect();
    const next = el.nextElementSibling?.getBoundingClientRect() ?? null;
    return {
      opacity: getComputedStyle(line).opacity,
      lineHeight: lineBox.height,
      lineInRow: lineBox.top >= edge.bottom - 0.5 && lineBox.bottom <= box.bottom + 0.5,
      underMessage: lineBox.top - edge.bottom,
      // From the line to the row after it; null under the transcript's last row.
      overNext: next ? next.top - lineBox.bottom : null,
      iconLeft: icon.left, iconRight: icon.right, iconBottom: icon.bottom, lineBottom: lineBox.bottom,
      stampLeft: stamp.left, stampRight: stamp.right,
      contentLeft: edge.left, contentRight: edge.right,
      // Where the transcript's bottom fade begins.
      fadeTop: scroller.bottom - 16
    };
  });
}

test("with a mouse the latest reply's line always shows, the others' on hover; each copies its message", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.baseUrl });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  try {
    await open(page, fixture.baseUrl);
    await page.mouse.move(5, 5);
    const latest = rowOf(page, 34);
    const older = rowOf(page, 32);
    const mine = rowOf(page, 33);

    // At rest: only the most recent reply's shows, and every line holds its height.
    const rest = { latest: await placeOf(latest), older: await placeOf(older), mine: await placeOf(mine) };
    expect([rest.latest.opacity, rest.older.opacity, rest.mine.opacity]).toEqual(["1", "0", "0"]);
    for (const place of Object.values(rest)) {
      expect(place.lineHeight).toBe(24);
      expect(place.lineInRow).toBe(true);
      expect(Math.round(place.underMessage)).toBe(4);
      expect(Math.round(place.overNext!)).toBe(8);
    }
    // Under the reply's left edge: Copy, then the time.
    expect(Math.abs(rest.latest.iconLeft - rest.latest.contentLeft)).toBeLessThan(1.5);
    expect(rest.latest.stampLeft).toBeGreaterThan(rest.latest.iconRight);
    // Under the bubble's right edge: the time, then Copy.
    expect(Math.abs(rest.mine.iconRight - rest.mine.contentRight)).toBeLessThan(1.5);
    expect(rest.mine.stampRight).toBeLessThan(rest.mine.iconLeft);
    // The gap between rows holds no time for these rows any more.
    expect(await page.locator('[data-slot="row-time"]').count()).toBe(0);
    await page.screenshot({ path: path.join(artifactDir("message-copy"), "desktop-rest.png") });

    // An older reply: shown on hover, copied by a real click, and gone again once the pointer leaves.
    await older.hover({ position: { x: 40, y: 10 } });
    await settle(page);
    expect((await placeOf(older)).opacity).toBe("1");
    await older.locator('[data-slot="row-actions"] button[aria-label="Copy message"]').click();
    expect(await clipboard()).toBe(message(32));
    expect(await older.locator('[data-slot="row-actions"] button').first().getAttribute("aria-label")).toBe("Copied");
    await page.mouse.move(5, 5);
    await settle(page);
    expect((await placeOf(older)).opacity).toBe("0");

    // The user's own.
    await mine.locator('[data-slot="user-bubble"]').hover();
    await settle(page);
    expect((await placeOf(mine)).opacity).toBe("1");
    await mine.locator('[data-slot="row-actions"] button[aria-label="Copy message"]').click();
    expect(await clipboard()).toBe(message(33));
    await page.screenshot({ path: path.join(artifactDir("message-copy"), "desktop-user-hover.png") });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

// The transcript fades its last 16px, which at rest is empty (fade-y-edges,
// e2e/transcript-scroll.test.ts). In the gap under the last row a Copy was
// drawn half faded right over the composer; in the
// row it is clear of the fade.
test("the last message's line is drawn clear of the transcript's bottom fade", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await open(page, fixture.baseUrl);
    const last = page.locator('[data-slot="transcript-row"]').last();
    await last.locator('[data-slot="user-bubble"]').hover();
    await settle(page);
    const atEnd = await last.evaluate((row) => {
      const scroller = row.closest('[data-slot="transcript-column"]')!.parentElement!;
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    });
    const place = await placeOf(last);
    await page.screenshot({ path: path.join(artifactDir("message-copy"), "desktop-last-row-hover.png") });
    expect(atEnd).toBeLessThanOrEqual(1);
    expect(place.opacity).toBe("1");
    expect(place.iconBottom).toBeLessThanOrEqual(place.fadeTop + 0.5);
    // No row follows, so nothing is pulled closer: the whole line is over the fade.
    expect(place.overNext).toBeNull();
    expect(place.lineBottom).toBeLessThanOrEqual(place.fadeTop + 0.5);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("on a touch screen every line shows without a hover, and Copy copies", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.baseUrl });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await open(page, fixture.baseUrl);
    for (const n of [32, 33, 34]) {
      const place = await placeOf(rowOf(page, n));
      expect({ n, opacity: place.opacity, lineInRow: place.lineInRow }).toEqual({ n, opacity: "1", lineInRow: true });
      // The room Copy's touch area needs, as before the mouse's spacing tightened.
      expect({ n, under: Math.round(place.underMessage), over: Math.round(place.overNext!) }).toEqual({ n, under: 10, over: 16 });
    }
    await page.screenshot({ path: path.join(artifactDir("message-copy"), "phone.png") });
    const button = rowOf(page, 32).locator('[data-slot="row-actions"] button[aria-label="Copy message"]');
    await button.tap();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(message(32));
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

/** Adds a turn that worked 2m 05s: something said on the way with two commands, then the answer with one more.
 *  `followed`: a later reply comes after it, so the long turn's is an older one. */
async function withLongTurn(page: Page, followed = false) {
  await page.route("**/api/agents/workers/*/thread*", async (route) => {
    const answer = await (await route.fetch()).json() as { messages: Array<{ createdAt: string }> } & Record<string, unknown>;
    const at = answer.messages.at(-1)!.createdAt;
    const started = new Date(Date.parse(at) - 125_000).toISOString();
    const base = { threadId: "zoom-thread", sourceThreadId: null, createdAt: at, wakeId: "wake-long" };
    await route.fulfill({ json: { ...answer, messages: [...answer.messages,
      { ...base, id: "long-way", seq: 36, role: "assistant", source: "self", wakeStartedAt: started, content: { type: "assistant", text: "Signing it first.", toolCalls: [{ toolCallId: "lb1", toolName: "bash", args: { command: "make sign" } }, { toolCallId: "lb2", toolName: "bash", args: { command: "make verify" } }] } },
      { ...base, id: "long-r1", seq: 37, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "lb1", toolName: "bash", result: "exitCode: 0" } },
      { ...base, id: "long-r2", seq: 38, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "lb2", toolName: "bash", result: "exitCode: 0" } },
      { ...base, id: "long-answer", seq: 39, role: "assistant", source: "self", wakeStartedAt: started, content: { type: "assistant", text: "Built and signed.", toolCalls: [{ toolCallId: "lb3", toolName: "bash", args: { command: "make clean" } }] } },
      { ...base, id: "long-r3", seq: 40, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "lb3", toolName: "bash", result: "exitCode: 0" } },
      ...(followed ? [{ ...base, id: "later", seq: 41, role: "assistant", source: "self", wakeId: null, content: { type: "assistant", text: "Anything else?" } }] : [])
    ] } });
  });
}

const workedOpacity = (row: Locator) => row.locator('[data-slot="row-worked"]').evaluate((el) => getComputedStyle(el).opacity);

test("a long turn has one line, under its last reply: Copy takes all it said, and its time says how long it worked on hover", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.baseUrl });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await withLongTurn(page);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Built and signed.").waitFor();
    await settle(page);
    await page.mouse.move(5, 5);
    const way = page.locator('[data-slot="transcript-row"]').filter({ hasText: "Signing it first." });
    const answer = page.locator('[data-slot="transcript-row"]').filter({ hasText: "Built and signed." });
    // What it said on the way has no line; the answer's is the latest and shows.
    expect(await way.locator('[data-slot="row-actions"]').count()).toBe(0);
    expect(await answer.locator('[data-slot="row-actions"]').evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    expect(await page.locator('[data-slot="worked-for"]').count()).toBe(0);
    // The time shows; the duration after it only while the row is hovered
    // (or holds keyboard focus: the keyboard test below).
    expect(await answer.locator('[data-slot="row-actions"]').textContent()).toMatch(/^\d{2}:\d{2} · Worked for 2m 05s$/);
    expect(await workedOpacity(answer)).toBe("0");
    await answer.hover({ position: { x: 40, y: 8 } });
    await settle(page);
    expect(await workedOpacity(answer)).toBe("1");
    // On the line: after the time, level with it.
    const seen = await answer.evaluate((row) => {
      const time = row.querySelector('[data-slot="row-stamp"]')!.getBoundingClientRect();
      const worked = row.querySelector('[data-slot="row-worked"]')!.getBoundingClientRect();
      return { timeRight: time.right, workedLeft: worked.left, timeMiddle: (time.top + time.bottom) / 2, workedMiddle: (worked.top + worked.bottom) / 2 };
    });
    expect(seen.workedLeft).toBeGreaterThanOrEqual(seen.timeRight - 0.5);
    expect(Math.abs(seen.workedMiddle - seen.timeMiddle)).toBeLessThan(2);
    await page.screenshot({ path: path.join(artifactDir("message-copy"), "desktop-long-turn-hover.png") });
    await answer.locator('[data-slot="row-actions"] button[aria-label="Copy message"]').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Signing it first.\n\nBuilt and signed.");
    await page.mouse.move(5, 5);
    await settle(page);
    expect(await workedOpacity(answer)).toBe("0");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

// With the keyboard there is no hover: focus anywhere in an older reply's row
// (its tool run line here, not a control on the action line) shows the line,
// and with it the duration. Were the two shown by different rules, the
// duration could be "shown" inside a line that is not.
test("keyboard focus anywhere in an older reply's row shows its line and how long its turn worked", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await withLongTurn(page, true);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Anything else?").waitFor();
    await settle(page);
    await page.mouse.move(5, 5);
    const answer = page.locator('[data-slot="transcript-row"]').filter({ hasText: "Built and signed." });
    const shown = async () => ({
      line: await answer.locator('[data-slot="row-actions"]').evaluate((el) => getComputedStyle(el).opacity),
      worked: await workedOpacity(answer)
    });
    expect(await shown()).toEqual({ line: "0", worked: "0" });
    await answer.locator('[data-slot="tool-run-line"]').focus();
    await settle(page);
    expect(await answer.locator('[data-slot="tool-run-line"]').evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    expect(await shown()).toEqual({ line: "1", worked: "1" });
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await settle(page);
    expect(await shown()).toEqual({ line: "0", worked: "0" });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

// A touch screen cannot hover, and a tap to reveal the duration was one step
// too many: it shows with the line. Copy's 44px touch
// area must clear the tool run line that ends the reply (WCAG 2.5.5,
// e2e/helpers/touch-targets.ts).
test("on a touch screen a long turn's reply says how long it worked without a tap, and Copy's touch area clears the run line above", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await withLongTurn(page);
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
    await page.getByText("Built and signed.").waitFor();
    await settle(page);
    const answer = page.locator('[data-slot="transcript-row"]').filter({ hasText: "Built and signed." });
    expect(await workedOpacity(answer)).toBe("1");
    const seen = await answer.evaluate((row) => {
      const run = row.querySelector('[data-slot="tool-run-line"]')!.getBoundingClientRect();
      const line = row.querySelector('[data-slot="row-actions"]')!;
      const buttons = [...line.querySelectorAll("button")];
      const copy = buttons[0]!.getBoundingClientRect();
      const worked = line.querySelector('[data-slot="row-worked"]')!.getBoundingClientRect();
      // Copy's touch area: 44px tall, centred on it.
      return { controls: buttons.length, runBottom: run.bottom, areaTop: copy.top - (44 - copy.height) / 2, workedRight: worked.right, rowRight: row.getBoundingClientRect().right };
    });
    await page.screenshot({ path: path.join(artifactDir("message-copy"), "phone-long-turn.png") });
    expect(seen.controls).toBe(1);
    expect(seen.areaTop).toBeGreaterThanOrEqual(seen.runBottom - 0.5);
    // The whole of it fits the phone's width.
    expect(seen.workedRight).toBeLessThanOrEqual(seen.rowRight + 0.5);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);
