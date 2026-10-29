import { expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// A worker that ended its turn on its waits still waits on them: several
// are one line at the end of its chat that opens to a row each, laid out
// inside the screen, and the line under its name says what it watches (one
// wait's line and its words: tests/client/waiting-line.test.tsx).
const browser = browserForFile();

/** The worker's thread as the server answers it, with these waits. */
async function withWaits(page: Page, monitors: unknown[]) {
  await page.route("**/api/agents/workers/*/thread*", async (route) => {
    const answer = await (await route.fetch()).json() as Record<string, unknown>;
    await route.fulfill({ json: { ...answer, monitors } });
  });
}

for (const [label, phone] of [["phone", true], ["desktop", false]] as const) {
  test(`a worker waiting on several things shows one line that opens to a row each, inside the screen (${label})`, async () => {
    const fixture = startWorkspaceFixture();
    const page = await browser.newPage(phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    try {
      const from = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
      await withWaits(page, [
        { kind: "command", id: "mon_e2e", command: "gh pr checks 48 --watch --interval 30 --json state,name,link", description: null, everyMs: 300_000,
          wakeWhen: "succeeds", timeoutAt: from(90), note: "report the CI result to the manager with the failing job names", createdAt: from(-20),
          runCount: 9, lastRunAt: from(-1), nextRunAt: from(4), recentRuns: [
            { at: from(-1), exitCode: 1, timedOut: false, changed: false, line: "build (linux-amd64)  pending  12m  https://ci.example.test/runs/101/job/2002" },
            { at: from(-6), exitCode: 1, timedOut: false, changed: false, line: "build (linux-amd64)  pending  7m" }
          ] },
        { kind: "pane", id: "ww_e2e", windowKey: "zoom-project:zoom-worker", paneId: "%103", stableMs: 45_000, timeoutAt: from(25),
          note: "PR48 build log; read the output and note each failure once it settles", createdAt: from(-5) },
        { kind: "alarm", id: "alm_e2e", fireAt: from(40), note: "check the image digest sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 and tell the manager", createdAt: from(-10) }
      ]);
      await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=chat`);
      const fold = page.locator('[data-slot="waiting-fold"]');
      await fold.waitFor();
      const shot = (name: string) => page.screenshot({ path: path.join(artifactDir("waiting-line"), `${label}-several-${name}.png`), animations: "disabled" });
      const folded = await page.evaluate(() => {
        const waiting = document.querySelector<HTMLElement>('[data-slot="waiting"]')!;
        const button = document.querySelector<HTMLElement>('[data-slot="waiting-fold"]')!;
        return {
          button: button.textContent,
          note: document.querySelector('[data-slot="waiting-fold-note"]')?.textContent ?? null,
          height: button.getBoundingClientRect().height,
          insideScreen: waiting.getBoundingClientRect().right <= window.innerWidth + 0.5,
          activity: document.querySelector('[data-slot="worker-activity"]')?.textContent ?? null
        };
      });
      expect(folded.button).toMatch(/^Watching %103 · 2 more · next wake \d\d:\d\d$/);
      expect(folded.note).toBe("PR48 build log; read the output and note each failure once it settles");
      expect(folded.insideScreen).toBe(true);
      expect(folded.activity).toBe("worker watching %103");
      if (phone) expect(folded.height).toBeGreaterThanOrEqual(44);
      await shot("folded");

      await fold.click();
      await page.locator('[data-slot="waiting-row"]').first().waitFor();
      const opened = await page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="waiting-row"]')];
        const part = (row: HTMLElement, name: string) => row.querySelector<HTMLElement>(`[data-part="${name}"]`);
        return {
          button: document.querySelector('[data-slot="waiting-fold"]')!.textContent,
          names: rows.map((row) => part(row, "name")?.textContent),
          insideScreen: rows.every((row) => [...row.querySelectorAll<HTMLElement>("[data-part]")].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 0.5)),
          // A narrow pane gives the note the line under the name, whole.
          noteBelow: rows.map((row) => {
            const name = part(row, "name")!.getBoundingClientRect();
            const note = part(row, "note")?.getBoundingClientRect();
            return note ? note.top >= name.bottom - 0.5 : null;
          }),
          // Opened, a narrow pane shows each note whole, a long unbroken token too.
          notesWhole: rows.flatMap((row) => {
            const note = part(row, "note");
            return note ? [note.scrollWidth <= note.clientWidth + 1] : [];
          }),
          // When it wakes stays on the name's line, however long the name.
          briefBeside: rows.flatMap((row) => {
            const brief = part(row, "brief")?.getBoundingClientRect();
            return brief ? [Math.abs(brief.top - part(row, "name")!.getBoundingClientRect().top) < 4] : [];
          }),
          last: document.querySelector('[data-slot="transcript-column"]')!.lastElementChild === document.querySelector('[data-slot="waiting"]')
        };
      });
      expect(opened.button).toBe("Waiting on 3");
      expect(opened.names).toEqual(["%103", "gh pr checks 48 --watch --interval 30 --json state,name,link", expect.stringMatching(/^\d\d:\d\d$/)]);
      expect(opened.insideScreen).toBe(true);
      expect(opened.noteBelow).toEqual(phone ? [true, true, true] : [false, false, false]);
      if (phone) expect(opened.notesWhole).toEqual([true, true, true]);
      expect(opened.briefBeside).toEqual([true, true]);
      expect(opened.last).toBe(true);
      await shot("opened");

      // The command's row opens its card: the runs, inside the screen.
      await page.locator('[data-slot="waiting-row"] [data-slot="cause-details-trigger"]').click();
      const card = page.locator('[data-slot="cause-details"]');
      await card.waitFor();
      const shown = await page.evaluate(() => {
        const box = document.querySelector<HTMLElement>('[data-slot="cause-details"]')!;
        const rect = box.getBoundingClientRect();
        const runs = [...box.querySelectorAll<HTMLElement>('[data-slot="cause-details-run"]')];
        return {
          meta: box.querySelector('[data-slot="cause-details-meta"]')?.textContent ?? null,
          runs: runs.length,
          earlier: box.querySelector('[data-slot="cause-details-runs-earlier"]')?.textContent ?? null,
          insideScreen: rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5,
          // A long last line is cut to its row, never widening the card.
          rowsInside: runs.every((row) => row.getBoundingClientRect().right <= rect.right + 0.5)
        };
      });
      expect(shown.meta).toMatch(/^Ran 9 times · last \d\d:\d\d · next \d\d:\d\d · every 5m · until /);
      expect([shown.runs, shown.earlier]).toEqual([2, "7 earlier runs"]);
      expect(shown.insideScreen).toBe(true);
      expect(shown.rowsInside).toBe(true);
      await shot("card");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      fixture.stop();
    }
  }, 20_000);
}
