import { expect, test } from "bun:test";
import path from "node:path";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

const browser = browserForFile();

/** The page's window with the marker a test sets to tell a reload from an in-place change. */
type MarkedWindow = Window & { __marker?: number };

const LADDER = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const pct = (zoom: number) => `${Math.round(zoom * 100)}%`;
// The canvas menu holds the zoom, on a desktop as on a phone: it shows the
// current zoom between its - and + items.
const menuZoom = (page: import("playwright").Page, zoom: number | string) =>
  page.locator('[role="menu"] output', { hasText: new RegExp(`^${typeof zoom === "number" ? pct(zoom) : zoom}$`) });
const openCanvasMenu = (page: import("playwright").Page) => page.locator('button[aria-label="Canvas menu"]').click();
/** Opens the canvas menu, waits for it to show this zoom, and shuts it again. */
async function expectMenuZoom(page: import("playwright").Page, zoom: number | string) {
  await openCanvasMenu(page);
  await menuZoom(page, zoom).waitFor();
  await page.keyboard.press("Escape");
  await page.locator('[role="menu"]').waitFor({ state: "detached" });
}

const TOKENS = `
:root { --page: #fbfbf9; --ink: #1f1b16; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --page: #161512; --ink: #ece6dc; color-scheme: dark; } }
:root[data-theme="dark"] { --page: #161512; --ink: #ece6dc; color-scheme: dark; }
body { background: var(--page); color: var(--ink); padding-inline: 16px; }`;

const REPORT = `<title>Cache policy</title>
<style>${TOKENS} section { min-height: 420px; }</style>
<h1 id="top">Shorten the keys</h1>
${Array.from({ length: 8 }, (_, i) => `<section id="s${i + 1}">Section ${i + 1}</section>`).join("")}
<p><a id="out" href="https://github.com/acmecorp/project-1/issues/39">Issue #39</a> <a id="self" target="_self" href="https://github.com/acmecorp/project-1">project-1</a></p>
<p id="cdn">cdn not loaded</p><p id="evil">evil not loaded</p>
<script src="https://cdnjs.cloudflare.com/ajax/libs/fixture/1.0.0/ok.js"></script>
<script src="https://evil.example.com/bad.js"></script>`;

// A table of contents whose links name Chinese headings (their ids arrive
// percent-encoded) and one heading that does not exist.
const ANCHOR_REPORT = `<title>Anchors</title>
<style>${TOKENS} section { min-height: 900px; }</style>
<p><a id="jump" href="#%E7%BB%93%E8%AE%BA">结论</a> <a id="nowhere" href="#missing">Missing</a></p>
<section>Intro</section>
<h2 id="结论">结论</h2><section>End</section>`;

const DESKTOP_REPORT = `<title>JSON dashboard</title>
<meta name="viewport" content="width=1280">
<style>${TOKENS} main { width: 1248px; } .row { display: grid; grid-template-columns: repeat(3, 1fr); } .tile { height: 900px; }</style>
<main><h1 id="dash">The index is smaller in all 16 cases</h1><div class="row"><div class="tile">A</div><div class="tile">B</div><div class="tile">C</div></div></main>`;

const HERO_REPORT = `<title>Hero page</title>
<meta name="viewport" content="width=1280">
<style>${TOKENS} .hero { min-height: 100vh; }</style>
<section class="hero"><h1 id="hero">Hero</h1></section><p>Tail</p>`;

const REFLOW_REPORT = `<title>Long read</title>
<style>${TOKENS} p { font: 16px/1.6 system-ui; }</style>
${Array.from({ length: 40 }, (_, i) => `<p id="p${i + 1}">Paragraph ${i + 1}. ${"Keep the reading position while the page reflows. ".repeat(12)}</p>`).join("")}`;

const OLD_DOCUMENT = '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Old dashboard</title><style>body{background:#0c0e12;color:#e6e9ef}</style></head><body class="old"><h1 id="old">Old dashboard</h1><p id="evil">evil not loaded</p><script src="https://evil.example.com/bad.js"></script></body></html>';

async function openReport(html: string, size: { width: number; height: number }) {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasHtml(html);
  let context: import("playwright").BrowserContext | null = null;
  try {
    context = await browser.newContext({ viewport: size, colorScheme: "light" });
    await context.route("https://cdnjs.cloudflare.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: 'document.getElementById("cdn").textContent = "cdn loaded";' }));
    await context.route("https://evil.example.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: 'document.getElementById("evil").textContent = "evil loaded";' }));
    await context.route("https://github.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>GitHub</title>" }));
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = trackPageErrors(page);
    await page.goto(`${fixture.baseUrl}/canvas/zoom-canvas`);
    const iframe = page.locator("main iframe");
    const frame = iframe.contentFrame();
    // The iframe's parent is the width box; its grandparent is the viewer.
    const viewer = iframe.locator("xpath=../..");
    const scale = () => iframe.evaluate((el) => Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1] ?? "1"));
    const openContext = context;
    return { fixture, context: openContext, page, iframe, frame, viewer, scale, errors, close: async () => { await openContext.close(); fixture.stop(); } };
  } catch (error) {
    // A failed setup must not leave the fixture server or the context behind.
    await context?.close().catch(() => {});
    fixture.stop();
    throw error;
  }
}

/** Resolves once the report's document has loaded: every script has been
 *  fetched and run, or refused. */
const reportLoaded = (frame: import("playwright").FrameLocator) => frame.locator("html").evaluate(() => new Promise<void>((resolve) => {
  if (document.readyState === "complete") resolve();
  else window.addEventListener("load", () => resolve());
}));

test("a report reflows at phone width inside the viewer", async () => {
  const env = await openReport(REPORT, { width: 390, height: 844 });
  try {
    await env.frame.locator("#top").waitFor();
    const widths = await env.frame.locator("html").evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    // And the page is laid out at the viewer's width, drawn at that width:
    // nothing scaled, nothing to pan.
    const [box, viewer] = [(await env.iframe.boundingBox())!, (await env.viewer.boundingBox())!];
    expect(Math.abs(box.width - viewer.width)).toBeLessThanOrEqual(1);
    const layoutWidth = await env.frame.locator("html").evaluate(() => window.innerWidth);
    expect(Math.abs(layoutWidth - viewer.width)).toBeLessThanOrEqual(1);
    expect(await env.frame.locator("html").getAttribute("data-theme")).toBe("light");
    // A phone's zoom is in its canvas menu, and reads 100%.
    await env.page.getByRole("button", { name: "Canvas menu" }).click();
    expect(await env.page.locator('[role="menu"] output').textContent()).toBe("100%");
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 20000);

test("switching the app theme recolours an open report in place", async () => {
  const env = await openReport(REPORT, { width: 1200, height: 800 });
  try {
    await env.frame.locator("#top").waitFor();
    await env.frame.locator("html").evaluate(() => { (window as MarkedWindow).__marker = 1; window.scrollTo(0, 900); });
    await env.page.emulateMedia({ colorScheme: "dark" });
    await env.frame.locator('html[data-theme="dark"]').waitFor({ state: "attached" });
    const state = await env.frame.locator("html").evaluate(() => ({ marker: (window as MarkedWindow).__marker, y: window.scrollY, bg: getComputedStyle(document.body).backgroundColor }));
    expect(state).toEqual({ marker: 1, y: 900, bg: "rgb(22, 21, 18)" });
  } finally { await env.close(); }
}, 20000);

test("the canvas menu, shut by one of its items, opens again when pressed while it fades out", async () => {
  const env = await openReport(DESKTOP_REPORT, { width: 1000, height: 800 });
  try {
    await env.frame.locator("#dash").waitFor();
    await openCanvasMenu(env.page);
    await env.page.getByRole("menuitemradio", { name: "Fit width" }).click();
    await openCanvasMenu(env.page);
    await env.page.waitForFunction(() => {
      const el = document.querySelector('[role="menu"]');
      return el === null || el.getAnimations().length === 0;
    });
    expect(await env.page.locator('[role="menu"]').getAttribute("data-state", { timeout: 1000 }).catch(() => "gone")).toBe("open");
  } finally { await env.close(); }
}, 20000);

test("Desktop site: a declared-width report opens scaled to fit, and the controls change the zoom", async () => {
  const env = await openReport(DESKTOP_REPORT, { width: 1000, height: 800 });
  try {
    await env.frame.locator("#dash").waitFor();
    expect(await env.iframe.evaluate((el) => el.style.width)).toBe("1280px");
    const fit = await env.scale();
    expect(fit).toBeLessThan(1);
    // Fit width: the scaled 1280px page is exactly as wide and as tall as the
    // viewer; the page scrolls itself.
    const box = (await env.iframe.boundingBox())!;
    const viewer = (await env.viewer.boundingBox())!;
    expect(Math.abs(box.width - viewer.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - viewer.height)).toBeLessThanOrEqual(2);
    await openCanvasMenu(env.page);
    await menuZoom(env.page, fit).waitFor();
    await env.page.getByRole("menuitem", { name: "Zoom in" }).click();
    const up = LADDER.find((step) => Math.round(step * 100) > Math.round(fit * 100))!;
    await menuZoom(env.page, up).waitFor();
    expect(await env.scale()).toBeCloseTo(up, 5);
    await env.page.getByRole("menuitemradio", { name: "Fit width" }).click();
    await expectMenuZoom(env.page, fit);
    expect(await env.scale()).toBeCloseTo(fit, 5);
    // Ctrl+scroll over the report: one notch, one step.
    await env.page.mouse.move(box.x + 100, box.y + 100);
    await env.page.keyboard.down("Control");
    await env.page.mouse.wheel(0, -100);
    await env.page.keyboard.up("Control");
    await expectMenuZoom(env.page, up);
    expect(await env.scale()).toBeCloseTo(up, 5);
    // Desktop site off: the page reflows at the viewer's width, at 100%.
    await openCanvasMenu(env.page);
    await env.page.getByRole("menuitemcheckbox", { name: "Desktop site" }).click();
    await expectMenuZoom(env.page, "100%");
    expect(await env.iframe.evaluate((el) => el.style.width)).toBe("100%");
    expect(await env.iframe.evaluate((el) => el.style.transform)).toBe("");
    // And the page really reflows at the viewer's width.
    const viewerBox = (await env.viewer.boundingBox())!;
    expect(Math.abs(await env.frame.locator("html").evaluate(() => window.innerWidth) - viewerBox.width)).toBeLessThanOrEqual(1);
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 30000);

test("zooming keeps the reader's place while the page reflows", async () => {
  const env = await openReport(REFLOW_REPORT, { width: 1200, height: 800 });
  try {
    await env.frame.locator("#p20").waitFor();
    await env.frame.locator("#p20").evaluate((el) => el.scrollIntoView({ block: "center" }));
    const widthBefore = await env.frame.locator("html").evaluate(() => window.innerWidth);
    // Five Ctrl+scroll notches over #p20: 100 → 110 → 125 → 150 → 175 → 200%.
    // Each notch carries the page's scroll, so no frame-timing wait is needed.
    const target = (await env.frame.locator("#p20").boundingBox())!;
    await env.page.mouse.move(target.x + 40, target.y + target.height / 2);
    await env.page.keyboard.down("Control");
    for (const step of [1.1, 1.25, 1.5, 1.75, 2]) {
      await env.page.mouse.wheel(0, -100);
      // The zoom lives in the canvas menu now: wait for the frame's own scale.
      for (let tries = 0; Math.abs((await env.scale()) - step) > 0.005; tries++) {
        if (tries > 150) throw new Error(`the zoom never reached ${pct(step)}`);
        await env.page.waitForTimeout(20);
      }
    }
    await env.page.keyboard.up("Control");
    expect(await env.scale()).toBeCloseTo(2, 5);
    // 200% halves the layout width, so the text above #p20 roughly doubles in
    // height: without the kept place, #p20 would end up far below the view.
    const widthAfter = await env.frame.locator("html").evaluate(() => window.innerWidth);
    expect(Math.abs(widthAfter - widthBefore / 2)).toBeLessThanOrEqual(2);
    await env.page.waitForTimeout(900);
    const place = await env.frame.locator("#p20").evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: window.innerHeight };
    });
    expect(place.bottom).toBeGreaterThan(place.height * 0.25);
    expect(place.top).toBeLessThan(place.height * 0.75);
  } finally { await env.close(); }
}, 20000);

test("a link opens in a new tab and the report stays", async () => {
  const env = await openReport(REPORT, { width: 1200, height: 800 });
  try {
    await env.frame.locator("#out").waitFor();
    // Only allowlisted hosts load: the CDN's script ran, the other host's did not.
    await env.frame.getByText("cdn loaded").waitFor();
    await reportLoaded(env.frame);
    expect(await env.frame.locator("#evil").textContent()).toBe("evil not loaded");
    const [popup] = await Promise.all([env.context.waitForEvent("page"), env.frame.locator("#out").click()]);
    await popup.waitForLoadState();
    expect(popup.url()).toBe("https://github.com/acmecorp/project-1/issues/39");
    expect(env.page.url().endsWith("/canvas/zoom-canvas")).toBe(true);
    // The report is still in its frame, not replaced by the link's target.
    expect(await env.frame.locator("#top").textContent()).toBe("Shorten the keys");
    // A link that names target="_self" leaves in a new tab too.
    const [second] = await Promise.all([env.context.waitForEvent("page"), env.frame.locator("#self").click()]);
    await second.waitForLoadState();
    expect(second.url()).toBe("https://github.com/acmecorp/project-1");
    expect(await env.frame.locator("#top").textContent()).toBe("Shorten the keys");
  } finally { await env.close(); }
}, 20000);

test("an in-page link scrolls inside the report, and one to nothing opens nothing", async () => {
  const env = await openReport(ANCHOR_REPORT, { width: 1000, height: 700 });
  try {
    await env.frame.locator("#jump").waitFor();
    await reportLoaded(env.frame);
    await env.frame.locator("#jump").click();
    // The heading comes to the top of the frame's viewport.
    const headingTop = () => env.frame.locator("h2").evaluate((h) => Math.round(h.getBoundingClientRect().top));
    for (let i = 0; i < 30 && (await headingTop()) !== 0; i++) await env.page.waitForTimeout(100);
    expect(await headingTop()).toBe(0);
    const pages = env.context.pages().length;
    await env.frame.locator("#nowhere").click();
    await env.page.waitForTimeout(500);
    expect(env.context.pages().length).toBe(pages);
    expect(await env.frame.locator("h2").textContent()).toBe("结论");
  } finally { await env.close(); }
}, 20000);

// A complete document is wrapped like any page; the browser folds its shell
// into the skeleton.
test("an old complete-document canvas still renders", async () => {
  const env = await openReport(OLD_DOCUMENT, { width: 1200, height: 800 });
  try {
    await env.frame.locator("#old").waitFor();
    await reportLoaded(env.frame);
    const state = await env.frame.locator("html").evaluate(() => ({
      // The viewer's theme wins over the document's own; its other <html> and
      // <body> attributes and its title carry over.
      theme: document.documentElement.getAttribute("data-theme"),
      lang: document.documentElement.lang,
      bodyClass: document.body.className,
      title: document.title,
      // In the head, where a CSP meta is honoured, and effective: the old
      // document's own disallowed script did not run.
      cspInHead: Boolean(document.head.querySelector('meta[http-equiv="Content-Security-Policy"]')),
      evil: document.getElementById("evil")?.textContent,
      bg: getComputedStyle(document.body).backgroundColor
    }));
    expect(state).toEqual({ theme: "light", lang: "en", bodyClass: "old", title: "Old dashboard", cspInHead: true, evil: "evil not loaded", bg: "rgb(12, 14, 18)" });
  } finally { await env.close(); }
}, 20000);

test("a viewport-height page keeps the viewer's height", async () => {
  const env = await openReport(HERO_REPORT, { width: 1000, height: 800 });
  try {
    await env.frame.locator("#hero").waitFor();
    const read = () => env.frame.locator("html").evaluate(() => ({
      hero: Math.round(document.querySelector(".hero")!.getBoundingClientRect().height),
      viewport: window.innerHeight
    }));
    const first = await read();
    expect(first.hero).toBe(first.viewport);
    const viewer = (await env.viewer.boundingBox())!;
    const box = (await env.iframe.boundingBox())!;
    expect(Math.abs(box.height - viewer.height)).toBeLessThanOrEqual(2);
    await env.page.waitForTimeout(1000);
    expect(await read()).toEqual(first);
    expect(Math.abs((await env.iframe.boundingBox())!.height - viewer.height)).toBeLessThanOrEqual(2);
  } finally { await env.close(); }
}, 20000);

test("from the keyboard, Esc gives focus back to the menu button: out of Delete canvas… (the canvas stays), and out of the canvas's menu or a canvas row's", async () => {
  const env = await openReport(REPORT, { width: 1440, height: 800 });
  try {
    await env.iframe.waitFor();
    await env.page.getByRole("button", { name: "Canvas menu" }).focus();
    await env.page.keyboard.press("Enter");
    await env.page.getByRole("menu").waitFor();
    // Opened from the keyboard, the menu hands its first item focus once it is up.
    await env.page.waitForFunction(() => document.activeElement?.getAttribute("role")?.startsWith("menuitem") === true);
    // Delete is the menu's last item; Radix moves focus for End in a timeout.
    await env.page.keyboard.press("End");
    await env.page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Delete canvas…");
    await env.page.keyboard.press("Enter");
    const question = env.page.getByRole("dialog", { name: 'Delete canvas "Workspace canvas"?' });
    await question.waitFor();
    await env.page.keyboard.press("Escape");
    await question.waitFor({ state: "detached" });
    // Radix hands focus back once the dialog has gone, in a timeout.
    await env.page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Canvas menu");
    expect(await env.iframe.isVisible()).toBe(true);

    // A menu opened from the keyboard and closed with Esc gives focus back to its button.
    const escapeFrom = async (button: import("playwright").Locator, label: string) => {
      await button.focus();
      await env.page.keyboard.press("Enter");
      await env.page.getByRole("menu").waitFor();
      await env.page.keyboard.press("Escape");
      await env.page.getByRole("menu").waitFor({ state: "detached" });
      await env.page.waitForFunction((name) => document.activeElement?.getAttribute("aria-label") === name, label);
    };
    await escapeFrom(env.page.getByRole("button", { name: "Canvas menu" }), "Canvas menu");
    await env.page.goto(`${env.fixture.baseUrl}${WORKER_PATH}?tab=reports`);
    const row = env.page.getByRole("button", { name: "Canvas actions: Workspace canvas" });
    await row.waitFor();
    await escapeFrom(row, "Canvas actions: Workspace canvas");
    expect(env.errors).toEqual([]);
  } finally { await env.close(); }
}, 20000);

test("the canvas's title, its menu and Close are one header row that fits, at every width, and its id is never shown", async () => {
  // A phone; a wide phone layout (a tablet, a narrow window); a desktop
  // window whose pane header is under 40rem; a wide one. The project /
  // feature line shows wherever the header has 30rem for it.
  for (const [width, context] of [[390, false], [700, true], [820, true], [1440, true]] as const) {
    const env = await openReport(REPORT, { width, height: 800 });
    try {
      await env.iframe.waitFor();
      const header = env.page.locator('header:has(button[aria-label="Close canvas"])');
      // One title, in the app's header: no second title row under it.
      expect(await env.page.locator("h1").count()).toBe(1);
      expect(await header.locator("h1").textContent()).toBe("Workspace canvas");
      expect(await header.textContent()).not.toContain("zoom-canvas");
      expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const close = (await header.getByRole("button", { name: "Close canvas" }).boundingBox())!;
      expect(close.x + close.width).toBeLessThanOrEqual(width);
      expect(await header.getByText("Zoom project / zoom-worker").isVisible()).toBe(context);
      // Close, and everything else in one menu, on a phone and a desktop alike.
      expect(await header.getByRole("button", { name: "Canvas menu" }).isVisible()).toBe(true);
      expect(await header.locator('button[aria-label^="Zoom, "], [role="switch"]').count()).toBe(0);
      await env.page.screenshot({ path: path.join(artifactDir("canvas-header"), `${width}.png`) });
      expect(env.errors).toEqual([]);
    } finally { await env.close(); }
  }
}, 30000);
