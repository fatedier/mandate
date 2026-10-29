import { expect, test } from "bun:test";
import type { BrowserContextOptions, Page } from "playwright";
import type { AgentClientMessageDto } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// In a worker's chat the manager's messages are drawn on the user's side:
// they carry a small "Manager" above the bubble, and a
// long one is folded to eight lines until opened. The clamp, where the label
// sits, and whether opening a message at the end of the chat keeps it in
// place are layout and scrolling, which happy-dom does not do.

const browser = browserForFile();
const at = (minute: number) => `2026-10-09T15:${String(minute).padStart(2, "0")}:00.000Z`;
const TASK = `Task: sort this week's export records and deliver one list ordered by date.\n${"Check each record's source, time and owner, and mark what needs a follow-up; the original records stay read-only. ".repeat(40)}`;
const SHORT = "Please check only the first section of this report.";
const MINE = `Hold on.\n${"I will decide the next step once I have read the list. ".repeat(40)}`;

const row = { threadId: "zoom-thread", sourceThreadId: null } as const;
const said = (seq: number, source: "manager" | "user", text: string): AgentClientMessageDto =>
  ({ ...row, id: `m-${seq}`, seq, role: "user", source, wakeId: null, createdAt: at(seq), content: { type: "text", text } });
const reply = (seq: number, wakeId: string, text: string): AgentClientMessageDto =>
  ({ ...row, id: `m-${seq}`, seq, role: "assistant", source: "self", wakeId, createdAt: at(seq), content: { type: "assistant", text } });

async function open(page: Page, baseUrl: string, lastText: string) {
  await page.goto(`${baseUrl}${WORKER_PATH}?tab=chat`);
  await page.getByText(lastText, { exact: false }).first().waitFor();
  await page.waitForTimeout(300);
}

/** Each bubble in the chat: who it says wrote it, where that label sits, and how much of its text shows. */
async function bubbles(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-slot="transcript-row"]')]
    .filter((el) => el.querySelector('[data-slot="user-bubble"]'))
    .map((el) => {
      const bubble = el.querySelector<HTMLElement>('[data-slot="user-bubble"]')!.getBoundingClientRect();
      const label = el.querySelector<HTMLElement>('[data-slot="sender-label"]');
      const text = el.querySelector<HTMLElement>('[data-slot="bubble-text"]')!;
      const fold = el.querySelector<HTMLElement>('[data-slot="bubble-fold"]');
      const labelBox = label?.getBoundingClientRect();
      return {
        sender: label?.textContent ?? null,
        labelAbove: labelBox ? labelBox.bottom <= bubble.top + 0.5 && bubble.top - labelBox.bottom < 8 : null,
        labelOnRightEdge: labelBox ? Math.abs(labelBox.right - bubble.right) <= 3 : null,
        lines: Math.round(text.clientHeight / Number.parseFloat(getComputedStyle(text).lineHeight)),
        cut: text.scrollHeight > text.clientHeight + 1,
        fold: fold?.textContent ?? null
      };
    }));
}

test("the manager's messages say Manager above the bubble; its long one shows eight lines, the user's own shows whole", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setMessages([
    said(1, "manager", TASK), reply(2, "w1", "Checked the list against the original records."),
    said(3, "manager", SHORT), reply(4, "w2", "Corrected."),
    said(5, "user", MINE), reply(6, "w3", "OK, I will leave it.")
  ]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await open(page, fixture.baseUrl, "OK, I will leave it.");
    const [task, short, mine] = await bubbles(page);
    expect(task).toEqual({ sender: "Manager", labelAbove: true, labelOnRightEdge: true, lines: 8, cut: true, fold: "Show more" });
    expect(short).toEqual({ sender: "Manager", labelAbove: true, labelOnRightEdge: true, lines: 1, cut: false, fold: null });
    // The user's own words, as long as the task: never folded, never labelled.
    expect(MINE.length).toBeGreaterThan(600);
    expect({ ...mine, lines: mine!.lines > 8 }).toEqual({ sender: null, labelAbove: null, labelOnRightEdge: null, lines: true, cut: false, fold: null });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60000);

const SCREENS: Array<[string, BrowserContextOptions]> = [
  ["a desktop", { viewport: { width: 1440, height: 900 } }],
  ["a phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]
];

for (const [name, options] of SCREENS) {
  // The chat opens at its end and follows it. A message opened there grows
  // by a screen or more: followed, the end would carry the message away from
  // under the reader's pointer.
  test(`on ${name}, Show more opens a long message where it is, and Show less folds it again`, async () => {
    const fixture = startWorkspaceFixture();
    fixture.setMessages([said(1, "manager", TASK), reply(2, "w1", "Checked the list against the original records.")]);
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    const place = () => page.evaluate(() => {
      const bubble = document.querySelector<HTMLElement>('[data-slot="user-bubble"]')!;
      const scroller = document.querySelector('[data-slot="transcript-column"]')!.parentElement!;
      return { top: Math.round(bubble.getBoundingClientRect().top), scrollTop: Math.round(scroller.scrollTop), overflows: scroller.scrollHeight > scroller.clientHeight + 1 };
    });
    const fold = page.locator('[data-slot="bubble-fold"]');
    const toLatest = page.getByRole("button", { name: "Scroll to latest message" });
    try {
      await open(page, fixture.baseUrl, "Checked the list against the original records.");
      const before = await place();
      expect((await bubbles(page))[0]).toMatchObject({ lines: 8, cut: true, fold: "Show more" });
      expect(await toLatest.count()).toBe(0);

      await fold.click();
      await page.waitForTimeout(300);
      const opened = await place();
      expect((await bubbles(page))[0]).toMatchObject({ cut: false, fold: "Show less" });
      // It grew past the screen, and stayed where it was.
      expect(opened.overflows).toBe(true);
      expect({ top: opened.top, scrollTop: opened.scrollTop }).toEqual({ top: before.top, scrollTop: before.scrollTop });
      // The end is out of sight now, and the way to it is offered.
      await toLatest.waitFor();

      await page.evaluate(() => document.querySelector<HTMLElement>('[data-slot="bubble-fold"]')!.scrollIntoView({ block: "center" }));
      await fold.click();
      await page.waitForTimeout(300);
      expect((await bubbles(page))[0]).toMatchObject({ lines: 8, cut: true, fold: "Show more" });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      fixture.stop();
    }
  }, 60000);
}
