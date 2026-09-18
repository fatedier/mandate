import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { API_PATHS, SSE_EVENTS } from "../src/shared/api-contracts";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const documentPath = API_PATHS.canvasById("zoom-canvas");
const html = (version: string) => `<!-- @tailwind: standalone fixture styles -->
  <style>body{font:16px system-ui;padding:16px}#scroll{height:80px;overflow:auto}</style>
  <label>Draft <input id="draft" /></label>
  <div id="scroll"><div style="height:800px">${version}</div></div>
  <script>document.body.dataset.instance = String(Math.random());</script>`;

async function open(tab = "overview", setup?: (page: Page) => Promise<void>) {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasHtml(html("Initial document"));
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5000);
  const requests: string[] = [];
  const featureLookups: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === documentPath) requests.push(request.url());
    if (url.pathname === "/api/work-items" && url.searchParams.has("featureId")) {
      featureLookups.push(url.searchParams.get("featureId")!);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await setup?.(page);
    await page.goto(fixture.baseUrl + WORKER_PATH + (tab === "overview" ? "" : `?tab=${tab}`));
    await page.locator("main").getByRole("tab", { name: "Overview", exact: true }).waitFor();
  } catch (error) {
    await page.close();
    fixture.stop();
    throw error;
  }
  const iframe = page.locator("main iframe");
  return {
    fixture, page, iframe, frame: iframe.contentFrame(), requests, featureLookups, errors,
    close: async () => { await page.close(); fixture.stop(); }
  };
}

test("Canvas documents remain accessible without a global gallery", async () => {
  const env = await open("artifacts");
  try {
    expect(await env.page.locator('a[href="/canvas"]').count()).toBe(0);
    await env.page.getByRole("button", { name: /^Open canvas: / }).click();
    const modal = env.page.getByRole("dialog", { name: "Canvas", exact: true });
    await modal.locator("iframe").contentFrame().locator("#draft").waitFor();
    await modal.getByRole("button", { name: "Close canvas", exact: true }).click();
    await modal.waitFor({ state: "detached" });

    await env.page.goto(`${env.fixture.baseUrl}/canvas/zoom-canvas`);
    await env.page.locator("main iframe").contentFrame().locator("#draft").waitFor();
    expect(await env.page.locator('a[href="/canvas"]').count()).toBe(0);

    await env.page.goto(`${env.fixture.baseUrl}/canvas`);
    await env.page.waitForURL(`${env.fixture.baseUrl}/projects`);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("Worker tabs preserve the Canvas document, input and scroll without another fetch", async () => {
  const env = await open("terminal");
  try {
    await env.page.getByText("No panes in this window", { exact: true }).waitFor();
    expect(await env.iframe.count()).toBe(0);
    expect(env.requests).toHaveLength(0);

    await env.page.getByRole("tab", { name: "Overview", exact: true }).click();
    await env.frame.locator("#draft").fill("Keep this draft");
    await env.frame.locator("#scroll").evaluate((node) => { node.scrollTop = 120; });
    const iframe = await env.iframe.elementHandle();
    const instance = await env.frame.locator("body").getAttribute("data-instance");
    expect(instance).toBeTruthy();

    for (const tab of ["Terminal", "Canvases", "Changes"]) {
      await env.page.getByRole("tab", { name: tab, exact: true }).click();
      await env.iframe.waitFor({ state: "hidden" });
      expect(await iframe!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await env.iframe.count()).toBe(1);
      await env.page.getByRole("tab", { name: "Overview", exact: true }).click();
      await env.frame.locator("#draft").waitFor();
      expect(await env.iframe.evaluate((node, original) => node === original, iframe)).toBe(true);
      expect(await env.frame.locator("body").getAttribute("data-instance")).toBe(instance);
      expect(await env.frame.locator("#draft").inputValue()).toBe("Keep this draft");
      expect(await env.frame.locator("#scroll").evaluate((node) => node.scrollTop)).toBe(120);
      await env.page.waitForFunction(() => {
        const iframe = document.querySelector<HTMLIFrameElement>("main iframe");
        return Number.parseFloat(iframe?.style.height ?? "0") > 100;
      });
      expect(env.requests).toHaveLength(1);
    }
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("A retained Canvas receives matching updates without reloading unchanged HTML", async () => {
  const env = await open();
  try {
    await env.frame.locator("#draft").fill("Keep on revalidation");
    const instance = await env.frame.locator("body").getAttribute("data-instance");
    await env.page.getByRole("tab", { name: "Terminal", exact: true }).click();
    const unchanged = env.page.waitForResponse((response) => new URL(response.url()).pathname === documentPath);
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "unrelated-canvas" });
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "zoom-canvas" });
    await unchanged;
    await env.page.getByRole("tab", { name: "Overview", exact: true }).click();
    expect(await env.frame.locator("#draft").inputValue()).toBe("Keep on revalidation");
    expect(await env.frame.locator("body").getAttribute("data-instance")).toBe(instance);
    expect(env.requests).toHaveLength(2);

    await env.page.getByRole("tab", { name: "Terminal", exact: true }).click();
    env.fixture.setCanvasHtml(html("Updated while hidden"));
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "zoom-canvas" });
    await env.iframe.waitFor({ state: "detached" });
    await env.page.getByRole("tab", { name: "Overview", exact: true }).click();
    await env.frame.getByText("Updated while hidden", { exact: true }).waitFor();
    expect(env.requests).toHaveLength(3);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("Retained Canvas content is revalidated after SSE reconnects", async () => {
  const env = await open();
  try {
    await env.frame.locator("#draft").waitFor();
    await env.page.getByRole("tab", { name: "Terminal", exact: true }).click();
    env.fixture.setCanvasHtml(html("Updated during disconnect"));
    env.fixture.disconnectEvents();
    await env.iframe.waitFor({ state: "detached", timeout: 10000 });
    await env.page.getByRole("tab", { name: "Overview", exact: true }).click();
    await env.frame.getByText("Updated during disconnect", { exact: true }).waitFor();
    expect(env.requests).toHaveLength(2);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("Republishing unchanged HTML reloads updated Canvas assets", async () => {
  const env = await open();
  let assetText = "First asset";
  let assetRequests = 0;
  try {
    await env.page.route("**/api/canvas/zoom-canvas/assets/label.js", async (route) => {
      assetRequests++;
      await route.fulfill({
        contentType: "text/javascript",
        body: `document.getElementById("asset").textContent = ${JSON.stringify(assetText)};`
      });
    });
    env.fixture.setCanvasHtml(`${html("Document with linked assets")}
      <p id="asset"></p><script src="label.js"></script>`);
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "zoom-canvas" });
    await env.frame.getByText("First asset", { exact: true }).waitFor();
    const srcDoc = await env.iframe.getAttribute("srcdoc");
    const instance = await env.frame.locator("body").getAttribute("data-instance");

    await env.page.getByRole("tab", { name: "Terminal", exact: true }).click();
    assetText = "Updated asset";
    env.fixture.publishCanvasRevision();
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "zoom-canvas" });
    await env.iframe.waitFor({ state: "detached" });
    expect(assetRequests).toBe(1);
    await env.page.getByRole("tab", { name: "Overview", exact: true }).click();
    await env.frame.getByText("Updated asset", { exact: true }).waitFor();
    expect(await env.iframe.getAttribute("srcdoc")).toBe(srcDoc);
    expect(await env.frame.locator("body").getAttribute("data-instance")).not.toBe(instance);
    expect(assetRequests).toBe(2);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("Renaming a retained Canvas preserves its document and draft", async () => {
  const env = await open();
  try {
    await env.frame.locator("#draft").fill("Keep on rename");
    await env.frame.locator("#scroll").evaluate((node) => { node.scrollTop = 120; });
    const instance = await env.frame.locator("body").getAttribute("data-instance");
    env.fixture.renameCanvas("Renamed canvas");
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "zoom-canvas" });
    await env.page.locator("main").getByText("Renamed canvas", { exact: true }).waitFor();
    expect(await env.frame.locator("#draft").inputValue()).toBe("Keep on rename");
    expect(await env.frame.locator("#scroll").evaluate((node) => node.scrollTop)).toBe(120);
    expect(await env.frame.locator("body").getAttribute("data-instance")).toBe(instance);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("SSE resynchronization refreshes retained Canvas without an intervening error state", async () => {
  const env = await open();
  try {
    await env.frame.locator("#draft").waitFor();
    await env.page.getByRole("tab", { name: "Terminal", exact: true }).click();
    env.fixture.setCanvasHtml(html("Updated during resynchronization"));
    env.fixture.emit(SSE_EVENTS.agentMessagePatch, {
      threadId: "zoom-thread", wakeId: "missing-baseline", offset: 8, deltaText: "tail"
    });
    await env.iframe.waitFor({ state: "detached" });
    await env.page.getByRole("tab", { name: "Overview", exact: true }).click();
    await env.frame.getByText("Updated during resynchronization", { exact: true }).waitFor();
    expect(env.requests).toHaveLength(2);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("Returning to Overview retries a failed lookup for a task outside the startup list", async () => {
  let lookups = 0;
  const env = await open("overview", async (page) => {
    await page.route("**/api/work-items?*", async (route) => {
      if (!new URL(route.request().url()).searchParams.has("featureId")) {
        return route.fulfill({ json: { items: [], nextCursor: null } });
      }
      lookups++;
      if (lookups === 1) return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
      return route.continue();
    });
  });
  try {
    await env.page.getByText("no work item for this feature", { exact: true }).waitFor();
    expect(await env.iframe.count()).toBe(0);
    await env.page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await env.page.getByRole("tab", { name: "Overview", exact: true }).click();
    await env.frame.locator("#draft").waitFor();
    expect(lookups).toBe(2);
    expect(env.requests).toHaveLength(1);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("A failed retained Canvas load can be retried without navigation or an SSE update", async () => {
  const env = await open("overview", async (page) => {
    let failed = false;
    await page.route("**/api/canvas/zoom-canvas", async (route) => {
      if (failed) return route.continue();
      failed = true;
      await route.fulfill({ status: 503, json: { error: "Canvas temporarily unavailable" } });
    });
  });
  try {
    await env.page.getByText("Canvas temporarily unavailable", { exact: true }).waitFor();
    await env.page.getByRole("button", { name: "Retry canvas", exact: true }).click();
    await env.frame.locator("#draft").fill("Recovered draft");
    await env.page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await env.page.getByRole("tab", { name: "Overview", exact: true }).click();
    expect(await env.frame.locator("#draft").inputValue()).toBe("Recovered draft");
    expect(env.requests).toHaveLength(2);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("Changing workers and visiting Projects retains Canvas without eagerly mounting another Overview", async () => {
  const env = await open();
  try {
    await env.frame.locator("#draft").fill("Previous worker draft");
    const iframe = await env.iframe.elementHandle();
    // Exercise a same-route parameter change without reloading the app shell.
    await env.page.evaluate(() => {
      history.pushState(history.state, "", "/projects/zoom-project/features/other-worker?tab=terminal");
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    await env.page.getByRole("heading", { name: "1: other-worker", exact: true }).waitFor();
    expect(await iframe!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await env.iframe.isVisible()).toBe(false);
    expect(await env.iframe.count()).toBe(1);
    expect(env.featureLookups).not.toContain("other-worker");

    await env.page.goBack();
    await env.frame.locator("#draft").waitFor();
    expect(await env.frame.locator("#draft").inputValue()).toBe("Previous worker draft");
    expect(await env.iframe.evaluate((node, original) => node === original, iframe)).toBe(true);
    expect(env.requests).toHaveLength(1);
    // The redesign has no "close drawer" that leaves the Worker; leaving is a
    // navigation, here via the sidebar's Home link.
    await env.page.locator('nav a[href="/projects"]').first().click();
    await env.page.waitForURL(env.fixture.baseUrl + "/projects");
    await env.iframe.waitFor({ state: "hidden" });
    expect(await env.iframe.count()).toBe(1);
    await env.page.goBack();
    await env.frame.locator("#draft").waitFor();
    expect(await env.frame.locator("#draft").inputValue()).toBe("Previous worker draft");
    expect(env.requests).toHaveLength(1);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);

test("Failed background revalidation preserves drafts while deleted Canvas content is removed", async () => {
  const env = await open();
  let status = 503;
  try {
    await env.frame.locator("#draft").fill("Keep through a temporary failure");
    const iframe = await env.iframe.elementHandle();
    const instance = await env.frame.locator("body").getAttribute("data-instance");
    await env.page.route("**/api/canvas/zoom-canvas", async (route) => {
      if (status === 200) return route.continue();
      return route.fulfill({ status, json: { error: status === 503 ? "Temporary refresh failure" : "Canvas was deleted" } });
    });
    env.fixture.disconnectEvents();
    await env.page.getByText("Temporary refresh failure", { exact: true }).waitFor({ timeout: 10000 });
    expect(await iframe!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await env.frame.locator("#draft").inputValue()).toBe("Keep through a temporary failure");

    status = 200;
    const retried = env.page.waitForResponse((response) => new URL(response.url()).pathname === documentPath);
    await env.page.getByRole("button", { name: "Retry canvas", exact: true }).click();
    await retried;
    expect(await env.frame.locator("body").getAttribute("data-instance")).toBe(instance);
    expect(await env.frame.locator("#draft").inputValue()).toBe("Keep through a temporary failure");
    expect(env.requests).toHaveLength(3);

    status = 404;
    env.fixture.emit(SSE_EVENTS.canvasUpdated, { canvasId: "zoom-canvas" });
    await env.page.getByText("Canvas was deleted", { exact: true }).waitFor();
    await env.iframe.waitFor({ state: "detached" });
    expect(env.requests).toHaveLength(4);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);
