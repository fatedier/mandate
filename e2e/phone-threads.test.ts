import { expect, test } from "bun:test";
import { emptyPlan, type FeaturePlanDto } from "../src/shared/api/plans";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { pageOverflow } from "./helpers/page-overflow.js";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";

const browser = browserForFile();

const at = "2026-09-27T10:00:00.000Z";
const question = "Accept the write-behind risk?";
const plan: FeaturePlanDto = {
  ...emptyPlan("zoom-worker"),
  openQuestions: [question],
  steps: [{ id: 1, title: "Measure write-behind", status: "in_progress", note: "", createdAt: at, startedAt: at, blockedAt: null, completedAt: null, updatedAt: at }],
  updatedAt: at
};

test("a phone goes from Home into a thread with the worker in its sheet", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setPlan(plan);
  // The worker asks through its plan, and nothing in its thread runs: the
  // server lists its question as the user's to answer.
  fixture.setThreadStatus({
    threads: [{ threadId: THREAD_ID, state: "needs_you" }],
    waiting: [{
      key: "worker:zoom-worker:input", kind: "worker", waiting: "input", threadId: THREAD_ID, threadTitle: "project-1 3.21 release",
      featureId: "zoom-worker", workerName: "zoom-worker", text: question,
      place: { projectName: "Zoom project", projectSlug: "zoom-project", featureSlug: "zoom-worker" }
    }]
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}/home`);
    const waiting = page.locator('section[aria-label="Waiting on you"] [data-waiting]');
    await waiting.first().waitFor();
    expect(await waiting.count()).toBe(1);
    expect(await waiting.first().textContent()).toContain(question);
    expect(await pageOverflow(page)).toEqual([]);
    await waiting.first().tap();

    // The thread, its chat full screen, and the worker in a full-height sheet
    // on its Chat tab (it waits for an answer).
    await page.waitForURL(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await page.getByPlaceholder("Message the manager…").waitFor();
    const sheet = page.locator('[data-slot="worker-sheet"]');
    await sheet.locator('[data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
    expect(await sheet.getAttribute("data-expanded")).toBe("true");
    expect(await sheet.locator('[role="tab"][aria-selected="true"]', { hasText: "Chat" }).count()).toBe(1);

    // Back: close the sheet, and the menu lists the thread.
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page.locator('[role="group"][aria-label="Threads"] [data-thread-title="project-1 3.21 release"]').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20000);

test("on a narrow phone the worker's tabs scroll and its menu stays in view", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
    const sheet = page.locator('[data-slot="worker-sheet"]');
    // A branch-backed worker: all five tabs.
    await sheet.getByRole("tab", { name: "Changes", exact: true }).waitFor();
    const menu = sheet.getByRole("button", { name: "Worker actions" });
    await menu.waitFor();
    const box = (await menu.boundingBox())!;
    expect(box.x >= 0 && box.x + box.width <= 320).toBe(true);
    expect(await pageOverflow(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20000);
