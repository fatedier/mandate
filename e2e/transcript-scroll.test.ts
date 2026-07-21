import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { seedManagerThread, startServer, type RunningServer } from "./helpers/server.js";

/**
 * The transcript must never show the middle of a long thread on its way to the
 * bottom.
 *
 * It renders only its last screenful on mount and releases the rest two frames
 * later, and everything released lands ABOVE what is on screen — so unless
 * something puts scrollTop back before that paint, the reader gets a couple of
 * frames of old messages. The browser's scroll anchoring used to absorb it;
 * 3ee4422 turned anchoring off deliberately, which is what made this reachable.
 *
 * Frames, not settled state, is the whole point: every settled check passes
 * against the bug. And the sampler is armed BEFORE the click for the same
 * reason — installing it afterwards costs an evaluate round-trip, which is
 * long enough for the frames in question to have already gone by. That mistake
 * makes this test report success while the bug reproduces by hand.
 */

const VIEWPORT = { width: 1280, height: 900 };
/** A few pixels of slack: sub-pixel layout can leave scrollHeight and
 *  scrollTop + clientHeight a hair apart while visually pinned. */
const PINNED_SLACK_PX = 8;

let server: RunningServer;
let browser: Browser;

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => seedManagerThread(dataDir, 60)
  });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server?.cleanup();
});

interface Sample { frame: number; fromBottom: number; scrollHeight: number }

test("opening a long thread never paints a frame away from the bottom", async () => {
  const page = await browser.newPage({ viewport: VIEWPORT });
  attachPageDiagnostics(page);
  try {
    await page.goto(server.baseUrl, { waitUntil: "networkidle" });
    // Start from the closed dock, so the click below is a real open.
    await page.evaluate(() => localStorage.setItem("mandate.chat.drawerOpen.v1", "false"));
    await page.reload({ waitUntil: "networkidle" });

    await page.evaluate(() => {
      const store: Sample[] = [];
      (window as unknown as { __samples: Sample[] }).__samples = store;
      const tick = () => {
        // The transcript is whichever scroller is tallest; picking it by class
        // would pin a spelling instead of the behaviour.
        const scroller = [...document.querySelectorAll("div")]
          .filter((node) => node.scrollHeight > node.clientHeight + 40)
          .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        if (scroller) {
          store.push({
            frame: store.length,
            fromBottom: Math.round(
              scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
            ),
            scrollHeight: scroller.scrollHeight
          });
        }
        if (store.length < 40) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.locator('[aria-label="Assistant dock"] button').first().click();
    await page.waitForTimeout(1500);

    const samples = await page.evaluate(
      () => (window as unknown as { __samples: Sample[] }).__samples
    );

    // Guard the guard: without the release actually happening there is nothing
    // to catch, and a transcript that never grew would pass trivially.
    expect(samples.length).toBeGreaterThan(5);
    const heights = new Set(samples.map((sample) => sample.scrollHeight));
    expect([...heights].length).toBeGreaterThan(1);

    const away = samples.filter((sample) => sample.fromBottom > PINNED_SLACK_PX);
    expect(
      away.map((sample) => `frame ${sample.frame}: ${sample.fromBottom}px from bottom`)
    ).toEqual([]);
  } finally {
    await page.close();
  }
});
