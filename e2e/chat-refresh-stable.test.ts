import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { startServer, type RunningServer } from "./helpers/server";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";

// A reloaded thread paints its transcript once, already formatted, and
// nothing in it moves after. The markdown pipeline used to load lazily: every
// reply painted as raw text first and reflowed ~300ms later (React reveals a
// suspended boundary on a 300ms throttle), even from a warm cache — the whole
// transcript jumped on every refresh (layout shift 0.149 desktop, 0.21 phone).
const browser = browserForFile();
let server: RunningServer;
let threadId = "";
// A thread whose loaded page (the last 50 messages, tool results included)
// is a question, a reply, and 24 tool-only steps: 26 render items, of which
// the render window's 24 fold into one run line. Painted like that, the
// question and the reply arrived a frame later ABOVE the run and pushed it
// down.
let toolTailId = "";

const reply = (i: number) => `## Findings ${i}

The **cache expiry** path leaks a goroutine when \`EvictHook\` is never read:

1. \`storage.go\` — the sweep loop
2. \`expiry.go\` — \`Evict()\` and \`sweep()\`

\`\`\`go
func (c *Cache) Evict() error {
\tc.sweepOnce.Do(func() { close(c.doneCh) })
\treturn nil
}
\`\`\`

| file | change |
| --- | --- |
| expiry.go | +8 −4 |

- Next: run the race detector`;

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      const store = new MandateStore(dataDir);
      const agent = new AgentStore(store.db);
      threadId = agent.createManagerThread("project-2 cache expiry").id;
      for (let i = 0; i < 10; i++) {
        agent.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: `Question ${i}: why does the cache expiry leak?` } });
        agent.appendMessage({ threadId, role: "assistant", source: "self", wakeId: `wake-${i}`, content: { type: "assistant", text: reply(i) } });
      }
      toolTailId = agent.createManagerThread("release checks").id;
      for (let i = 0; i < 30; i++) {
        agent.appendMessage({ threadId: toolTailId, role: "user", source: "user", content: { type: "text", text: `Step ${i}?` } });
        agent.appendMessage({ threadId: toolTailId, role: "assistant", source: "self", wakeId: `w-${i}`, content: { type: "assistant", text: `Done with step ${i}.` } });
      }
      agent.appendMessage({ threadId: toolTailId, role: "user", source: "user", content: { type: "text", text: "Run the release checks" } });
      agent.appendMessage({ threadId: toolTailId, role: "assistant", source: "self", wakeId: "w-checks", content: { type: "assistant", text: "Running the checks, one shard at a time." } });
      for (let i = 0; i < 24; i++) {
        const toolCallId = `call-${i}`;
        agent.appendMessage({
          threadId: toolTailId, role: "assistant", source: "self", wakeId: "w-checks",
          content: { type: "assistant", text: "", toolCalls: [{ toolCallId, toolName: "bash", args: { command: `bun test shard-${i}` } }] }
        });
        agent.appendMessage({ threadId: toolTailId, role: "tool", source: "self", wakeId: "w-checks", content: { type: "tool_result", toolCallId, toolName: "bash", result: "ok" } });
      }
      store.db.close();
    }
  });
}, 60_000);

afterAll(async () => {
  server?.cleanup();
});

/** Every animation frame from the transcript's first paint: its height, the
 *  last rows' places, and how many headings are formatted; plus each layout
 *  shift inside it, and whether the rows were held out of sight first. A rAF
 *  sampler, not a timer: a timer misses a one-frame flash. It watches for 2s from the transcript's first paint, however long
 *  the page took to get there — and, when a test sets `window.__settled`,
 *  until that says the page is done changing plus 500ms — then sets `__done`. */
const SAMPLER = () => {
  const w = window as unknown as { __frames: unknown[]; __shifts: unknown[]; __held: boolean; __done: boolean };
  w.__frames = [];
  w.__shifts = [];
  w.__held = false;
  w.__done = false;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as unknown as Array<{ startTime: number; value: number; sources?: Array<{ node: Node | null }> }>) {
      const inside = (e.sources ?? []).filter((s) => s.node instanceof Element && s.node.closest('[data-slot="transcript-column"]'));
      if (inside.length > 0) w.__shifts.push({ t: Math.round(e.startTime), value: e.value, nodes: inside.map((s) => (s.node as Element).textContent?.slice(0, 40)) });
    }
  }).observe({ type: "layout-shift", buffered: true });
  // Held for as little as a commit when the older page comes back at once,
  // between two frames: a mutation tells it, where a frame can miss it.
  new MutationObserver(() => {
    if (document.querySelector('[data-slot="transcript-column"][data-filling]')) w.__held = true;
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-filling"] });
  let last = "";
  let firstPaint: number | null = null;
  let settledAt: number | null = null;
  const tick = () => {
    const column = document.querySelector('[data-slot="transcript-column"]');
    // Rows held out of sight while older pages fill the pane are not seen.
    if (column && column.children.length > 1 && !column.hasAttribute("data-filling")) {
      firstPaint ??= performance.now();
      const scroller = column.parentElement!;
      const state = JSON.stringify({
        height: scroller.scrollHeight,
        top: scroller.scrollTop,
        count: column.children.length,
        rows: [...column.children].slice(-3).map((row) => Math.round(row.getBoundingClientRect().top)),
        headings: column.querySelectorAll("h3, h4, h5").length
      });
      if (state !== last) {
        w.__frames.push({ t: Math.round(performance.now()), ...JSON.parse(state) });
        last = state;
      }
    }
    const now = performance.now();
    const settled = (window as unknown as { __settled?: () => boolean }).__settled;
    if (settled && settledAt === null && settled()) settledAt = now;
    const watched = firstPaint !== null && now - firstPaint >= 2000 && (!settled || (settledAt !== null && now - settledAt >= 500));
    if (!watched) requestAnimationFrame(tick);
    else w.__done = true;
  };
  requestAnimationFrame(tick);
};

type Frame = { height: number; top: number; count: number; rows: number[]; headings: number };

/** Opens a thread, reloads it (the chunks are in the browser's cache now, as
 *  for the user) and returns what the sampler saw from the transcript's first
 *  paint. */
async function reloadAndWatch(
  viewport: { width: number; height: number },
  id: string,
  loaded: string,
  prepare?: (page: Page) => Promise<void>,
  after?: (page: Page) => Promise<void>
) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  await page.addInitScript(SAMPLER);
  await prepare?.(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${id}`);
    await page.locator(loaded).first().waitFor();
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __done: boolean }).__done, null, { timeout: 15_000 });
    const seen = await page.evaluate(() => {
      const w = window as unknown as { __frames: Frame[]; __shifts: unknown[]; __held: boolean };
      return { frames: w.__frames, shifts: w.__shifts, held: w.__held };
    });
    await after?.(page);
    return { ...seen, errors };
  } finally {
    await page.close();
  }
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`a reloaded thread paints its transcript formatted, and nothing in it moves after (${label})`, async () => {
    const { frames, shifts, errors } = await reloadAndWatch(viewport, threadId, '[data-slot="transcript-column"] h4');
    // There was a transcript to watch, and its first frame was the formatted one.
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.headings).toBe(10);
    // Painted once: no later frame changed its height, scroll or rows.
    expect(frames).toHaveLength(1);
    expect(shifts).toEqual([]);
    expect(errors).toEqual([]);
  }, 30_000);

  test(`a page ending in a long tool run paints every row at once, and nothing moves after (${label})`, async () => {
    const { frames, shifts, held, errors } = await reloadAndWatch(viewport, toolTailId, '[data-slot="transcript-column"] [data-slot="tool-run"]');
    // Shorter than the pane, the page was held out of sight until an older
    // page filled it: shown at once, its rows sat near the top and jumped
    // down when that page landed.
    expect(held).toBe(true);
    expect(frames.length).toBeGreaterThan(0);
    // The question, the reply and the run: all in the first paint.
    expect(frames[0]!.count).toBeGreaterThanOrEqual(3);
    // The reader is within a screen of the top, so an older page loads by
    // itself and lands above: the rows on screen do not move for
    // it, but for a pixel of rounding.
    for (const frame of frames) {
      frame.rows.forEach((top, i) => expect(Math.abs(top - frames[0]!.rows[i]!)).toBeLessThanOrEqual(1));
    }
    expect(shifts).toEqual([]);
    expect(errors).toEqual([]);
  }, 30_000);
}
