import { expect, test } from "bun:test";
import type { Locator, Page } from "playwright";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { seedFeature, seedProject } from "../tests/helpers/fixtures.js";
import { startWorkspaceFixture } from "./helpers/workspace-fixture.js";
import type { DesignSnapshot } from "../src/shared/api-contracts.js";
import { browserForFile } from "./helpers/browser.js";

/**
 * The live stream drops (the server stops under a loaded page) and the header
 * says "Reconnecting…" straight after the page's title. What a page puts in
 * the title keeps its layout: a rename in progress keeps its width, and the
 * canvas's project / feature label is not cut short.
 */

const browser = browserForFile();

/** A thread, and a canvas under a feature. Crowded: the thread owns a worker
 *  and has spent its context (the phone's top bar then carries the usage pill
 *  and "Workers 1"); the canvas's project / feature label is long. */
async function serve({ crowded = false, title = "project-1 3.21 release notes" } = {}) {
  const ids = { threadId: "", canvasId: "" };
  const server = await startServer({
    configured: true,
    seed(dataDir) {
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        ids.threadId = agent.createManagerThread(title).id;
        const ask = agent.appendMessage({ threadId: ids.threadId, role: "user", source: "user", content: { type: "text", text: "Draft the release notes" } });
        const projectId = seedProject(new ProjectsStore(store.db), { name: crowded ? "Mandate development" : "project-1", tmuxSessionName: "md-project-1" });
        const features = new FeaturesStore(store.db);
        const featureId = seedFeature(features, projectId, { name: crowded ? "Connection transport cleanup with release notes" : "project-2 upgrade" });
        if (crowded) {
          seedFeature(features, projectId, { name: "project-2", ownerThreadId: ids.threadId, tmuxWindowName: "project-2" });
          const spent = agent.createWake({ threadId: ids.threadId, reason: "user", triggerMessageId: ask.id });
          agent.updateWakeTokenUsage(spent.id, 272000, 272000);
          agent.finishWake(spent.id, "finished");
        }
        const canvases = new CanvasStore(store.db, dataDir);
        const canvas = canvases.create({ title: crowded ? "Cache policy for the transport" : "Cache policy", scope: "worker", scopeId: featureId, threadId: agent.getOrCreateThread("worker", featureId).id, projectId });
        canvases.writeSource(canvas.id, "<h1>Shorten the keys</h1>");
        if (canvases.publishSource(canvas.id).error) throw new Error("canvas did not publish");
        ids.canvasId = canvas.id;
      } finally {
        store.db.close();
      }
    }
  });
  return { server, ids };
}

// These pages run on a fake clock, so a navigation waits for what the test
// reads (settle.ts's idle() steps animation frames, which do not run here).
const note = (page: Page) => page.locator('[data-slot="connection-indicator"]');
/** A page on a fake clock: the note shows 2s after the stream errors
 *  (RECONNECTING_AFTER_MS), and these tests move the clock past that rather
 *  than wait it out. */
async function openPage(options: Parameters<typeof browser.newPage>[0]) {
  const page = await browser.newPage(options);
  await page.clock.install();
  return page;
}
/** Steps the page's clock until the note shows: the error reaches the page
 *  in real time, then the 2s wait passes on the fake clock. */
async function untilReconnecting(page: Page) {
  for (let step = 0; step < 120 && !(await note(page).isVisible()); step++) await page.clock.runFor(500);
  await note(page).waitFor({ state: "visible", timeout: 1000 });
}
async function dropStream(page: Page, server: RunningServer) {
  await server.stop();
  await untilReconnecting(page);
}
/** Where the visible text ends: not the element's box, which may stretch,
 *  nor the text's full run, which an ellipsis may cut. */
const textRight = (el: Locator) => el.evaluate((node) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  return Math.min(range.getBoundingClientRect().right, node.getBoundingClientRect().right);
});
async function saidRightAfter(page: Page, title: Locator) {
  const gap = (await note(page).boundingBox())!.x - await textRight(title);
  expect(gap >= 0 && gap < 16).toBe(true);
}

test("a thread's title is followed by it, and a rename in progress keeps its width", async () => {
  const { server, ids } = await serve();
  const page = await openPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${server.baseUrl}/threads/${ids.threadId}`);
    const header = page.locator('[data-slot="pane-header"]');
    const title = header.locator('button[title="Rename"]');
    await header.locator('button[title="Rename"]', { hasText: "project-1 3.21 release notes" }).waitFor();
    await title.click();
    const input = header.locator("input");
    const renameWidth = (await input.boundingBox())!.width;
    expect(renameWidth).toBeGreaterThan(400);
    await input.press("Escape");

    await dropStream(page, server);
    await saidRightAfter(page, title);
    await title.click();
    expect((await input.boundingBox())!.width).toBeGreaterThanOrEqual(renameWidth - 160);
    await page.close();
  } finally {
    server.cleanup();
  }
}, 90_000);

test("a canvas keeps its project / feature label whole beside it", async () => {
  const { server, ids } = await serve();
  const page = await openPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${server.baseUrl}/canvas/${ids.canvasId}`);
    const label = page.locator('[data-slot="pane-header"]').getByText("project-1 / project-2 upgrade", { exact: true });
    await label.waitFor();
    expect(await label.isVisible()).toBe(true);
    const whole = (await label.boundingBox())!.width;

    await dropStream(page, server);
    expect(await label.isVisible()).toBe(true);
    expect((await label.boundingBox())!.width).toBeGreaterThanOrEqual(whole - 1);
    expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await saidRightAfter(page, label);
    await page.close();
  } finally {
    server.cleanup();
  }
}, 90_000);

test("on a phone it follows the top bar's title", async () => {
  const { server, ids } = await serve();
  const page = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${server.baseUrl}/threads/${ids.threadId}`);
    await page.locator("header").first().getByText("project-1 3.21 release notes").first().waitFor();
    await dropStream(page, server);
    const bar = page.locator("header").first();
    expect(await bar.locator('[data-slot="connection-indicator"]').isVisible()).toBe(true);
    await saidRightAfter(page, bar.getByText("project-1 3.21 release notes").first());
    await page.close();
  } finally {
    server.cleanup();
  }
}, 90_000);

test("a crowded 320px top bar keeps its title: the note shrinks to a spinner, the actions stay put", async () => {
  const { server, ids } = await serve({ crowded: true });
  const page = await openPage({ viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${server.baseUrl}/threads/${ids.threadId}`);
    const bar = page.locator("header").first();
    await bar.getByText("Workers").waitFor();
    const title = bar.getByText("project-1 3.21 release notes").first();
    await title.waitFor();
    const actions = await bar.locator('[data-slot="pane-actions"]').boundingBox();
    await dropStream(page, server);
    const shown = await title.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = node.getBoundingClientRect();
      return Math.min(range.getBoundingClientRect().right, box.right) - box.left;
    });
    expect(shown).toBeGreaterThan(60);
    expect(await bar.locator('[data-slot="pane-actions"]').boundingBox()).toEqual(actions);
    // The word is there for a screen reader, not on screen.
    expect(await note(page).locator("svg").isVisible()).toBe(true);
    expect(await note(page).locator('[data-slot="connection-word"]').isVisible()).toBe(false);
    expect(await note(page).locator(".sr-only").textContent()).toBe("Reconnecting…");
    await page.close();
  } finally {
    server.cleanup();
  }
}, 90_000);

test("a canvas with a long project / feature label keeps its heading, connected or not", async () => {
  const { server, ids } = await serve({ crowded: true });
  const page = await openPage({ viewport: { width: 960, height: 800 } });
  try {
    await page.goto(`${server.baseUrl}/canvas/${ids.canvasId}`);
    const header = page.locator('[data-slot="pane-header"]');
    const heading = header.locator("h1").first();
    const label = header.getByText("Mandate development / Connection transport cleanup with release notes", { exact: true });
    await header.locator("h1", { hasText: "Cache policy for the transport" }).waitFor();
    await label.waitFor();
    const widths = async () => ({ heading: (await heading.boundingBox())!.width, label: (await label.boundingBox())!.width });
    const connected = await widths();
    // The heading comes first: shown whole, while the label gives way if anything must.
    expect(connected.heading).toBeGreaterThan(100);
    expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dropStream(page, server);
    const reconnecting = await widths();
    expect(reconnecting.heading).toBeGreaterThan(100);
    const labelBox = (await label.boundingBox())!;
    expect(labelBox.x + labelBox.width).toBeLessThanOrEqual((await note(page).boundingBox())!.x);
    await page.close();
  } finally {
    server.cleanup();
  }
}, 90_000);

test("on a 390 or 430px phone a long title gives way to the whole word, crowded or not", async () => {
  // It used to shrink a fraction of a pixel with a long title and read "Reconnectin…".
  const title = "project-1 3.21 release notes and the project-2 upgrade plan";
  // Plain and crowded side by side: two servers, both dropped at once.
  const runs = await Promise.all([false, true].map(async (crowded) => ({ crowded, ...await serve({ crowded, title }) })));
  const pages: Page[] = [];
  try {
    await Promise.all(runs.flatMap(({ crowded, server, ids }) => [390, 430].map(async (width) => {
      const page = await openPage({ viewport: { width, height: 700 }, isMobile: true, hasTouch: true });
      pages.push(page);
      await page.goto(`${server.baseUrl}/threads/${ids.threadId}`);
      await page.locator("header").first().getByText(title).first().waitFor();
      if (crowded) await page.locator("header").first().getByText("Workers").waitFor();
    })));
    await Promise.all(runs.map(({ server }) => server.stop()));
    for (const page of pages) {
      await untilReconnecting(page);
      const word = note(page).locator('[data-slot="connection-word"]');
      expect(await word.evaluate((el) => getComputedStyle(el).visibility)).toBe("visible");
      const { text, box } = await word.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return { text: range.getBoundingClientRect().width, box: el.getBoundingClientRect().width };
      });
      expect(text).toBeGreaterThan(60);
      expect(text).toBeLessThanOrEqual(box + 0.05);
      // The title still reads: it is what gave way.
      const bar = page.locator("header").first();
      const shown = await bar.getByText(title).first().evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = node.getBoundingClientRect();
        return Math.min(range.getBoundingClientRect().right, rect.right) - rect.left;
      });
      expect(shown).toBeGreaterThan(50);
    }
    expect(pages.length).toBe(4);
  } finally {
    for (const page of pages) await page.close();
    for (const { server } of runs) server.cleanup();
  }
}, 120_000);

test("a narrow pane under a design canvas's toolbar: the actions stay put, and the word is whole or a spinner", async () => {
  // The toolbar leaves the title what room it can; once the title is gone the
  // word must not push the actions, nor read cut. Since the canvas's view went
  // into its menu, the toolbar is that menu and Close.
  const design: DesignSnapshot = {
    index: {
      title: "Checkout redesign",
      // A page name that fills the picker, and a board small enough to open at 100%.
      pages: [{ id: "main", name: "Checkout flow, mobile first, second pass" }, { id: "alt", name: "Alt" }],
      boards: [{ path: "Cart.html", x: 0, y: 0, w: 120, h: 90, title: "Cart", page: "main", expand: null, interactive: false, radius: 0 }],
      notes: [],
      launch: { view: "canvas", page: "main" }
    },
    artboards: { "Cart.html": "<main><h1>Cart</h1></main>" }
  };
  // One server under all four widths, so one drop covers them.
  const fixture = startWorkspaceFixture();
  fixture.setCanvasDesign(design);
  const widths = [774, 820, 900, 1000];
  const pages: Page[] = [];
  const seen: Array<[number, string]> = [];
  try {
    const before = await Promise.all(widths.map(async (width) => {
      const page = await openPage({ viewport: { width, height: 800 } });
      pages.push(page);
      await page.goto(`${fixture.baseUrl}/canvas/zoom-canvas`);
      const actions = page.locator('[data-slot="pane-header"] [data-slot="pane-actions"]');
      await page.locator('[data-slot="design-world"]').waitFor({ state: "attached" });
      await actions.locator("button").first().waitFor();
      return { page, width, actions, box: await actions.boundingBox() };
    }));
    fixture.stop();
    await Promise.all(pages.map((page) => untilReconnecting(page)));
    await pages[0]!.waitForTimeout(300);
    for (const { page, width, actions, box } of before) {
      expect([width, await actions.boundingBox()]).toEqual([width, box]);
      // The word on screen (not the screen reader's copy), whole; or none, and the spinner.
      const shown = await note(page).evaluate((el) => {
        const word = [...el.querySelectorAll("span")].find((s) => {
          const style = getComputedStyle(s);
          return s.children.length === 0 && s.textContent?.trim() === "Reconnecting…"
            && style.position !== "absolute" && style.display !== "none" && style.visibility !== "hidden";
        });
        if (!word) return "spinner";
        const range = document.createRange();
        range.selectNodeContents(word);
        return range.getBoundingClientRect().width <= word.getBoundingClientRect().width + 1 ? "whole" : "cut";
      });
      seen.push([width, shown]);
      if (shown === "spinner") expect(await note(page).locator("svg").isVisible()).toBe(true);
    }
  } finally {
    for (const page of pages) await page.close();
    fixture.stop();
  }
  // Never cut. With the view in the menu, even a 774px pane has room for the whole word.
  expect(seen).toEqual([[774, "whole"], [820, "whole"], [900, "whole"], [1000, "whole"]]);
}, 120_000);
