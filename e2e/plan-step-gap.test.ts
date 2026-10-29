import { expect, test } from "bun:test";
import path from "node:path";
import { emptyPlan } from "../src/shared/api/plans";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";

// A plan step on a phone: its note sits as close under a one-line title as
// under a two-line one. The 44px touch height used to be the row's own
// minimum, so a one-line title had 12px of empty row under it;
// it now comes from even padding around the title, and a link at the top of
// the note stays the link.

const browser = browserForFile();

test("on a phone every shown note sits the same distance under its title, its links stay links, and a done step is one row", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    const at = new Date().toISOString();
    // Steps that show their note: the one being worked on, and blocked ones
    // (a done step's note waits until it is opened).
    const step = (id: number, title: string, note: string, status: "in_progress" | "blocked" | "done") => ({
      id, title, status, note,
      createdAt: at, startedAt: at, blockedAt: status === "blocked" ? at : null, completedAt: status === "done" ? at : null, updatedAt: at
    });
    fixture.setPlan({ ...emptyPlan("zoom-worker"), steps: [
      step(1, "Measure the evict", "https://github.com/acmecorp/project-1/issues/1 measured on main and on the branch", "in_progress"),
      step(2, "Measure the evict path on both sides of the project-2 storage and write down every number", "Both sides measured; the numbers are in the canvas", "blocked"),
      step(3, "Write it up", "https://github.com/acmecorp/project-1/pull/2 has the write-up", "blocked"),
      step(4, "Compare the evict path against the storage limits that the project-2 README documents for both sides", "Compared; nothing above the limits", "done")
    ] });
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=plan`);
    await page.locator('[data-slot="plan-step"]').nth(3).waitFor();
    // The done step: one row, its long title cut to a line, no note.
    const done = await page.locator('[data-slot="plan-step"][data-step-id="4"]').evaluate((row) => {
      const title = row.querySelector("button span.text-sm")!;
      return {
        lines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)),
        cut: title.scrollWidth > title.clientWidth,
        note: row.querySelector('[data-slot="plan-note"]') !== null
      };
    });
    expect(done).toEqual({ lines: 1, cut: true, note: false });
    const steps = await page.locator('[data-slot="plan-step"]:not([data-step-id="4"])').evaluateAll((rows) => rows.map((row) => {
      const title = row.querySelector("button span.text-sm")!;
      const note = row.querySelector("button + div")!;
      const link = note.querySelector("a");
      let linkOnTop: boolean | null = null;
      if (link) {
        // The top edge of the link, where a reach of the step's touch area
        // below its button would land.
        const box = link.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + 2, box.top + 1);
        linkOnTop = !!hit && link.contains(hit);
      }
      return {
        // A flex item: one box however many lines, so count by line height.
        lines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)),
        gap: Math.round(note.getBoundingClientRect().top - title.getBoundingClientRect().bottom),
        linkOnTop
      };
    }));
    await page.screenshot({ path: path.join(artifactDir("plan-step-gap"), "phone.png") });
    // One-line titles around one that wraps.
    expect(steps.map((s) => s.lines > 1)).toEqual([false, true, false]);
    expect(new Set(steps.map((s) => s.gap)).size).toBe(1);
    expect(steps.map((s) => s.linkOnTop)).toEqual([true, null, true]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);
