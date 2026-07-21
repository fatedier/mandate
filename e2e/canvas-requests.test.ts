import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Route } from "playwright";
import { SSE_EVENTS } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const html = (text: string) => `<!-- @tailwind: standalone fixture -->
  <h1>${text}</h1><label>Draft <input id="draft" /></label>
  <script>document.body.dataset.instance = String(Math.random());</script>`;
const documentPath = "/api/canvas/zoom-canvas";

async function open() {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasHtml(html("Original content"));
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5000);
  let requests = 0;
  let failures = 0;
  const errors: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === documentPath) requests++; });
  page.on("requestfailed", (request) => { if (new URL(request.url()).pathname === documentPath) failures++; });
  page.on("pageerror", (error) => errors.push(error.message));
  const worker = page.locator('[data-worker-canvas="zoom-worker"]');
  const modal = page.getByRole("dialog", { name: "Canvas", exact: true });
  try {
    await page.goto(fixture.baseUrl + WORKER_PATH);
    await worker.locator("iframe").contentFrame().locator("#draft").fill("Worker draft");
    await page.getByRole("button", { name: "Artifacts", exact: true }).click();
    await page.getByRole("button", { name: "Open canvas: Workspace canvas", exact: true }).waitFor();
    return {
      fixture, page, worker, modal, errors,
      requests: () => requests, failures: () => failures,
      updated: () => fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "zoom-canvas", featureId: "zoom-worker" }),
      openModal: async () => {
        await page.getByRole("button", { name: /^Open canvas: / }).click();
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

async function holdRequests(env: Awaited<ReturnType<typeof open>>) {
  let capture: ((route: Route) => void) | undefined;
  await env.page.route("**/api/canvas/zoom-canvas", (route) => {
    const resolve = capture;
    capture = undefined;
    if (resolve) resolve(route);
    else return route.continue();
  });
  return () => new Promise<Route>((resolve) => { capture = resolve; });
}

test("a Canvas modal joins the Worker's pending request and one update does not fan out twice", async () => {
  const env = await open();
  try {
    const next = await holdRequests(env);
    const pending = next();
    env.fixture.renameCanvas("Shared document");
    env.updated();
    const route = await pending;
    await env.openModal();
    await env.modal.getByRole("button", { name: "Refreshing canvas", exact: true }).waitFor();
    expect(env.requests()).toBe(2);
    await route.fulfill({ response: await route.fetch() });
    await env.modal.getByRole("heading", { name: "Shared document", exact: true }).waitFor();
    await env.worker.getByText("Shared document", { exact: true }).waitFor({ state: "attached" });
    await env.page.waitForTimeout(150);
    expect(env.requests()).toBe(2);
    expect(env.failures()).toBe(0);
    await env.closeModal();
    await env.page.getByRole("button", { name: "Overview", exact: true }).click();
    expect(await env.worker.locator("iframe").contentFrame().locator("#draft").inputValue()).toBe("Worker draft");
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 10000);

test("updates throughout a slow shared download cause one follow-up without canceling progress", async () => {
  const env = await open();
  try {
    const next = await holdRequests(env);
    const firstPending = next();
    env.fixture.setCanvasHtml(html("Interim content"));
    env.fixture.publishCanvasRevision();
    env.updated();
    const first = await firstPending;
    const interim = await first.fetch();
    await env.openModal();
    await env.modal.getByRole("button", { name: "Refreshing canvas", exact: true }).waitFor();
    env.fixture.setCanvasHtml(html("Latest content"));
    env.fixture.publishCanvasRevision();
    for (let i = 0; i < 20; i++) env.updated();
    await env.page.waitForTimeout(200);
    expect(env.requests()).toBe(2);
    expect(env.failures()).toBe(0);
    const secondPending = next();
    await first.fulfill({ response: interim });
    await env.modal.locator("iframe").contentFrame().getByRole("heading", { name: "Interim content", exact: true }).waitFor();
    const second = await secondPending;
    expect(env.requests()).toBe(3);
    await second.fulfill({ response: await second.fetch() });
    await env.modal.locator("iframe").contentFrame().getByRole("heading", { name: "Latest content", exact: true }).waitFor();
    await env.closeModal();
    await env.page.getByRole("button", { name: "Overview", exact: true }).click();
    await env.worker.locator("iframe").contentFrame().getByRole("heading", { name: "Latest content", exact: true }).waitFor();
    expect(env.requests()).toBe(3);
    expect(env.failures()).toBe(0);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 10000);

test("closing the modal leaves a request alive for the retained Worker", async () => {
  const env = await open();
  try {
    const next = await holdRequests(env);
    const pending = next();
    await env.openModal();
    const route = await pending;
    await env.closeModal();
    expect(env.failures()).toBe(0);
    env.fixture.renameCanvas("Delivered after closing");
    await route.fulfill({ response: await route.fetch() });
    await env.worker.getByText("Delivered after closing", { exact: true }).waitFor({ state: "attached" });
    await env.page.getByRole("button", { name: "Overview", exact: true }).click();
    expect(await env.worker.locator("iframe").contentFrame().locator("#draft").inputValue()).toBe("Worker draft");
    expect(env.requests()).toBe(2);
    expect(env.failures()).toBe(0);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 10000);

test("releasing the final reader aborts its request and removes shared event listeners", async () => {
  const env = await open();
  try {
    const next = await holdRequests(env);
    const pending = next();
    await env.openModal();
    const route = await pending;
    env.fixture.bindCanvas("zoom-worker", null);
    await env.worker.waitFor({ state: "detached" });
    expect(env.failures()).toBe(0);
    const canceled = env.page.waitForEvent("requestfailed", { predicate: (request) => request === route.request() });
    await env.closeModal();
    await canceled;
    await route.abort();
    env.updated();
    await env.page.waitForTimeout(150);
    expect(env.requests()).toBe(2);
    expect(env.failures()).toBe(1);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 10000);

test("reconnect refreshes both readers once and a publication revision refreshes modal assets", async () => {
  const env = await open();
  try {
    let asset = "Initial asset";
    await env.page.route("**/api/canvas/zoom-canvas/assets/label.js", (route) => route.fulfill({
      contentType: "text/javascript", body: `document.getElementById("asset").textContent = ${JSON.stringify(asset)};`
    }));
    env.fixture.setCanvasHtml(`${html("With assets")}<p id="asset"></p><script src="label.js"></script>`);
    env.updated();
    await env.worker.locator("iframe").waitFor({ state: "detached" });
    await env.openModal();
    await env.modal.locator("iframe").contentFrame().getByText("Initial asset", { exact: true }).waitFor();
    const before = env.requests();
    asset = "Updated asset";
    env.fixture.publishCanvasRevision();
    env.fixture.disconnectEvents();
    await env.modal.locator("iframe").contentFrame().getByText("Updated asset", { exact: true }).waitFor({ timeout: 10000 });
    expect(env.requests()).toBe(before + 1);
    await env.closeModal();
    await env.page.getByRole("button", { name: "Overview", exact: true }).click();
    await env.worker.locator("iframe").contentFrame().getByText("Updated asset", { exact: true }).waitFor();
    expect(env.requests()).toBe(before + 1);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);
