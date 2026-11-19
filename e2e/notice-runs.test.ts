import { expect, test } from "bun:test";
import type { BrowserContextOptions } from "playwright";
import type { AgentClientMessageDto } from "../src/shared/api-contracts";
import { formatThreadNoticeText, threadNoticeMetadata, type ThreadNotice } from "../src/shared/thread-notice";
import { startWorkspaceFixture, workerPath } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { NARROW, PHONE } from "./helpers/touch-targets";

// Notices from one thread that came one after another are one line: the
// latest, and how many; its count opens the others in place. On a phone the
// thread's name gives way first and the count stays in the chat's column,
// tall enough to tap. The user's direct chat with a thread, told once it went
// quiet, is a line of its own. Widths are the browser's, which happy-dom has
// none of.

const browser = browserForFile();
const TITLE = "Catalogue migration to the new shelf index: research and rollout";
const row = { threadId: "zoom-thread", sourceThreadId: null, wakeId: null } as const;
const at = (minute: number) => `2026-11-17T10:${String(minute).padStart(2, "0")}:00.000Z`;
const base: ThreadNotice = { handoffIds: [], kind: "thread", targetThreadId: "thr_catalogue", workerId: null, title: TITLE, stop: "stopped", reason: null, verdict: "result", after: true };
const noticeRow = (seq: number, notice: ThreadNotice): AgentClientMessageDto => ({
  ...row, id: `m-${seq}`, seq, createdAt: at(seq), role: "user", source: "thread-notice", sourceThreadId: notice.targetThreadId,
  content: { type: "text", text: formatThreadNoticeText(notice, "Reply."), metadata: threadNoticeMetadata(notice) }
} as AgentClientMessageDto);
const messages: AgentClientMessageDto[] = [
  { ...row, id: "m-1", seq: 1, createdAt: at(1), role: "user", source: "user", content: { type: "text", text: "Follow the catalogue migration." } },
  { ...row, wakeId: "wake_1", id: "m-2", seq: 2, createdAt: at(2), role: "assistant", source: "self", content: { type: "assistant", text: "Following it." } },
  noticeRow(3, base),
  noticeRow(4, { ...base, stop: "asked", verdict: undefined, after: undefined, noWait: true, question: { id: "q_1", text: "Which deployment first?", options: [] } }),
  noticeRow(5, { ...base, verdict: "decision" }),
  noticeRow(6, {
    handoffIds: [], kind: "thread", targetThreadId: "thr_notes", workerId: null, title: "Rollout notes", stop: "chat", reason: null,
    chat: { from: at(4), to: at(6), messages: 2 }, words: "Shorter, please.\n\nShip it."
  })
] as AgentClientMessageDto[];

async function onDevice(device: BrowserContextOptions, check: (page: import("playwright").Page) => Promise<void>, shown: AgentClientMessageDto[] = messages) {
  const fixture = startWorkspaceFixture();
  fixture.setMessages(shown);
  const context = await browser.newContext(device);
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}${workerPath("chat")}`);
    await page.locator('[data-slot="notice-run"]').waitFor();
    await check(page);
  } finally {
    await context.close();
    fixture.stop();
  }
}

const labels = (page: import("playwright").Page) => page.locator('[data-slot="provenance-label"]').allTextContents();

test("notices of one thread one after another are one line with their count; it opens them in place", async () => {
  await onDevice({ viewport: { width: 1280, height: 800 } }, async (page) => {
    expect(await labels(page)).toEqual([`${TITLE} · decision needed`, "Rollout notes · your direct chat"]);
    const toggle = page.locator('[data-slot="notice-run-toggle"]');
    expect(await toggle.textContent()).toBe("· 3 updates");
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    await toggle.click();
    await page.locator('[data-slot="notice-run-member"]').first().waitFor();
    expect(await page.locator('[data-slot="notice-run-member"] [data-slot="provenance-label"]').allTextContents()).toEqual([
      `${TITLE} · result to read`, `${TITLE} · asked a question`, `${TITLE} · decision needed`
    ]);
    // Close under the run's line, on one rule: no 16px between them.
    const gaps = await page.locator('[data-slot="notice-run-member"]').evaluateAll((members) => members.map((m, i) => {
      const above = i === 0 ? document.querySelector('[data-slot="notice-run"]')! : members[i - 1]!;
      return Math.round(m.getBoundingClientRect().top - above.getBoundingClientRect().bottom);
    }));
    expect(gaps.every((gap) => gap <= 1)).toBe(true);
    // The direct chat says how many messages, and when.
    const chat = page.locator('[data-slot="provenance-label"]', { hasText: "your direct chat" }).locator("..");
    expect(await chat.locator('[data-slot="provenance-detail"]').textContent()).toMatch(/^2 messages · \d\d:\d\d–\d\d:\d\d$/);
    await toggle.click();
    await page.locator('[data-slot="notice-run-member"]').first().waitFor({ state: "detached" });
  });
});

// What a run's line can show on a phone: the name, how it stopped, the count.
// The name gives way first, then how it stopped; the count never does.
async function phoneFit(page: import("playwright").Page) {
  return page.locator('[data-slot="notice-run"]').evaluate((run) => {
    const toggle = run.querySelector('[data-slot="notice-run-toggle"]')!.getBoundingClientRect();
    const column = run.closest('[data-slot="transcript-column"]')!.getBoundingClientRect();
    const label = run.querySelector('[data-slot="provenance-label"]')!;
    const cut = (el: Element) => [el, ...el.querySelectorAll("*")].some((part) => part.scrollWidth > part.clientWidth);
    const stop = label.lastElementChild!;
    return {
      inColumn: toggle.right <= column.right + 1,
      countWhole: run.querySelector('[data-slot="notice-run-toggle"]')!.scrollWidth <= Math.ceil(toggle.width),
      nameCut: cut(label.firstElementChild!),
      stopWhole: label.childElementCount === 2 && !cut(stop) && stop.getBoundingClientRect().right <= toggle.left + 1,
      tall: toggle.height >= 36
    };
  });
}

test("on a phone the thread's name gives way and the count stays whole in the chat's column, a full-height tap target", async () => {
  await onDevice(PHONE, async (page) => {
    expect(await phoneFit(page)).toEqual({ inColumn: true, countWhole: true, nameCut: true, stopWhole: true, tall: true });
  });
});

// A line with no reply to peek at gives way in its name too: cutting it at
// its end would cut how it stopped and leave the name whole.
test("on a phone the name gives way before how it stopped, with a reply to peek at or without", async () => {
  const titled = (title: string, handoff: boolean) => (seq: number) => noticeRow(seq, { ...base, title, verdict: "decision", handoffIds: handoff ? [`hof_${seq}`] : [] });
  for (const [title, handoff] of [["Library supplier migration overview", false], [TITLE, false], [TITLE, true]] as const) {
    const notice = titled(title, handoff);
    await onDevice(PHONE, async (page) => {
      expect({ title, handoff, peek: await page.locator('[data-slot="notice-run"] [data-slot="notice-name"]').count() > 0, ...await phoneFit(page) })
        .toEqual({ title, handoff, peek: handoff, inColumn: true, countWhole: true, nameCut: true, stopWhole: true, tall: true });
    }, [messages[0]!, messages[1]!, notice(3), notice(4)]);
  }
});

// On the narrowest phone a long way of stopping gives way after the name,
// before the count does.
test("on a 320px phone a long stop gives way too: the count stays whole in the column", async () => {
  const waits = (seq: number): AgentClientMessageDto => noticeRow(seq, {
    handoffIds: [`hof_${seq}`], kind: "thread", targetThreadId: "thr_catalogue", workerId: null, title: TITLE, stop: "cannot", reason: null, requests: ["Ship the migration."]
  });
  await onDevice(NARROW, async (page) => {
    const fit = await page.locator('[data-slot="notice-run"]').evaluate((run) => {
      const toggle = run.querySelector('[data-slot="notice-run-toggle"]')!.getBoundingClientRect();
      const column = run.closest('[data-slot="transcript-column"]')!.getBoundingClientRect();
      // How it stopped, as drawn: its box ends where its words do.
      const stop = run.querySelector('[data-slot="provenance-label"] > span:last-child')!.getBoundingClientRect();
      return {
        peek: run.querySelector('[data-slot="notice-name"]') !== null,
        inColumn: toggle.right <= column.right + 1,
        countWhole: run.querySelector('[data-slot="notice-run-toggle"]')!.scrollWidth <= Math.ceil(toggle.width),
        clearOfCount: stop.right <= toggle.left + 1
      };
    });
    expect(fit).toEqual({ peek: true, inColumn: true, countWhole: true, clearOfCount: true });
  }, [messages[0]!, messages[1]!, waits(3), waits(4)]);
});
