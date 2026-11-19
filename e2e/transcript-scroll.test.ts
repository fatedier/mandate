import { afterAll, beforeAll, expect, test } from "bun:test";
import { browserForFile } from "./helpers/browser.js";
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
 * anchoring is turned off deliberately, which is what made this reachable.
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
const browser = browserForFile();

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => seedManagerThread(dataDir, 60)
  });
});

afterAll(async () => {
  server?.cleanup();
});

interface Sample { frame: number; fromBottom: number; scrollHeight: number }

test("opening a long thread never paints a frame away from the bottom", async () => {
  const page = await browser.newPage({ viewport: VIEWPORT });
  attachPageDiagnostics(page);
  try {
    // Start from another page, so the click below is a real open of the
    // thread, in the same page (a client-side navigation).
    await page.goto(`${server.baseUrl}/projects`);
    await page.locator('[data-thread-title="Long thread"]').waitFor();

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

    await page.locator('[data-thread-title="Long thread"]').click();
    // The sampler stops itself at 40 frames.
    await page.waitForFunction(() => (window as unknown as { __samples: unknown[] }).__samples.length >= 40);

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

// Text scrolling past the transcript's top or bottom edge fades over 16px
// rather than being cut mid-line. The 16px are the transcript's
// own padding, so at rest at either end the fade covers empty space: nothing
// the reader sees changes until text moves into it.
test("the transcript fades its top and bottom 16px, its own padding: at either end nothing it shows sits in the fade", async () => {
  const page = await browser.newPage({ viewport: VIEWPORT });
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/projects`);
    await page.locator('[data-thread-title="Long thread"]').click();
    const column = page.locator('[data-slot="transcript-column"]');
    await column.waitFor();
    // Pinned to the bottom once the transcript has rendered in full.
    await page.waitForFunction(() => {
      const scroller = document.querySelector('[data-slot="transcript-column"]')?.parentElement;
      return !!scroller && scroller.scrollHeight > scroller.clientHeight + 40
        && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 8;
    });
    const edges = () => page.evaluate(() => {
      const column = document.querySelector<HTMLElement>('[data-slot="transcript-column"]')!;
      const scroller = column.parentElement!;
      const box = scroller.getBoundingClientRect();
      const kids = [...column.children].map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
      const style = getComputedStyle(scroller);
      return {
        mask: style.maskImage || style.webkitMaskImage,
        padding: [style.paddingTop, style.paddingBottom],
        // How far the first thing shown starts below the top edge, and the
        // last ends above the bottom one.
        topGap: kids[0]!.top - box.top,
        bottomGap: box.bottom - kids[kids.length - 1]!.bottom
      };
    });
    const atBottom = await edges();
    // Top to bottom (the default, so no angle), transparent at both edges
    // and opaque 16px in: a mask without the fade, or turned sideways, reads
    // differently.
    expect(atBottom.mask).toBe("linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 16px, rgb(0, 0, 0) calc(100% - 16px), rgba(0, 0, 0, 0))");
    expect(atBottom.padding).toEqual(["16px", "16px"]);
    expect(atBottom.bottomGap).toBeGreaterThanOrEqual(15.5);

    // Older messages load as the top is neared, and land above
    // the reader: read to the conversation's start first (60 messages, one
    // older page), so the top measured is the start's, not a page's.
    await page.evaluate(() => { document.querySelector('[data-slot="transcript-column"]')!.parentElement!.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('[data-slot="older-slot"]') === null);
    await page.evaluate(() => { document.querySelector('[data-slot="transcript-column"]')!.parentElement!.scrollTop = 0; });
    await page.waitForFunction(() => document.querySelector('[data-slot="transcript-column"]')!.parentElement!.scrollTop === 0);
    const atTop = await edges();
    expect(atTop.topGap).toBeGreaterThanOrEqual(15.5);
  } finally {
    await page.close();
  }
});
