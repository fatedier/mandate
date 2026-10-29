import { expect, test } from "bun:test";
import { SSE_EVENTS } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

const browser = browserForFile();

const html = (text: string) => `<h1>${text}</h1><label>Draft <input id="draft" /></label>
  <script>document.body.dataset.instance = String(Math.random());</script>`;
const documentPath = "/api/canvas/zoom-canvas";

async function open() {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasHtml(html("Original content"));
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5000);
  let requests = 0;
  let failures = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === documentPath) requests++; });
  page.on("requestfailed", (request) => { if (new URL(request.url()).pathname === documentPath) failures++; });
  const errors = trackPageErrors(page);
  const modal = page.getByRole("dialog", { name: "Canvas", exact: true });
  try {
    // The worker's Canvases tab. The Plan tab holds no canvas of its own, so
    // the modal is the document's only reader here.
    await page.goto(fixture.baseUrl + WORKER_PATH + "?tab=reports");
    await page.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).waitFor();
    return {
      fixture, page, modal, errors,
      requests: () => requests, failures: () => failures,
      updated: () => fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "zoom-canvas", featureId: "zoom-worker" }),
      openModal: async () => {
        await page.getByRole("button", { name: /^Open report: / }).click();
        await modal.waitFor();
      },
      closeModal: async () => {
        await modal.getByRole("button", { name: "Close canvas", exact: true }).click();
        await modal.waitFor({ state: "detached" });
      },
      close: async () => { await page.close(); fixture.stop(); }
    };
  } catch (error) { await page.close(); fixture.stop(); throw error; }
}

test("reconnect refreshes the modal once and a publication revision refreshes its assets", async () => {
  const env = await open();
  try {
    let asset = "Initial asset";
    await env.page.route("**/api/canvas/zoom-canvas/assets/label.js", (route) => route.fulfill({
      contentType: "text/javascript", body: `document.getElementById("asset").textContent = ${JSON.stringify(asset)};`
    }));
    env.fixture.setCanvasHtml(`${html("With assets")}<p id="asset"></p><script src="label.js"></script>`);
    await env.openModal();
    await env.modal.locator("iframe").contentFrame().getByText("Initial asset", { exact: true }).waitFor();
    const before = env.requests();
    asset = "Updated asset";
    env.fixture.publishCanvasRevision();
    env.fixture.disconnectEvents();
    await env.modal.locator("iframe").contentFrame().getByText("Updated asset", { exact: true }).waitFor({ timeout: 10000 });
    expect(env.requests()).toBe(before + 1);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);
