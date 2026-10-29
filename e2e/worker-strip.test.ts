import { expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { motionEnded } from "./helpers/animations";
import { SSE_EVENTS } from "../src/shared/api-contracts";

// A worker goes on after its first reply, and its manager's thread showed
// nothing of it: the thread looked stuck. Above the composer, the thread's
// workers at work: one has a row, running a turn (the step it is on) or
// asleep on a watch it set (what it waits on), and for how long; several are
// one line that opens to a row each.
const browser = browserForFile();

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function strip(page: Page) {
  return page.locator('[data-slot="worker-strip-row"]').evaluateAll((rows) => rows.map((row) => ({
    kind: row.getAttribute("data-kind"),
    text: row.querySelector('[data-slot="worker-strip-text"]')?.textContent ?? "",
    clock: row.querySelector('[data-slot="worker-strip-clock"]')?.textContent ?? ""
  })));
}

test("a running worker has a row above the composer: the step it is on and how long its turn has run", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    fixture.setPlan({
      featureId: "zoom-worker", goal: "Port the cases", conclusion: null, openQuestions: [], goalHistory: [], updatedAt: minutesAgo(9),
      steps: [{ id: 1, title: "Run the full validation", status: "in_progress", note: null, createdAt: minutesAgo(9), startedAt: minutesAgo(9), blockedAt: null, completedAt: null, updatedAt: minutesAgo(9) }]
    });
    await page.route("**/api/agents/active-wakes", (route) => route.fulfill({ json: {
      wakes: [{ threadId: "zoom-thread", wakeId: "wake-e2e", scope: "worker", scopeId: "zoom-worker", startedAt: minutesAgo(2) }]
    } }));
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await page.locator('[data-slot="worker-strip-row"]').waitFor();
    const rows = await strip(page);
    expect(rows).toEqual([{ kind: "running", text: "zoom-worker · Run the full validation…", clock: expect.stringMatching(/^2m 0\ds$/) }]);
    // Above the composer, inside its column.
    const box = await page.locator('[data-slot="worker-strip"]').boundingBox();
    const composer = await page.locator('[data-slot="composer"]').boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(composer!.y + 1);
    expect(box!.x).toBeGreaterThanOrEqual(composer!.x - 1);
    await page.screenshot({ path: path.join(artifactDir("worker-strip"), "running.png") });
    // The row opens its worker, in the panel.
    await page.locator('[data-slot="worker-strip-row"]').click();
    await page.locator('[data-slot="worker-panel"] [data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("a worker asleep on its pane has a still row: Watching the pane, and how long it has waited", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.route("**/api/agents/pending-monitors", (route) => route.fulfill({ json: {
      threads: [{ threadId: "zoom-thread", scope: "worker", scopeId: "zoom-worker", monitors: [{
        kind: "pane", id: "ww_e2e", windowKey: "zoom-project:zoom-worker", paneId: "%103", paneName: "Codex build",
        stableMs: 30_000, timeoutAt: new Date(Date.now() + 25 * 60_000).toISOString(), note: "review the diff once it settles", createdAt: minutesAgo(8)
      }] }],
      revision: { boot: 1, seq: 1 }
    } }));
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await page.locator('[data-slot="worker-strip-row"]').waitFor();
    const rows = await strip(page);
    expect(rows).toEqual([{ kind: "waiting", text: "zoom-worker · Watching Codex build", clock: expect.stringMatching(/^8m 0\ds$/) }]);
    // Waiting is not working: nothing turns or shimmers in its row.
    const row = page.locator('[data-slot="worker-strip-row"]');
    expect(await row.locator('[data-slot="working-glyph"], .text-shimmer').count()).toBe(0);
    await page.screenshot({ path: path.join(artifactDir("worker-strip"), "waiting-phone.png") });
    // On a phone too a lone worker's line opens it, in the sheet.
    await row.tap();
    await page.locator('[data-slot="worker-sheet"] [data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

/** The thread owns zoom-worker, other-worker and `more`, each running a turn,
 *  the first the longest. */
async function owning(fixture: ReturnType<typeof startWorkspaceFixture>, page: Page, more: string[] = []) {
  fixture.setFeature("other-worker", { ownerThreadId: THREAD_ID });
  for (const id of more) fixture.addWorker(id);
  const ids = ["zoom-worker", "other-worker", ...more];
  await page.route("**/api/agents/active-wakes", (route) => route.fulfill({ json: {
    wakes: ids.map((id, i) => ({ threadId: `${id}-thread`, wakeId: `wake-${id}`, scope: "worker", scopeId: id, startedAt: minutesAgo(10 - i) }))
  } }));
}

test("on a phone several workers are one line, the first and how many more, which opens in place to a row each", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await owning(fixture, page);
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    const more = page.locator('[data-slot="worker-strip-more"]');
    await more.waitFor();
    // The longest at it leads, by its name and clock; the other is counted.
    expect((await strip(page)).map((row) => row.text)).toEqual(["zoom-worker"]);
    expect(await more.textContent()).toBe("· 1 more at work");
    // One line, as tall as a touch needs and no taller, inside the screen.
    const lead = (await page.locator('[data-slot="worker-strip-lead"]').boundingBox())!;
    expect(lead.height).toBe(44);
    const moreBox = (await more.boundingBox())!;
    expect([moreBox.height, moreBox.x + moreBox.width <= 390]).toEqual([44, true]);
    await more.tap();
    await page.locator('[data-slot="worker-strip-fold"]').waitFor();
    expect(await page.locator('[data-slot="worker-strip-fold"]').textContent()).toBe("2 at work");
    expect((await strip(page)).map((row) => row.text.split(" · ")[0])).toEqual(["zoom-worker", "other-worker"]);
    // A row opens its worker in the sheet.
    await page.locator('[data-slot="worker-strip-row"]').nth(1).tap();
    await page.locator('[data-slot="worker-sheet"] [data-worker-tab="other-worker"][aria-selected="true"]').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("on a desktop several workers are one line that opens to a row each, the longest at it first", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await owning(fixture, page, ["docs-sweep", "flaky-ci"]);
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    const more = page.locator('[data-slot="worker-strip-more"]');
    await more.waitFor();
    expect((await strip(page)).map((row) => row.text.split(" · ")[0])).toEqual(["zoom-worker"]);
    expect(await more.textContent()).toBe("· 3 more at work");
    // The count follows the first worker's clock, not the far end of the line.
    const leadRow = (await page.locator('[data-slot="worker-strip-row"]').boundingBox())!;
    expect((await more.boundingBox())!.x - (leadRow.x + leadRow.width)).toBeLessThanOrEqual(8);
    await more.click();
    const fold = page.locator('[data-slot="worker-strip-fold"]');
    await fold.waitFor();
    expect(await fold.textContent()).toBe("4 at work");
    expect((await strip(page)).map((row) => row.text.split(" · ")[0])).toEqual(["zoom-worker", "other-worker", "docs-sweep", "flaky-ci"]);
    // A row opens its worker; the fold closes back to one line.
    await page.locator('[data-slot="worker-strip-row"]').nth(1).click();
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.locator('[data-worker-tab="other-worker"][aria-selected="true"]').waitFor();
    await fold.click();
    await more.waitFor();
    expect((await strip(page)).length).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("on a short screen the opened list scrolls within its space: its header and every worker stay reachable", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await owning(fixture, page, ["docs-sweep", "flaky-ci", "bench-cache"]);
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await page.locator('[data-slot="worker-strip-more"]').tap();
    const fold = page.locator('[data-slot="worker-strip-fold"]');
    await fold.waitFor();
    /** Whether a tap at the middle of the element lands on it. */
    const tappable = (selector: string, nth = 0) => page.locator(selector).nth(nth).evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && el.contains(hit);
    });
    expect(await tappable('[data-slot="worker-strip-fold"]')).toBe(true);
    const rows = page.locator('[data-slot="worker-strip-row"]');
    expect(await rows.count()).toBe(5);
    await rows.nth(4).scrollIntoViewIfNeeded();
    expect(await tappable('[data-slot="worker-strip-row"]', 4)).toBe(true);
    expect(await tappable('[data-slot="worker-strip-fold"]')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("with a question open on a short screen, the folded line keeps its height, and an opened list room for a whole row", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await owning(fixture, page);
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await page.locator('[data-slot="worker-strip-more"]').waitFor();
    const at = new Date().toISOString();
    fixture.emit(SSE_EVENTS.managerThreads, { threads: [{
      id: THREAD_ID, title: "project-1 3.21 release", named: true, createdAt: at, lastActivityAt: at,
      lastVisibleSeq: 0, seenSeq: 0, running: false, failed: false, stopReason: null, archivedAt: null,
      questions: [{ id: "q_short", question: "Push the release branch now?", askedAt: at, options: [{ label: "Push it" }, { label: "Hold it" }, { label: "Push tomorrow" }] }]
    }] });
    await page.locator('[data-slot="question-dock"]').waitFor();
    // The dock rises in on the Shown around it: measured once that has stopped.
    await page.waitForFunction(() => {
      const dock = document.querySelector('[data-slot="question-dock"]');
      const rising = dock?.closest('[data-slot="shown"]') ?? dock;
      return rising !== null && rising !== undefined && rising.getAnimations().length === 0;
    });
    const strip = (await page.locator('[data-slot="worker-strip"]').boundingBox())!;
    const lead = (await page.locator('[data-slot="worker-strip-lead"]').boundingBox())!;
    const dock = (await page.locator('[data-slot="question-dock"]').boundingBox())!;
    expect(lead.height).toBe(44);
    expect(strip.height).toBeGreaterThanOrEqual(lead.height);
    expect(dock.y).toBeGreaterThanOrEqual(lead.y + lead.height - 1);
    // Opened beside the question: the list keeps room for a whole row, and
    // scrolls for the rest.
    await page.locator('[data-slot="worker-strip-more"]').tap();
    // Measured once it has slid in: mid-slide its box reads a fraction off.
    await page.locator('[data-slot="worker-strip-list"]').waitFor();
    await motionEnded(page, "worker-strip-list");
    const list = (await page.locator('[data-slot="worker-strip-list"]').boundingBox())!;
    const first = (await page.locator('[data-slot="worker-strip-row"]').first().boundingBox())!;
    expect(first.height).toBe(44);
    expect(list.height).toBeGreaterThanOrEqual(first.height);
    // And that row takes a tap: the question does not lie over it.
    const hit = await page.locator('[data-slot="worker-strip-row"]').first().evaluate((el) => {
      const box = el.getBoundingClientRect();
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return at !== null && el.contains(at);
    });
    expect(hit).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);
