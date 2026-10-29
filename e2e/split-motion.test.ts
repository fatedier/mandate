import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { emptyPlan, type FeaturePlanDto } from "../src/shared/api/plans";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { forgetAnimations, motionEnded, recordAnimations, startedAnimations } from "./helpers/animations";

// A split pane moves as the layout changes, never popping in or out: in a
// wide row the divider slides (the side's width), and the side goes only once
// it has slid shut. Asked for less motion, the layout changes at once.
const browser = browserForFile();

const panel = (page: Page) => page.locator('[data-slot="worker-panel"]');
const chat = (page: Page) => page.locator('[data-slot="thread-chat"]');
const noAnimations = motionEnded;

const at = "2026-09-27T10:00:00.000Z";
/** A plan long enough to scroll in the panel. */
const longPlan: FeaturePlanDto = {
  ...emptyPlan("zoom-worker"),
  steps: Array.from({ length: 60 }, (_, i) => ({
    id: i + 1, title: `Step ${i + 1} of the release`, status: i < 3 ? "done" as const : "pending" as const, note: "",
    createdAt: at, startedAt: null, blockedAt: null, completedAt: null, updatedAt: at
  })),
  updatedAt: at
};

/** The panel's scroller (whatever scrolls in it), as [scrollTop, how far it can go]. */
const panelScroll = (page: Page, to?: number) => page.evaluate((top) => {
  const panelEl = document.querySelector('[data-slot="worker-panel"]')!;
  const scroller = Array.from(panelEl.querySelectorAll<HTMLElement>("*")).find((el) => {
    const y = getComputedStyle(el).overflowY;
    return (y === "auto" || y === "scroll") && el.scrollHeight > el.clientHeight + 200;
  });
  if (!scroller) return null;
  if (top !== undefined) scroller.scrollTop = top;
  return [Math.round(scroller.scrollTop), scroller.scrollHeight - scroller.clientHeight];
}, to);

async function open(reduced: boolean, viewport = { width: 1440, height: 900 }, plan?: FeaturePlanDto) {
  const fixture = startWorkspaceFixture();
  if (plan) fixture.setPlan(plan);
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  await recordAnimations(page);
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
  await chat(page).waitFor();
  // The fixture's thread opens with its panel: start from it shut.
  const hide = page.locator('[data-slot="panel-toggle"][aria-label="Hide panel"]');
  await page.locator('[data-slot="panel-toggle"]').waitFor();
  if (await hide.count()) {
    await hide.click();
    await panel(page).waitFor({ state: "detached" });
  }
  await forgetAnimations(page);
  return { page, errors, close: async () => { await page.close(); fixture.stop(); } };
}

test("the worker panel pushes in and out, and maximizing sweeps the divider to the edge", async () => {
  const { page, errors, close } = await open(false);
  try {
    // Positive control: shut, and nothing has moved.
    expect(await panel(page).count()).toBe(0);
    expect(await startedAnimations(page, "worker-panel")).toEqual([]);

    await page.locator('[data-slot="panel-toggle"][aria-label="Show panel"]').click();
    await panel(page).waitFor();
    const opened = await startedAnimations(page, "worker-panel");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.duration).toBe(220);
    expect(opened[0]!.frames[0]).toBe("0px");
    await noAnimations(page, "worker-panel");
    const box = (await panel(page).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(560);
    expect(Number.parseFloat(String(opened[0]!.frames[1]))).toBeCloseTo(box.width, 0);

    // Maximize: the divider sweeps to the edge; the chat goes once covered.
    await panel(page).getByRole("button", { name: "Hide chat" }).click();
    const swept = (await startedAnimations(page, "worker-panel")).at(-1)!;
    expect(swept.frames.map((width) => Math.round(Number.parseFloat(String(width))))).toEqual([Math.round(box.width), expect.any(Number)]);
    await chat(page).waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await chat(page).waitFor({ state: "visible" });
    await noAnimations(page, "worker-panel");

    // Hide: still there while it slides shut, then gone.
    const before = (await startedAnimations(page, "worker-panel")).length;
    await page.locator('[data-slot="panel-toggle"][aria-label="Hide panel"]').click();
    const shut = (await startedAnimations(page, "worker-panel")).slice(before);
    expect(shut.map((a) => a.frames.at(-1))).toEqual(["0px"]);
    await panel(page).waitFor({ state: "detached" });
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("asked for less motion, the worker panel opens, maximizes and closes at once", async () => {
  const { page, errors, close } = await open(true);
  try {
    await page.locator('[data-slot="panel-toggle"][aria-label="Show panel"]').click();
    await panel(page).waitFor();
    await panel(page).getByRole("button", { name: "Hide chat" }).click();
    await chat(page).waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await page.locator('[data-slot="panel-toggle"][aria-label="Hide panel"]').click();
    await panel(page).waitFor({ state: "detached" });
    expect(await startedAnimations(page, "worker-panel")).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("a scrolled panel keeps its place while it maximizes and restores", async () => {
  const { page, errors, close } = await open(false, { width: 1440, height: 900 }, longPlan);
  try {
    await page.goto(page.url().replace(/\?.*$/, "") + "?worker=zoom-worker");
    await panel(page).getByText("Step 60 of the release").waitFor({ state: "attached" });
    await noAnimations(page, "worker-panel");
    // Positive control: the plan scrolls, and is scrolled to 400.
    expect(await panelScroll(page, 400)).toEqual([400, expect.any(Number)]);
    await panel(page).getByRole("button", { name: "Hide chat" }).click();
    await chat(page).waitFor({ state: "hidden" });
    await noAnimations(page, "worker-panel");
    expect((await panelScroll(page))![0]).toBe(400);
    await page.keyboard.press("Escape");
    await chat(page).waitFor({ state: "visible" });
    await noAnimations(page, "worker-panel");
    expect((await panelScroll(page))![0]).toBe(400);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

test("in a narrow window the panel slides over the chat without the page scrolling sideways", async () => {
  const { page, errors, close } = await open(false, { width: 820, height: 900 });
  try {
    await page.locator('[data-slot="panel-toggle"][aria-label="Show panel"]').click();
    // At once, while it slides: nothing to scroll sideways.
    const overflow = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      return [main.scrollWidth - main.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth];
    });
    expect((await startedAnimations(page, "worker-panel")).map((a) => a.frames[0])).toEqual(["translateX(100%)"]);
    expect(overflow).toEqual([0, 0]);
    await chat(page).waitFor({ state: "hidden" });
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);

