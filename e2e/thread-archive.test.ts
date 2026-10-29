import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// A thread that still had workers refused to archive: each worker had to be
// archived from its own dialog first. The thread's dialog now lists its
// workers, each with what archiving it would lose, and one press archives
// them with the thread. The menu, the dialog over the page, what is sent and
// where the page goes afterwards are a browser's to show.

const browser = browserForFile();
const THREAD_ROUTE = `**/api/agents/manager/threads/${THREAD_ID}`;
const worktree = (name: string, branch: string) => ({ name, mode: "new-branch-new-worktree" as const, branch, baseRef: "main", worktreePath: `/tmp/zoom-fixture/.worktrees/${branch}` });
const CLEAN = { dirtyFiles: 0, unmergedCommits: 0, branch: "release-notes", baseRef: "main", findings: [] };
const FOUND = { dirtyFiles: 3, unmergedCommits: 2, branch: "config-loader", baseRef: "main", findings: ["3 uncommitted files in the worktree.", "2 commits on \"config-loader\" are not in main."] };

/** The thread with two workers of its own, each in a worktree Mandate made;
 *  the second one's check finds something when `found`. */
function startThread(found: boolean) {
  const fixture = startWorkspaceFixture();
  fixture.setFeature("zoom-worker", worktree("3.21 release notes", "release-notes"));
  fixture.setFeature("other-worker", { ...worktree("Config loader migration", "config-loader"), ownerThreadId: THREAD_ID });
  const prepare = async (page: Page) => {
    await page.route("**/api/features/zoom-worker/archive-check", (route) => route.fulfill({ json: CLEAN }));
    await page.route("**/api/features/other-worker/archive-check", (route) => route.fulfill({ json: found ? FOUND : CLEAN }));
  };
  return { fixture, prepare };
}

/** Answers the thread's archive as the server does, and keeps what was sent. */
async function answerArchive(page: Page) {
  const sent: unknown[] = [];
  await page.route(THREAD_ROUTE, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: {
      thread: { id: THREAD_ID, title: "project-1 3.21 release", named: true, createdAt: "2026-09-13T00:00:00.000Z", lastActivityAt: "2026-09-13T00:00:00.000Z", lastVisibleSeq: 0, seenSeq: 0, running: false, failed: false, stopReason: null, questions: [], archivedAt: "2026-09-13T00:01:00.000Z" },
      workers: [{ id: "zoom-worker", name: "3.21 release notes" }, { id: "other-worker", name: "Config loader migration" }],
      cleanupFailures: []
    } });
  });
  return sent;
}

const rows = (page: Page) => page.locator('[data-slot="archive-worker"]').evaluateAll((items) => items.map((item) => ({
  name: item.querySelector('[data-slot="worker-name"]')!.textContent,
  project: item.querySelector('[data-slot="worker-project"]')!.textContent,
  findings: item.querySelector('[data-slot="worker-findings"]')?.textContent ?? null
})));

async function openDialog(page: Page, tap = false) {
  const menu = page.getByRole("button", { name: "Thread actions" });
  const item = page.getByRole("menuitem", { name: "Archive thread" });
  if (tap) { await menu.tap(); await item.tap(); } else { await menu.click(); await item.click(); }
  await page.locator('[data-slot="archive-worker"]').nth(1).waitFor();
  // Both checks answered: the button no longer waits.
  await page.getByRole("dialog").locator('button:not([disabled])', { hasText: /^Archive/ }).waitFor();
}

test("what a worker's check found stands on its row, and the one button archives anyway as confirmed", async () => {
  const { fixture, prepare } = startThread(true);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await prepare(page);
    const sent = await answerArchive(page);
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await openDialog(page);
    const dialog = page.getByRole("dialog");
    expect(await rows(page)).toEqual([
      { name: "3.21 release notes", project: "Zoom project", findings: null },
      { name: "Config loader migration", project: "Zoom project", findings: "3 uncommitted files in the worktree. 2 commits on \"config-loader\" are not in main." }
    ]);
    // Said as a warning, in the warning's colour, under the worker it is about.
    const warning = dialog.locator('[data-slot="worker-findings"]');
    expect(await warning.evaluate((el) => {
      const probe = document.createElement("span");
      probe.className = "text-destructive";
      el.parentElement!.append(probe);
      const same = getComputedStyle(el).color === getComputedStyle(probe).color && getComputedStyle(el).color !== getComputedStyle(el.parentElement!.querySelector('[data-slot="worker-name"]')!).color;
      probe.remove();
      const row = el.closest('[data-slot="archive-worker"]')!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { role: el.getAttribute("role"), warningColour: same, insideItsRow: box.top >= row.top && box.bottom <= row.bottom + 0.5 };
    })).toEqual({ role: "alert", warningColour: true, insideItsRow: true });
    expect(await dialog.getByRole("button", { name: "Archive", exact: true }).count()).toBe(0);
    await dialog.getByRole("button", { name: "Archive anyway", exact: true }).click();
    await page.waitForURL(`${fixture.baseUrl}/home`);
    expect(sent).toEqual([{ archived: true, confirmed: ["other-worker"], removeWorktrees: true, deleteBranches: true }]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60000);

test("on a phone the dialog and everything in it fit the screen, and Cancel keeps the thread", async () => {
  const { fixture, prepare } = startThread(true);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await prepare(page);
    const sent = await answerArchive(page);
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await openDialog(page, true);
    const fit = await page.getByRole("dialog").evaluate((dialog) => {
      const box = dialog.getBoundingClientRect();
      const inside = (el: Element) => { const r = el.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5; };
      return {
        onScreen: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight,
        nothingSpills: [...dialog.querySelectorAll('[data-slot="archive-worker"], label, button')].every(inside),
        // The long warning wraps inside its row; the name is not cut for it.
        noSidewaysScroll: dialog.scrollWidth <= dialog.clientWidth
      };
    });
    expect(fit).toEqual({ onScreen: true, nothingSpills: true, noSidewaysScroll: true });
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).tap();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    expect(sent).toEqual([]);
    expect(new URL(page.url()).pathname).toBe(`/threads/${THREAD_ID}`);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60000);
