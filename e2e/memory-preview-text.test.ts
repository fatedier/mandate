import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BrowserContextOptions, Page } from "playwright";
import type { MemoryDreamActionDto, MemoryDreamRunDto, MemoryEntryDto } from "../src/shared/api/memory";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";

// Memory's two-line previews (Activity, Overview's "Just learned") let a word
// too long for the line run past its edge: cut silently on the first line, and
// the sentence after a leading hash pushed out of sight. Long words are
// shortened in the middle there now, and wrap rather than run past the edge;
// the dream dialog's expandable texts wrap.
const browser = browserForFile();
let server: RunningServer;
beforeAll(async () => { server = await startServer({ configured: true }); }, 60_000);
afterAll(async () => { server?.cleanup(); });

const HASH = "3f9c1a2b7d4e5f60718293a4b5c6d7e8f9012345abcdef0123456789abcdef01";
const at = (m: number) => new Date(Date.UTC(2026, 9, 2, 10, m)).toISOString();
const entry = (id: string, content: string, m: number): MemoryEntryDto => ({
  id, scope: "project", projectId: null, featureId: null, type: "knowledge", source: "extraction", userQuote: null,
  status: "available", content, sourceThreadId: null, createdAt: at(m), updatedAt: at(m), metadata: null
});
const HASH_FIRST = entry("m1", `${HASH} is the v3.22.0 release commit; tag it after CI passes.`, 50);
const PATH = entry("m2", "PID. /Users/user/.mandate/run/workers/zoom-worker/sessions/md-project-1-1234567890/tmux-server-default.sock was stale and blocked the restart.", 40);
const PROSE = entry("m3", "Prefer pnpm over npm in the project-1 docs site; the lockfile is pnpm-lock.yaml and CI fails on a package-lock.json.", 30);
// Chinese is never shortened (it has no spaces, a sentence is one "word"); a
// hash glued to it is left whole, and only wrapping keeps it inside the edge
// (a hex run has no break opportunity; a path would break after its slashes).
const GLUED = entry("m4", `发布提交是${HASH}，打标签前先等CI通过。`, 20);
const ENTRIES = [HASH_FIRST, PATH, PROSE, GLUED];
const run: MemoryDreamRunDto = {
  id: "run1", trigger: "manual", status: "succeeded", provider: "stub", model: "stub", phase: "user",
  projectId: null, projectName: null, candidateCount: 3, appliedCount: 1, actionCount: 1,
  actionCounts: { update: 0, merge: 0, archive: 1, move: 0, split: 0 }, rejectedCount: 0, failedCount: 0,
  finishReason: null, error: null, metadata: null, startedAt: at(55), finishedAt: at(56),
  availableCountBefore: 3, availableCountAfter: 2
};
const action: MemoryDreamActionDto = {
  id: "a1", runId: "run1", actionType: "archive", status: "applied", memoryId: "m1", targetMemoryId: null,
  reason: `${HASH} duplicates a newer memory of the same release.`, source: null, error: null,
  before: null, after: null, createdAt: at(56), appliedAt: at(56)
};

async function open(options: BrowserContextOptions, url: string) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  await page.route("**/api/memory/entries**", (route) => route.fulfill({ json: { entries: ENTRIES, total: ENTRIES.length, limit: 50, offset: 0 } }));
  await page.route("**/api/memory/dream/runs?**", (route) => route.fulfill({ json: { runs: [run] } }));
  await page.route("**/api/memory/dream/runs/run1", (route) => route.fulfill({ json: { run, actions: [action] } }));
  await page.route("**/api/memory/stats", (route) => route.fulfill({ json: {
    totals: { available: 3, archived: 0, total: 3 }, byScope: { user: 0, project: 3 },
    byType: { preference: 0, knowledge: 3, task: 0 },
  bySource: { user: 0, agent: 3, extraction: 0 }, byProject: [], projectNames: {}
  } }));
  await page.goto(server.baseUrl + url);
  await page.locator('[data-slot="memory-preview"]').filter({ hasText: "pnpm over npm" }).first().waitFor();
  return { page, errors, close: () => context.close() };
}

/** Each preview: nothing runs past its edge, and the given words of a memory
 *  sit inside its box (on its two visible lines, not clipped below them). */
async function previews(page: Page, mustShow: Array<[string, string]>) {
  return page.evaluate((mustShow) => {
    const boxes = [...document.querySelectorAll<HTMLElement>('[data-slot="memory-preview"]')];
    const overflow = boxes.filter((p) => p.scrollWidth > p.clientWidth + 0.5).map((p) => p.textContent);
    const hidden = mustShow.filter(([starts, words]) => {
      const p = boxes.find((b) => (b.textContent ?? "").startsWith(starts));
      if (!p) return true;
      const text = p.firstChild!;
      const at = (text.textContent ?? "").indexOf(words);
      if (at < 0) return true;
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + words.length);
      const r = range.getBoundingClientRect();
      const b = p.getBoundingClientRect();
      return !(r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5 && r.left >= b.left - 0.5 && r.right <= b.right + 0.5);
    }).map(([starts]) => starts);
    return { count: boxes.length, texts: boxes.map((p) => p.textContent), overflow, hidden };
  }, mustShow);
}

const VIEWS: Array<[string, BrowserContextOptions]> = [
  ["phone", { viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true }],
  ["820", { viewport: { width: 820, height: 760 } }]
];

for (const [name, options] of VIEWS) {
  test(`${name}: Activity and Overview previews shorten long words, and the sentence after a hash shows`, async () => {
    for (const url of ["/memory?view=activity", "/memory"]) {
      const { page, errors, close } = await open(options, url);
      try {
        const shape = await previews(page, [["3f9c1a2b7d4e…", "release commit"], ["PID. ", "was stale"]]);
        expect({ url, some: shape.count > 0 }).toEqual({ url, some: true });
        expect(shape.texts).toContain("3f9c1a2b7d4e…6789abcdef01 is the v3.22.0 release commit; tag it after CI passes.");
        expect(shape.texts).toContain("PID. /Users/user/…default.sock was stale and blocked the restart.");
        expect(shape.texts).toContain(PROSE.content);
        expect(shape.texts).toContain(GLUED.content);
        expect({ url, overflow: shape.overflow }).toEqual({ url, overflow: [] });
        expect({ url, hidden: shape.hidden }).toEqual({ url, hidden: [] });
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 30_000);
}

test("phone: the dream dialog's texts wrap a long word instead of running past the edge", async () => {
  const { page, errors, close } = await open(VIEWS[0]![1], "/memory?view=activity");
  try {
    // The user's partition row in the dream card, by its tally.
    await page.getByRole("button", { name: /1 archived/ }).first().click();
    const reason = page.getByRole("dialog").locator('[data-slot="expandable-text"]').filter({ hasText: "duplicates a newer memory" });
    await reason.waitFor();
    const { width, scroll } = await reason.evaluate((p) => ({ width: p.clientWidth, scroll: p.scrollWidth }));
    expect(width).toBeGreaterThan(0);
    expect(scroll).toBeLessThanOrEqual(width + 0.5);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("phone: a memory's history wraps a long reason instead of running past the edge", async () => {
  const { page, errors, close } = await open({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }, "/memory");
  try {
    // Registered last, so it answers before the entries route that also matches.
    await page.route("**/api/memory/entries/*/history", (route) => route.fulfill({ json: {
      events: [
        { at: at(56), text: "Forgotten", detail: `${HASH} was reverted upstream.` },
        { at: at(30), text: "Remembered by an agent" }
      ],
      sourceThread: null
    } }));
    await page.locator('[data-slot="memory-preview"]').filter({ hasText: "pnpm over npm" }).first().click();
    const rows = page.getByRole("dialog").locator('[data-slot="memory-history"] li');
    await rows.filter({ hasText: "was reverted upstream" }).waitFor();
    const sizes = await rows.evaluateAll((lis) => lis.map((li) => ({ width: li.clientWidth, scroll: li.scrollWidth })));
    expect(sizes.length).toBe(2);
    for (const { width, scroll } of sizes) expect(scroll).toBeLessThanOrEqual(width + 0.5);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);
