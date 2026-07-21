import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function openCanvas(html: string) {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasHtml(html);
  const page = await browser.newPage();
  const requests: string[] = [];
  const cached = new Set<string>();
  const requestUrls = new Map<string, string>();
  const errors: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  // Block the public CDN without Playwright routing, which disables the
  // browser cache and would invalidate the cache regression below.
  await cdp.send("Network.setBlockedURLs", { urls: ["https://*", "http://cdn.tailwindcss.com/*"] });
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => requestUrls.set(requestId, request.url));
  cdp.on("Network.requestServedFromCache", ({ requestId }) => {
    const url = requestUrls.get(requestId);
    if (url) cached.add(url);
  });
  cdp.on("Network.responseReceived", ({ response }) => {
    if (response.fromDiskCache) cached.add(response.url);
  });
  return {
    fixture, page, requests, cached, errors,
    close: async () => { await page.close(); fixture.stop(); }
  };
}

async function frame(page: Page) {
  await page.locator("iframe").first().waitFor();
  return page.locator("iframe").first().contentFrame();
}

function expectLocalRequests(requests: string[], origin: string) {
  expect(requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin)).toEqual([]);
}

test("Canvas loads local Tailwind on demand and reuses it when opening an artifact", async () => {
  const env = await openCanvas('<div id="probe" class="p-6">Local styles</div>');
  try {
    await env.page.goto(env.fixture.baseUrl + "/projects");
    await env.page.getByText("Worker pane zoom", { exact: true }).first().waitFor();
    expect(env.requests.filter((url) => url.includes("/assets/tailwind-"))).toEqual([]);
    await env.page.goto(env.fixture.baseUrl + WORKER_PATH);
    const content = await frame(env.page);
    await content.locator("#probe").waitFor();
    await env.page.waitForFunction(() => document.querySelector("iframe")!.style.height !== "120px");
    expect(await content.locator("#probe").evaluate((node) => getComputedStyle(node).padding)).toBe("24px");
    await content.locator("#probe").evaluate((node) => node.classList.add("bg-[#123456]"));
    await content.locator("#probe").evaluate((node) => new Promise<void>((resolve) => {
      const check = () => getComputedStyle(node).backgroundColor === "rgb(18, 52, 86)" ? resolve() : requestAnimationFrame(check);
      check();
    }));
    await env.page.getByRole("button", { name: "Artifacts", exact: true }).click();
    await env.page.getByRole("button", { name: "Open canvas: Workspace canvas", exact: true }).click();
    const full = env.page.getByRole("dialog", { name: "Canvas", exact: true }).locator("iframe").contentFrame();
    await full.locator("#probe").waitFor();
    expect(await full.locator("#probe").evaluate((node) => getComputedStyle(node).padding)).toBe("24px");
    expect([...env.cached].some((url) => /\/assets\/tailwind-3\.4\.17-[^/]+\.js$/.test(url))).toBe(true);
    expect(env.requests.some((url) => url.includes("tailwind-3.4.17-plugins"))).toBe(false);
    expectLocalRequests(env.requests, env.fixture.baseUrl);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 20000);

for (const type of ["text/javascript", "module"]) {
  test(`Legacy ${type} CDN tags preserve configuration and CSS overrides offline`, async () => {
    const env = await openCanvas(`<html><head>
      <script type="${type}" src="https://cdn.tailwindcss.com/3.4.17?plugins=typography@0.5.16" crossorigin="anonymous" integrity="sha256-invalid"></script>
      <script type="${type}">tailwind.config = { theme: { extend: { colors: { accent: '#123456' } } } };</script>
      <style type="text/tailwindcss">.custom { @apply p-6; }</style>
      </head><body><div id="probe" class="prose text-accent custom">Local styles</div>
      <input id="input" type="text" style="appearance:auto;padding:7px;border:3px solid #123456" /></body></html>`);
    try {
      await env.page.goto(env.fixture.baseUrl + "/canvas/zoom-canvas/embed");
      const content = await frame(env.page);
      await content.locator("#probe").waitFor();
      expect(await content.locator("#probe").evaluate((node) => {
        const style = getComputedStyle(node);
        return { color: style.color, padding: style.padding, maxWidth: style.maxWidth };
      })).toMatchObject({ color: "rgb(18, 52, 86)", padding: "24px" });
      expect(await content.locator("#probe").evaluate((node) => getComputedStyle(node).maxWidth)).not.toBe("none");
      expect(await content.locator("#input").evaluate((node) => {
        const style = getComputedStyle(node);
        return { appearance: style.appearance, padding: style.padding, borderWidth: style.borderWidth };
      })).toEqual({ appearance: "auto", padding: "7px", borderWidth: "3px" });
      expect(env.requests.filter((url) => url.includes("/assets/tailwind-")).every((url) => !url.includes("?plugins="))).toBe(true);
      expectLocalRequests(env.requests, env.fixture.baseUrl);
      expect(env.errors).toEqual([]);
    } finally { await env.close(); }
  }, 15000);
}

test("The single bundled runtime includes all official plugins by default", async () => {
  const env = await openCanvas(`<html><head></head>
    <body><input id="input" class="form-input" /><div id="prose" class="prose">Text</div>
    <div id="aspect" class="aspect-w-16 aspect-h-9"><div>Media</div></div>
    <div id="container" class="@container">Container</div><div id="clamp" class="line-clamp-2">Text</div></body></html>`);
  try {
    await env.page.goto(env.fixture.baseUrl + "/canvas/zoom-canvas/embed");
    const content = await frame(env.page);
    await content.locator("#input").waitFor();
    expect(await content.locator("#input").evaluate((node) => getComputedStyle(node).appearance)).toBe("none");
    expect(await content.locator("#prose").evaluate((node) => getComputedStyle(node).maxWidth)).not.toBe("none");
    expect(await content.locator("#aspect").evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingBottom))).toBeGreaterThan(0);
    expect(await content.locator("#container").evaluate((node) => getComputedStyle(node).containerType)).toBe("inline-size");
    expect(await content.locator("#clamp").evaluate((node) => getComputedStyle(node).webkitLineClamp)).toBe("2");
    expectLocalRequests(env.requests, env.fixture.baseUrl);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 15000);
