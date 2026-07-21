import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { SSE_EVENTS } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const html = (text: string) => `<!-- @tailwind: standalone fixture styles -->
  <style>body{font:16px system-ui;padding:16px}#scroll{height:80px;overflow:auto}</style>
  <label>Draft <input id="draft" /></label>
  <div id="scroll"><div style="height:800px">${text}</div></div>
  <script>document.body.dataset.instance = String(Math.random());</script>`;
const workerPath = (id: string) => `/projects/zoom-project/features/${id}`;

async function navigate(page: Page, path: string) {
  await page.evaluate((path) => {
    history.pushState(history.state, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, path);
}

async function open(extraWorkers = 1) {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasHtml(html("Original canvas"));
  for (let i = 1; i <= extraWorkers; i++) fixture.addWorkerCanvas(`worker-${i}`, html(`Canvas ${i}`));
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5000);
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/canvas\/[^/]+$/.test(path)) requests.push(path);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const iframe = (id: string) => page.locator(`[data-worker-canvas="${id}"] iframe`);
  const visit = async (id: string) => {
    await navigate(page, workerPath(id));
    await iframe(id).contentFrame().locator("#draft").waitFor();
  };
  try {
    await page.goto(fixture.baseUrl + WORKER_PATH);
    await iframe("zoom-worker").contentFrame().locator("#draft").waitFor();
    return { fixture, page, iframe, visit, requests, errors, close: async () => { await page.close(); fixture.stop(); } };
  } catch (error) { await page.close(); fixture.stop(); throw error; }
}

test("Cross-Worker visits preserve each Canvas instance, draft and scroll through Projects", async () => {
  const env = await open();
  try {
    const first = env.iframe("zoom-worker");
    const firstFrame = first.contentFrame();
    const instance = await firstFrame.locator("body").getAttribute("data-instance");
    await firstFrame.locator("#draft").fill("First worker draft");
    await firstFrame.locator("#scroll").evaluate((node) => { node.scrollTop = 160; });
    await env.visit("worker-1");
    const second = env.iframe("worker-1").contentFrame();
    await second.locator("#draft").fill("Second worker draft");
    expect(await first.isVisible()).toBe(false);
    await navigate(env.page, "/projects");
    await env.iframe("worker-1").waitFor({ state: "hidden" });
    expect(await env.page.locator("main iframe").count()).toBe(2);
    await env.visit("zoom-worker");
    expect(await firstFrame.locator("body").getAttribute("data-instance")).toBe(instance);
    expect(await firstFrame.locator("#draft").inputValue()).toBe("First worker draft");
    expect(await firstFrame.locator("#scroll").evaluate((node) => node.scrollTop)).toBe(160);
    await env.visit("worker-1");
    expect(await second.locator("#draft").inputValue()).toBe("Second worker draft");
    expect(env.requests).toHaveLength(2);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("The ten-instance limit evicts the least recently viewed Canvas without moving survivors", async () => {
  const env = await open(10);
  try {
    const original = env.iframe("zoom-worker").contentFrame();
    await original.locator("#draft").fill("Most recently revisited");
    const instances = new Map<string, string | null>([["zoom-worker", await original.locator("body").getAttribute("data-instance")]]);
    for (let i = 1; i <= 9; i++) {
      await env.visit(`worker-${i}`);
      instances.set(`worker-${i}`, await env.iframe(`worker-${i}`).contentFrame().locator("body").getAttribute("data-instance"));
    }
    expect(await env.page.locator("main iframe").count()).toBe(10);
    await env.visit("zoom-worker");
    expect(await original.locator("#draft").inputValue()).toBe("Most recently revisited");
    await env.visit("worker-10");
    expect(await env.page.locator("main iframe").count()).toBe(10);
    expect(await env.iframe("worker-1").count()).toBe(0);
    for (const id of ["zoom-worker", ...Array.from({ length: 8 }, (_, i) => `worker-${i + 2}`)]) {
      expect(await env.iframe(id).contentFrame().locator("body").getAttribute("data-instance")).toBe(instances.get(id)!);
    }
    expect(env.requests).toHaveLength(11);
    await env.visit("worker-1");
    expect(await env.iframe("worker-1").contentFrame().locator("body").getAttribute("data-instance")).not.toBe(instances.get("worker-1")!);
    expect(await env.iframe("worker-2").count()).toBe(0);
    expect(await env.page.locator("main iframe").count()).toBe(10);
    expect(env.requests.filter((path) => path === "/api/canvas/worker-1-canvas")).toHaveLength(2);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 25000);

test("Cached workers receive hidden updates and revalidate after reconnecting on Projects", async () => {
  const env = await open();
  try {
    const first = env.iframe("zoom-worker").contentFrame();
    const instance = await first.locator("body").getAttribute("data-instance");
    await first.locator("#draft").fill("Draft survives a rename");
    await env.visit("worker-1");
    const renamed = env.page.waitForResponse((response) => new URL(response.url()).pathname === "/api/canvas/zoom-canvas");
    env.fixture.renameCanvas("Renamed cached canvas");
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "zoom-canvas" });
    await renamed;
    await env.visit("zoom-worker");
    await env.page.getByText("Renamed cached canvas", { exact: true }).waitFor();
    expect(await first.locator("body").getAttribute("data-instance")).toBe(instance);
    expect(await first.locator("#draft").inputValue()).toBe("Draft survives a rename");
    await navigate(env.page, "/projects");
    await env.iframe("zoom-worker").waitFor({ state: "hidden" });
    env.fixture.setCanvasHtml(html("Updated while disconnected"));
    env.fixture.disconnectEvents();
    await env.iframe("zoom-worker").waitFor({ state: "detached", timeout: 10000 });
    await env.visit("zoom-worker");
    await first.getByText("Updated while disconnected", { exact: true }).waitFor();
    expect(env.requests.filter((path) => path === "/api/canvas/zoom-canvas")).toHaveLength(3);
    expect(env.requests.filter((path) => path === "/api/canvas/worker-1-canvas")).toHaveLength(2);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 20000);

test("Removed workers and cleared bindings release cached frames and their update listeners", async () => {
  const env = await open();
  try {
    await env.visit("worker-1");
    const initial = await env.iframe("worker-1").contentFrame().locator("body").getAttribute("data-instance");
    env.fixture.removeWorker("zoom-worker");
    await env.iframe("zoom-worker").waitFor({ state: "detached" });
    const count = env.requests.length;
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "zoom-canvas" });
    env.fixture.bindCanvas("worker-1", null);
    await env.iframe("worker-1").waitFor({ state: "detached" });
    expect(await env.page.locator("main iframe").count()).toBe(0);
    env.fixture.bindCanvas("worker-1", "worker-1-canvas");
    await env.iframe("worker-1").contentFrame().locator("#draft").waitFor();
    expect(await env.iframe("worker-1").contentFrame().locator("body").getAttribute("data-instance")).not.toBe(initial);
    expect(env.requests).toHaveLength(count + 1);
    env.fixture.emit(SSE_EVENTS.projectsState, []);
    await env.iframe("worker-1").waitFor({ state: "detached" });
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("Evicting a loading Canvas cancels its request and removes its update listener", async () => {
  const env = await open(11);
  try {
    let hold: (route: Route) => void;
    const held = new Promise<Route>((resolve) => { hold = resolve; });
    await env.page.route("**/api/canvas/worker-1-canvas", (route) => hold(route));
    await navigate(env.page, workerPath("worker-1"));
    const route = await held;
    const canceled = env.page.waitForEvent("requestfailed", {
      predicate: (request) => new URL(request.url()).pathname === "/api/canvas/worker-1-canvas",
      timeout: 15000
    });
    for (let i = 2; i <= 11; i++) await env.visit(`worker-${i}`);
    await canceled;
    await route.abort();
    expect(await env.page.locator("[data-worker-canvas=worker-1]").count()).toBe(0);
    expect(await env.page.locator("main iframe").count()).toBe(10);
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "worker-1-canvas" });
    // A later live response establishes that the event dispatch has completed.
    const refreshed = env.page.waitForResponse((response) => new URL(response.url()).pathname === "/api/canvas/worker-11-canvas");
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "worker-11-canvas" });
    await refreshed;
    expect(env.requests.filter((path) => path === "/api/canvas/worker-1-canvas")).toHaveLength(1);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 20000);
