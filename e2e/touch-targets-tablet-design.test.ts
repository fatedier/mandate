import { afterAll, beforeAll, test } from "bun:test";
import type { DesignBoard, DesignSnapshot } from "../src/shared/api-contracts";
import type { RunningServer } from "./helpers/server.js";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";
import { startTouchHarness, stopTouchHarness, onPhone, onDevice, expectFit, expectNoCollisions, TABLET, changes } from "./helpers/touch-targets";

// Touch targets: a touch tablet in the desktop layout, and a
// design. The rule and the measurement are in helpers/touch-targets.ts.
let server: RunningServer;
let threadId = "";
beforeAll(async () => {
  const harness = await startTouchHarness({ server: true });
  server = harness.server!;
  threadId = harness.threadId;
}, 60_000);
afterAll(stopTouchHarness);


// A touch tablet gets the desktop layout, whose compact controls predate this
// and keep their size: here the touch areas only must not collide.
test("a touch tablet in the desktop layout: a thread, a canvas, a worker's Changes", async () => {
  const fixture = startWorkspaceFixture();
  try {
    expectNoCollisions("tablet thread", await onDevice(TABLET, `${fixture.baseUrl}/threads/${THREAD_ID}`, '[placeholder="Message the manager…"]'));
    // The collapsed rail: Expand, then full screen under it.
    expectNoCollisions("tablet thread, the sidebar collapsed", await onDevice(TABLET, `${fixture.baseUrl}/threads/${THREAD_ID}`, '[placeholder="Message the manager…"]', async (page) => {
      await page.getByRole("button", { name: "Collapse sidebar" }).tap();
      await page.getByRole("button", { name: "Expand sidebar" }).waitFor();
    }));
    expectNoCollisions("tablet thread, a worker open", await onDevice(TABLET, `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, '[role="tablist"] [role="tab"]'));
    // A call open above another: its details end 8px over the next call.
    expectNoCollisions("tablet thread, a call open", await onDevice(TABLET, `${server.baseUrl}/threads/${threadId}`, '[data-slot="tool-run-line"]', async (page) => {
      await page.locator('[data-slot="tool-run-line"]').first().click();
      await page.locator('[data-slot="tool-call"]').nth(1).click();
      await page.getByRole("button", { name: "Show arguments" }).waitFor();
    }));
    // Inline in the transcript a long output carries Expand beside JSON and Copy.
    expectNoCollisions("tablet thread, a generic call open", await onDevice(TABLET, `${server.baseUrl}/threads/${threadId}`, '[data-slot="tool-run-line"]', async (page) => {
      await page.locator('[data-slot="tool-run-line"]').first().click();
      await page.locator('[data-slot="tool-call"]').nth(3).click();
      await page.getByRole("button", { name: "Expand" }).waitFor();
      await page.getByRole("button", { name: "Expand" }).scrollIntoViewIfNeeded();
    }));
    expectNoCollisions("tablet canvas", await onDevice(TABLET, `${fixture.baseUrl}/canvas/zoom-canvas`, 'button[aria-label="Close canvas"]'));
    expectNoCollisions("tablet changes", await onDevice(TABLET, `${fixture.baseUrl}${WORKER_PATH}?tab=changes`, '[data-slot="changes-tab"] button[title="README.md"]', undefined,
      async (page) => { await page.route("**/api/features/zoom-worker/changes**", (route) => route.fulfill({ json: changes })); }));
    // The narrowest Changes tab: a thread's worker panel at its 320px
    // minimum, beside the chat in a landscape tablet's row. (A row too narrow
    // for both shows the panel whole, so the panel never gets narrower.)
    expectNoCollisions("tablet worker panel Changes, the panel at its minimum", await onDevice({ ...TABLET, viewport: { width: 1024, height: 768 } },
      `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, '[data-slot="worker-panel"] [role="tab"]', async (page) => {
        await page.locator('[data-slot="worker-panel"]').getByRole("tab", { name: "Changes", exact: true }).tap();
        await page.locator('[data-slot="changes-toolbar"]').waitFor();
        const width = await page.locator('[data-slot="worker-panel"]').evaluate((el) => Math.round(el.getBoundingClientRect().width));
        if (width !== 320) throw new Error(`the panel is not at its minimum: ${width}px`);
      }, async (page) => {
        await page.addInitScript(() => localStorage.setItem("mandate.ui", JSON.stringify({ state: { workerPanelRatio: 0 }, version: 0 })));
        await page.route("**/api/features/zoom-worker/changes**", (route) => route.fulfill({ json: changes }));
      }));
    // A portrait tablet's row, the sidebar wider, is too narrow for both: the
    // panel has it whole. When the list fails there, Since base sits right
    // above the error's Retry.
    expectNoCollisions("tablet worker panel Changes, failed", await onDevice({ ...TABLET, viewport: { width: 768, height: 1024 } },
      `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, '[data-slot="worker-panel"] [role="tab"]', async (page) => {
        await page.locator('[data-slot="worker-panel"]').getByRole("tab", { name: "Changes", exact: true }).tap();
        await page.locator('[data-slot="changes-tab"] [data-slot="inline-error"] button').waitFor();
      }, async (page) => {
        await page.addInitScript(() => localStorage.setItem("mandate.ui", JSON.stringify({ state: { sidebarWidth: 360 }, version: 0 })));
        await page.route("**/api/features/zoom-worker/changes**", (route) => route.fulfill({ status: 500, json: { error: "git diff failed" } }));
      }));
  } finally {
    fixture.stop();
  }
}, 90_000);


// A design opened on its middle artboard: the focused bar's Previous and Next
// are both live, side by side.
const board = (path: string, x: number): DesignBoard =>
  ({ path, x, y: 0, w: 390, h: 844, title: path.replace(".html", ""), page: "main", expand: null, interactive: false, radius: 0 });
const FOCUSED_DESIGN: DesignSnapshot = {
  index: {
    title: "Checkout redesign",
    pages: [{ id: "main", name: "" }],
    boards: [board("Cart.html", 0), board("Pay.html", 470), board("Done.html", 940)],
    notes: [],
    launch: { view: "focused", path: "Pay.html" }
  },
  artboards: { "Cart.html": "<h1>Cart</h1>", "Pay.html": "<h1>Pay</h1>", "Done.html": "<h1>Done</h1>" }
};

test("a design's focused bar, on a phone and a touch tablet", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasDesign(FOCUSED_DESIGN);
  try {
    const ready = 'button[aria-label="Next artboard"]:not([disabled])';
    expectFit("design, focused", await onPhone(`${fixture.baseUrl}/canvas/zoom-canvas`, ready));
    expectFit("design, all artboards", await onPhone(`${fixture.baseUrl}/canvas/zoom-canvas`, ready, async (page) => {
      await page.getByRole("button", { name: "All artboards" }).tap();
      await page.locator('[data-slot="name-strip"]').first().waitFor();
    }));
    // All artboards, the phone's canvas menu: a zoom stepper of two
    // icon-only items.
    expectFit("design, its menu open", await onPhone(`${fixture.baseUrl}/canvas/zoom-canvas`, ready, async (page) => {
      await page.getByRole("button", { name: "All artboards" }).tap();
      await page.getByRole("button", { name: "Canvas menu" }).tap();
      await page.getByRole("menuitem", { name: "Zoom in" }).waitFor();
    }));
    expectNoCollisions("tablet design, focused", await onDevice(TABLET, `${fixture.baseUrl}/canvas/zoom-canvas`, ready));
  } finally {
    fixture.stop();
  }
}, 60_000);
