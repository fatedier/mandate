import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import { startServer, type RunningServer } from "./helpers/server";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { seedProject } from "../tests/helpers/fixtures.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { seedFailedThread, seedJudgedThread, managerStopCheckOn } from "./helpers/status-seeds";

// Home on a desktop: the question and the composer centred in the page with
// what waits on you under them, the group centred as a whole. It used to pin
// the composer to the bottom with the waiting list at the top and ~500px of
// nothing between. A phone keeps the composer at the bottom, in thumb reach.
const browser = browserForFile();
const servers: RunningServer[] = [];

/** A server whose Home has `waiting` threads waiting on the user: one per
 *  count, shared by the tests that ask for the same one. */
const byWaiting = new Map<number, Promise<RunningServer>>();
function serverWith(waiting: number): Promise<RunningServer> {
  let server = byWaiting.get(waiting);
  if (!server) {
    server = startWith(waiting);
    byWaiting.set(waiting, server);
  }
  return server;
}

async function startWith(waiting: number): Promise<RunningServer> {
  const server = await startServer({
    configured: true,
    seed: (dataDir) => {
      managerStopCheckOn(dataDir);
      const store = new MandateStore(dataDir);
      seedProject(new ProjectsStore(store.db), { name: "project-1", tmuxSessionName: `md-project-1-home-${waiting}` });
      const agent = new AgentStore(store.db);
      for (let i = 0; i < waiting; i++) {
        // Every other one failed: red rows among results to read.
        if (i % 2 === 1) seedFailedThread(agent, `Thread ${i + 1}`, "provider returned 500");
        else seedJudgedThread(store.db, agent, `Thread ${i + 1}`, "result", `Thread ${i + 1} is done.`);
      }
      store.db.close();
    }
  });
  servers.push(server);
  return server;
}

afterAll(async () => {
  for (const server of servers) server.cleanup();
});

/** The group's edges against the page's content area. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
    const main = rect(document.querySelector("main"))!;
    const heading = rect([...document.querySelectorAll("h1")].find((h) => h.textContent === "What should we work on?") ?? null)!;
    const composer = rect(document.querySelector("textarea#new-thread-composer")!.parentElement)!;
    const waiting = rect(document.querySelector('section[aria-label="Waiting on you"]'));
    const groupBottom = waiting ? Math.max(waiting.bottom, composer.bottom) : composer.bottom;
    return {
      mainTop: main.top, mainBottom: main.bottom, viewport: window.innerHeight,
      headingTop: heading.top, composerTop: composer.top, composerBottom: composer.bottom,
      waitingTop: waiting?.top ?? null, waitingBottom: waiting?.bottom ?? null, groupBottom,
      pageScrolls: document.querySelector("main")!.scrollHeight > document.querySelector("main")!.clientHeight + 1
    };
  });
}

/** The rows Home shows for `waiting` seeded threads: every other one failed,
 *  a row each; the results a row when one, else one row for them all. */
function shownRows(waiting: number): number {
  const results = Math.ceil(waiting / 2);
  return Math.floor(waiting / 2) + (results >= 2 ? 1 : results);
}

async function openHome(server: RunningServer, viewport: { width: number; height: number }, waiting: number, shot: string) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.goto(`${server.baseUrl}/home`);
  await page.locator("textarea#new-thread-composer").waitFor();
  if (waiting > 0) {
    await page.locator('section[aria-label="Waiting on you"] :is([data-waiting], [data-slot="waiting-fold"])').nth(shownRows(waiting) - 1).waitFor();
  }
  const seen = await measure(page);
  await page.screenshot({ path: path.join(artifactDir("home-layout"), `${shot}.png`) });
  await page.close();
  return seen;
}

for (const waiting of [0, 1, 5]) {
  test(`desktop Home centres the question, the composer and what waits under them (${waiting} waiting)`, async () => {
    const server = await serverWith(waiting);
    const seen = await openHome(server, { width: 1440, height: 900 }, waiting, `desktop-${waiting}`);
    // The composer comes first, then what waits on you.
    expect(seen.headingTop).toBeLessThan(seen.composerTop);
    if (waiting > 0) expect(seen.waitingTop!).toBeGreaterThanOrEqual(seen.composerBottom);
    else expect(seen.waitingTop).toBe(null);
    // Centred as a group: as much room above it as below it (the page's own
    // padding differs by 8px top to bottom).
    const above = seen.headingTop - seen.mainTop;
    const below = seen.mainBottom - seen.groupBottom;
    expect(Math.abs(above - below)).toBeLessThanOrEqual(24);
    // And a group, not two ends of a stretched column: the list sits right
    // under the composer, and these fixtures leave real room above and below.
    if (waiting > 0) expect(seen.waitingTop! - seen.composerBottom).toBeLessThanOrEqual(48);
    expect(above).toBeGreaterThan(100);
    expect(seen.pageScrolls).toBe(false);
  }, 30_000);
}

test("a phone keeps Home's composer at the bottom, what waits above it", async () => {
  const server = await serverWith(1);
  const seen = await openHome(server, { width: 390, height: 844 }, 1, "phone-1");
  expect(seen.composerBottom).toBeGreaterThan(seen.viewport - 60);
  expect(seen.composerBottom).toBeLessThanOrEqual(seen.viewport);
  expect(seen.waitingBottom!).toBeLessThanOrEqual(seen.headingTop);
}, 30_000);

// Why a thread failed is often a whole sentence; one truncated line left
// the half that says what went wrong. The reason gets two lines,
// then clamps.
test("a waiting row's reason gets two lines before it clamps, and on a phone the row's full width", async () => {
  const reason = "The provider rejected the request because the configured key has no access to this model; " +
    "add a key with access in Settings, then retry the wake from the worker's chat so it picks up where it stopped.";
  const server = await startServer({
    configured: true,
    seed: (dataDir) => {
      const store = new MandateStore(dataDir);
      seedProject(new ProjectsStore(store.db), { name: "project-1", tmuxSessionName: "md-project-1-home-reason" });
      seedFailedThread(new AgentStore(store.db), "project-1 3.21 release", reason);
      store.db.close();
    }
  });
  servers.push(server);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    await page.goto(`${server.baseUrl}/home`);
    const row = page.locator('section[aria-label="Waiting on you"] [data-waiting="failed"]');
    await row.waitFor();
    const seen = await row.locator("[data-slot=waiting-reason]").evaluate((el) => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      return { lines: Math.round(el.clientHeight / lineHeight), text: el.textContent };
    });
    expect(seen.text).toContain(reason);
    expect(seen.lines).toBe(2);
  } finally {
    await page.close();
  }
  // On a phone the state word ("Failed", "Result to read") sat in a column
  // of its own beside the two lines, and the worker's name filled the first:
  // one line of reason was left. The word is on the title's line;
  // the reason line runs the row's width, and a reason longer than two lines
  // (the server keeps 200 characters, two lines on a desktop) clamps.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const onPhone = await phone.newPage();
  onPhone.setDefaultTimeout(8000);
  try {
    await onPhone.goto(`${server.baseUrl}/home`);
    const row = onPhone.locator('section[aria-label="Waiting on you"] [data-waiting="failed"]');
    await row.waitFor();
    const seen = await row.evaluate((el) => {
      // The row's content edge: what the reason runs to when nothing beside
      // it takes a column.
      const contentRight = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight);
      const title = el.querySelector("[data-slot=waiting-title]")!.getBoundingClientRect();
      const state = el.querySelector("[data-slot=waiting-state]")!.getBoundingClientRect();
      const reason = el.querySelector<HTMLElement>("[data-slot=waiting-reason]")!;
      return {
        stateOnTitleLine: state.top < title.bottom && state.bottom > title.top,
        reasonRight: reason.getBoundingClientRect().right,
        stateRight: state.right,
        contentRight,
        lines: Math.round(reason.clientHeight / parseFloat(getComputedStyle(reason).lineHeight)),
        clamped: reason.scrollHeight > reason.clientHeight + 1
      };
    });
    expect(seen.stateOnTitleLine).toBe(true);
    expect(Math.abs(seen.reasonRight - seen.contentRight)).toBeLessThan(2);
    expect(Math.abs(seen.stateRight - seen.contentRight)).toBeLessThan(2);
    expect(seen.lines).toBe(2);
    expect(seen.clamped).toBe(true);
  } finally {
    await phone.close();
  }
}, 30_000);

// Results to read hold nobody up and pile up: two or more are one row that
// opens to them in place, under what needs the user (here two failed threads).
for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`three results to read are one row that opens to them in place, inside the screen (${label})`, async () => {
    const server = await serverWith(5);
    const page = await browser.newPage(label === "phone" ? { viewport, isMobile: true, hasTouch: true } : { viewport });
    page.setDefaultTimeout(8000);
    try {
      await page.goto(`${server.baseUrl}/home`);
      const fold = page.locator('section[aria-label="Waiting on you"] [data-slot="waiting-fold"]');
      await fold.waitFor();
      const shot = (name: string) => page.screenshot({ path: path.join(artifactDir("home-layout"), `${label}-results-${name}.png`), animations: "disabled" });
      const rowsOf = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('section[aria-label="Waiting on you"] [data-waiting]')]
        .map((row) => [row.dataset.waiting, row.getBoundingClientRect().right <= window.innerWidth + 0.5]));
      expect(await rowsOf()).toEqual([["failed", true], ["failed", true]]);
      const folded = await fold.evaluate((el) => ({
        title: el.querySelector("[data-slot=waiting-title]")!.textContent,
        places: el.querySelector("[data-slot=waiting-reason]")!.textContent,
        height: el.getBoundingClientRect().height,
        inside: el.getBoundingClientRect().right <= window.innerWidth + 0.5
      }));
      expect(folded).toEqual({ title: "3 to look at", places: "Thread 5 · Thread 3 · Thread 1", height: expect.any(Number), inside: true });
      expect(folded.height).toBeGreaterThanOrEqual(44);
      await shot("folded");

      await fold.click();
      await page.locator('section[aria-label="Waiting on you"] [data-waiting="result"]').nth(2).waitFor();
      expect(await rowsOf()).toEqual([["failed", true], ["failed", true], ["result", true], ["result", true], ["result", true]]);
      expect(await fold.getAttribute("aria-expanded")).toBe("true");
      // One line now, with no room left where the places were; still a touch target on a phone.
      const openedHeight = await fold.evaluate((el) => el.getBoundingClientRect().height);
      expect(openedHeight).toBeLessThan(folded.height);
      if (label === "phone") expect(openedHeight).toBeGreaterThanOrEqual(44);
      await shot("opened");
    } finally {
      await page.close();
    }
  }, 30_000);
}
