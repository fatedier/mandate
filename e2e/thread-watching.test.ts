import { expect, test } from "bun:test";
import path from "node:path";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// A thread whose agents all sleep on a monitor reads watching:
// it read idle, like a thread that has stopped, while Codex worked in the
// pane its worker watches. Threads draws a grey clock (a turn running is a
// breathing green dot); the thread's Workers list names the worker: Watching.
const browser = browserForFile();

test("a thread whose worker waits on its pane reads watching: a grey clock in Threads, Watching in its Workers list", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    const timeoutAt = new Date(Date.now() + 25 * 60_000).toISOString();
    await page.route("**/api/agents/pending-monitors", (route) => route.fulfill({ json: {
      threads: [{ threadId: "zoom-thread", scope: "worker", scopeId: "zoom-worker", monitors: [{
        kind: "pane", id: "ww_e2e", windowKey: "zoom-project:zoom-worker", paneId: "%103", paneName: "Codex build",
        stableMs: 30_000, timeoutAt, note: "review the diff once it settles", createdAt: new Date().toISOString()
      }] }],
      revision: { boot: 1, seq: 1 }
    } }));
    // The server reads the thread watching: its worker sleeps on the pane.
    fixture.setThreadStatus({ threads: [{ threadId: THREAD_ID, state: "watching" }], waiting: [] });
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
    const dot = page.locator('[data-thread-title="project-1 3.21 release"] [role="img"][aria-label="state: watching"]');
    await dot.waitFor();
    const look = await dot.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const svg = el.querySelector("svg")!;
      return {
        mark: el.getAttribute("data-mark"),
        slot: [box.width, box.height],
        drawn: svg.getBoundingClientRect().width,
        // A face and its hands, stroked in the faint grey: no fill.
        shapes: [...svg.children].map((child) => child.tagName),
        stroke: getComputedStyle(svg.querySelector("circle")!).stroke,
        fill: getComputedStyle(svg.querySelector("circle")!).fill
      };
    });
    expect(look).toEqual({ mark: "clock", slot: [10, 10], drawn: 10, shapes: ["circle", "path"], stroke: "rgb(131, 131, 140)", fill: "none" });

    await page.locator('[data-slot="worker-panel"]').getByText(/^Workers/).first().click();
    const state = page.locator('[data-worker="zoom-worker"] [data-slot="worker-state"]');
    await state.waitFor();
    // As the strip above the composer says it: what it watches, and for how long.
    expect(await state.textContent()).toMatch(/^Watching .+ · \d+s$/);
    await page.screenshot({ path: path.join(artifactDir("thread-watching"), "desktop.png") });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

// A thread's working dot breathes, and keeps breathing with reduced motion:
// frozen, the green dot beside the red asking one would be told apart by
// colour alone, and a fade moves nothing. Every other loop stops
// (globals.css), the app's other running dots included. Read off the built
// stylesheet: the class the sidebar's dot carries, on an element of its own.
test("the working dot breathes, and keeps breathing with reduced motion while other running dots and spinners stop", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await page.locator("[data-thread-title]").first().waitFor();
    // What runs on an element carrying the class: each animation's length,
    // how often it repeats, and the opacity its keyframes pass through.
    const motion = () => page.evaluate(() => {
      const read = (className: string) => {
        const el = document.createElement("span");
        el.className = className;
        el.style.display = "inline-block";
        document.body.append(el);
        const result = el.getAnimations().map((animation) => {
          const effect = animation.effect as KeyframeEffect;
          const timing = effect.getComputedTiming();
          return {
            playing: String(animation.playState),
            duration: timing.duration,
            iterations: String(timing.iterations),
            opacity: effect.getKeyframes().map((frame) => frame.opacity ?? null)
          };
        });
        el.remove();
        return result;
      };
      return { working: read("animate-working"), live: read("animate-live"), spin: read("animate-spin") };
    });
    const breathing = [{ playing: "running", duration: 1600, iterations: "Infinity", opacity: ["1", "0.35", "1"] }];
    const normal = await motion();
    expect(normal.working).toEqual(breathing);
    // The same breath as every other running dot's.
    expect(normal.live).toEqual(breathing);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await motion();
    expect(reduced.working).toEqual(breathing);
    expect(reduced.live).toEqual([]);
    expect(reduced.spin).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

// Each row's breath began when its turn did, so two running threads breathed
// out of step. A running row's animation starts at the document timeline's
// origin, so every working dot is on one beat whenever its turn began; and
// again when the browser starts it afresh: its row moved in the list (as
// React moves a keyed row when the sort changes), or hidden and shown.
test("a running thread's dot breathes on the page's beat: its animation starts at the timeline's origin, again after its row moves or reappears", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.route("**/api/agents/active-wakes", (route) => route.fulfill({ json: {
      wakes: [{ threadId: "zoom-thread", wakeId: "wake-e2e", scope: "worker", scopeId: "zoom-worker", startedAt: new Date().toISOString() }]
    } }));
    fixture.setThreadStatus({ threads: [{ threadId: THREAD_ID, state: "working" }], waiting: [] });
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    const dot = page.locator('[data-thread-title="project-1 3.21 release"] [role="img"][aria-label="state: working"]');
    await dot.waitFor();
    // Read once its animation has started: a dot drawn just now starts in a
    // frame to come, later on a busy machine (its start time is null until then).
    const beat = await dot.evaluate(async (el) => {
      const svg = el.querySelector("svg")!;
      for (let frame = 0; frame < 120; frame++) {
        const animations = svg.getAnimations();
        if (animations.length > 0 && animations.every((animation) => animation.startTime !== null)) break;
        await new Promise((done) => requestAnimationFrame(done));
      }
      return {
        mark: el.getAttribute("data-mark"),
        // Long after the origin: a breath started at the row's own start would not read 0.
        now: Number(document.timeline.currentTime) > 0,
        animations: el.querySelector("svg")!.getAnimations().map((animation) => ({
          name: (animation as CSSAnimation).animationName,
          startTime: animation.startTime
        })),
        fill: getComputedStyle(el.querySelector("svg circle")!).fill
      };
    });
    expect(beat).toEqual({ mark: "pulse", now: true, animations: [{ name: "live-pulse", startTime: 0 }], fill: "rgb(26, 122, 72)" });
    // The row's start after it is moved or shown again, read once the new
    // animation has started, as above.
    const restart = (how: "move" | "hide") => dot.evaluate(async (el, how) => {
      const row = el.closest<HTMLElement>("[data-thread-title]")!;
      const svg = el.querySelector("svg")!;
      const before = svg.getAnimations()[0];
      if (how === "move") row.parentElement!.append(row);
      else {
        row.style.display = "none";
        void getComputedStyle(svg).opacity;
        row.style.display = "";
      }
      // Two frames at least: the old animation may still be the one listed in
      // the first; then until the new one has started.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      for (let frame = 0; frame < 120; frame++) {
        const animations = svg.getAnimations();
        if (animations.length > 0 && animations[0] !== before && animations.every((animation) => animation.startTime !== null)) break;
        await new Promise((done) => requestAnimationFrame(done));
      }
      const animations = svg.getAnimations();
      return { fresh: animations[0] !== before, startTimes: animations.map((animation) => animation.startTime) };
    }, how);
    expect(await restart("move")).toEqual({ fresh: true, startTimes: [0] });
    expect(await restart("hide")).toEqual({ fresh: true, startTimes: [0] });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);
