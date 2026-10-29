import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { renderAlarmMessage } from "../src/server/modules/agent/agent-alarm-manager.js";
import { renderCommandMonitorMessage } from "../src/server/modules/agent/command-monitor-manager.js";
import { renderWatchMessage, type StoredWatch } from "../src/server/modules/agent/window-watch-manager.js";
import { stub } from "../tests/helpers/typed.js";

// A cause line opens what is behind it, in a real browser: on a desktop a
// box at the line, on a phone the sheet; the message the model read (its
// ids, its words for the model) is on neither, nor in any title. Invented
// thread and content.
let server: RunningServer;
const browser = browserForFile();
let threadId = "";

function seed(dataDir: string): void {
  const store = new MandateStore(dataDir);
  try {
    const agents = new AgentStore(store.db);
    const thread = agents.createManagerThread("Release 3.21 notes", { titleByUser: true });
    threadId = thread.id;
    const say = (role: "user" | "assistant", source: string, text: string) =>
      agents.appendMessage({ threadId: thread.id, role, source: source as never, content: { type: "text", text } });
    say("user", "user", "Draft the release notes for 3.21 and get them reviewed.");
    say("assistant", "self", "I started a worker on the draft and set an alarm to check on it.");
    // The events as the server writes them.
    const fireAt = new Date(Date.now() - 4 * 60_000).toISOString();
    say("user", "alarm", renderAlarmMessage({
      id: "alm_preview01", thread_id: thread.id, fire_at: fireAt, status: "fired", created_at: new Date(Date.now() - 3_600_000).toISOString(), fired_at: null,
      note: "Check the notes worker: the draft should be in docs/release-3.21.md by now. If it is, start a fresh review; if not, ask what is blocking it."
    }, "UTC"));
    say("assistant", "self", "The draft is in. I started a review pane and a monitor on it.");
    say("user", "watch", renderWatchMessage(stub<StoredWatch>({
      id: "ww_preview01", windowKey: "md-notes:release-notes", paneId: "%42", paneName: "Review", stableMs: 30_000,
      note: "The review of the 3.21 notes. When it settles, read its verdict: if nothing blocking, send the notes to the user; otherwise fix and review again."
    }), "settled", { status: "captured", text: [
      "Reviewed docs/release-3.21.md against the merged changes.",
      "- The upgrade section misses the config key rename (sync.interval → sync.every).",
      "- Everything else matches the changelog.",
      "Verdict: one fix needed, nothing else blocking."
    ].join("\n") }));
    say("assistant", "self", "One fix: the config key rename. Fixed it and ran the link check on a monitor.");
    say("user", "monitor", renderCommandMonitorMessage({
      id: "mon_preview01", command: "bun scripts/check-links.ts docs/release-3.21.md", every_ms: 60_000, wake_when: "succeeds",
      note: "Once the links pass, send the notes to the user for a final read.", description: "Link check on the release notes"
    }, "succeeded", { output: "checked 37 links in docs/release-3.21.md\nall reachable (2 redirects followed)" }));
    say("assistant", "self", "Links pass. The notes are ready for your final read.");
  } finally {
    store.db.close();
  }
}

beforeAll(async () => {
  server = await startServer({ configured: true, seed });
});
afterAll(() => server?.cleanup());

async function open(viewport: { width: number; height: number }, phone = false): Promise<Page> {
  const page = await browser.newPage({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  page.setDefaultTimeout(8000);
  await page.goto(`${server.baseUrl}/threads/${threadId}`);
  await page.locator('[data-slot="cause-details-trigger"]').first().waitFor();
  return page;
}
const line = (page: Page, text: string) => page.locator('[data-slot="cause-details-trigger"]', { hasText: text }).first();
const card = (page: Page) => page.locator('[data-slot="cause-details"]');

test("a cause line opens its card at the line, with the note and the pane's last lines, and no line has a title", async () => {
  const page = await open({ width: 1280, height: 900 });
  try {
    expect(await page.locator('[data-slot="provenance-label"]').count()).toBe(3);
    // Neither a line nor anything around it carries a title.
    expect(await page.locator('[data-slot="provenance-label"]').evaluateAll((labels) => labels.filter((el) => el.closest("[title]") || el.querySelector("[title]")).length)).toBe(0);
    await line(page, "Review went quiet").click();
    await card(page).waitFor();
    const text = await card(page).innerText();
    expect(text).toContain("Unchanged for 30s");
    expect(text).toContain("When it settles, read its verdict");
    expect(text).toContain("Verdict: one fix needed, nothing else blocking.");
    for (const raw of ["ww_preview01", "%42", "windowKey", "paneTail", "Review paneTail and continue"]) expect(text).not.toContain(raw);
    await page.keyboard.press("Escape");
    await card(page).waitFor({ state: "detached" });
    await line(page, "Link check").click();
    const command = await card(page).innerText();
    expect(command).toContain("Every 1m · Wakes when it succeeds");
    expect(command).toContain("all reachable (2 redirects followed)");
  } finally {
    await page.close();
  }
}, 30000);

test("on a phone a tap opens the card in the sheet, and nothing scrolls sideways", async () => {
  const page = await open({ width: 390, height: 844 }, true);
  try {
    await line(page, "Alarm").tap();
    await card(page).waitFor();
    const text = await card(page).innerText();
    expect(text).toMatch(/Set for \d{2}:\d{2} · Rang \d{2}:\d{2}/);
    expect(text).toContain("start a fresh review");
    expect(await card(page).locator('[data-slot="bottom-sheet-body"]').count()).toBe(1);
    expect(await pageOverflow(page)).toEqual([]);
  } finally {
    await page.close();
  }
}, 30000);
