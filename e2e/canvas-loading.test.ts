import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Route } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

const html = `<!doctype html><html><head><!-- @tailwind: standalone fixture -->
  <script src="startup.js"></script></head><body>
  <div id="content"></div><script>
    const width = document.body.getBoundingClientRect().width;
    document.body.dataset.initialWidth = String(width);
    document.body.dataset.instance = String(Math.random());
    if (width > 0) document.getElementById("content").innerHTML = '<h1>Ready canvas</h1><label>Draft <input id="draft" /></label>';
  </script></body></html>`;

async function open() {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasHtml(html);
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5000);
  const documents: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/canvas/zoom-canvas") documents.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const navigate = (path: string) => page.evaluate((path) => {
    history.pushState(history.state, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, path);
  const iframe = page.locator('[data-worker-canvas="zoom-worker"] iframe');
  try {
    await page.goto(fixture.baseUrl + WORKER_PATH + "?tab=terminal");
    await page.getByRole("button", { name: "Overview", exact: true }).waitFor();
    return { fixture, page, documents, errors, navigate, iframe, close: async () => { await page.close(); fixture.stop(); } };
  } catch (error) { await page.close(); fixture.stop(); throw error; }
}

for (const destination of ["/projects", WORKER_PATH + "?tab=terminal"]) {
  test(`Leaving an unfinished iframe for ${destination} cancels its load and returning retries it`, async () => {
    const env = await open();
    try {
      let capture: (route: Route) => void;
      const pending = new Promise<Route>((resolve) => { capture = resolve; });
      let assets = 0;
      await env.page.route("**/api/canvas/zoom-canvas/assets/startup.js", async (route) => {
        if (++assets === 1) capture(route);
        else await route.fulfill({ contentType: "text/javascript", body: "window.assetReady = true;" });
      });
      await env.page.getByRole("button", { name: "Overview", exact: true }).click();
      const first = await pending;
      const canceled = env.page.waitForEvent("requestfailed", { predicate: (request) => request === first.request() });
      await env.navigate(destination);
      await canceled;
      await env.iframe.waitFor({ state: "detached" });
      await first.abort();

      await env.navigate(WORKER_PATH);
      const frame = env.iframe.contentFrame();
      await frame.locator("#draft").fill("Keep the completed draft");
      const instance = await frame.locator("body").getAttribute("data-instance");
      expect(Number(await frame.locator("body").getAttribute("data-initial-width"))).toBeGreaterThan(0);
      expect(assets).toBe(2);
      expect(env.documents).toHaveLength(1);

      await env.navigate(destination);
      await env.iframe.waitFor({ state: "hidden" });
      expect(await env.iframe.count()).toBe(1);
      await env.navigate(WORKER_PATH);
      await frame.locator("#draft").waitFor();
      expect(await frame.locator("#draft").inputValue()).toBe("Keep the completed draft");
      expect(await frame.locator("body").getAttribute("data-instance")).toBe(instance);
      expect(assets).toBe(2);
      expect(env.documents).toHaveLength(1);
      expect(env.errors).toEqual([]);
    } finally { await env.close(); }
  }, 15000);
}

test("A document received after leaving waits for a visible viewport before creating its iframe", async () => {
  const env = await open();
  try {
    let capture: (route: Route) => void;
    const pending = new Promise<Route>((resolve) => { capture = resolve; });
    await env.page.route("**/api/canvas/zoom-canvas", (route) => capture(route));
    let assets = 0;
    await env.page.route("**/api/canvas/zoom-canvas/assets/startup.js", async (route) => {
      assets++;
      await route.fulfill({ contentType: "text/javascript", body: "window.assetReady = true;" });
    });
    await env.page.getByRole("button", { name: "Overview", exact: true }).click();
    const route = await pending;
    await env.navigate("/projects");
    const response = await route.fetch();
    await route.fulfill({ response });
    await env.page.locator('[data-worker-canvas="zoom-worker"]').getByText("Workspace canvas", { exact: true }).waitFor({ state: "attached" });
    // Wait beyond the initial render to catch eager initialization in a hidden frame.
    await env.page.waitForTimeout(200);
    expect(assets).toBe(0);
    expect(await env.iframe.count()).toBe(0);
    await env.navigate(WORKER_PATH);
    await env.iframe.contentFrame().getByRole("heading", { name: "Ready canvas", exact: true }).waitFor();
    expect(assets).toBe(1);
    expect(env.documents).toHaveLength(1);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);
