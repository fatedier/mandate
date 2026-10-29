import { expect, test } from "bun:test";
import type { BrowserContext, FrameLocator, Locator, Page, Route } from "playwright";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// A report scrolls inside its own frame, so its scrollbar is the frame's. The
// frame starts every page on the light colour scheme, and a dark page that
// never says it is dark kept the browser's light scrollbar: a white track
// down the side of a dark page. The viewer draws a report's scrollbars
// itself now: thin, the thumb a grey that reads on either ground (as faint
// as the app's own thumb), the track
// the page's own ground. (A clear track is not that: it shows the viewer
// behind the frame, a light strip beside a dark page in a light app.) How
// wide a scrollbar is and what it is drawn in are the browser's, which
// happy-dom is not. Classic scrollbars here, as on a desktop set to always
// show them.

const browser = browserForFile({ ignoreDefaultArgs: ["--hide-scrollbars"] });

type Rgb = [number, number, number];
const FILL = Array.from({ length: 60 }, (_, i) => `<p>Line ${i + 1}</p>`).join("");
// A box that scrolls inside the page, and one that keeps the system's bar to
// measure against.
const BOXES = '<div id="inner" style="overflow:scroll;width:240px;height:90px"><div style="width:600px;height:300px"></div></div>' +
  '<div id="system" style="overflow:scroll;width:240px;height:90px;scrollbar-width:auto"><div style="height:300px"></div></div>';
const page = (title: string, ground: string, ink: string, more = "") =>
  `<title>${title}</title><style>body{background:${ground};color:${ink};font:16px/1.6 system-ui}p{margin:0;height:120px;width:200px}${more}</style>${BOXES}${FILL}`;
// A page from before the contract: dark, and silent about its colour scheme.
const OLD_DARK = page("Old dark page", "#101214", "#e6e9ef");
const LIGHT = page("Light page", "#ffffff", "#16181c");
const OWN_RULE = "html{scrollbar-color:rgb(200,30,30) rgb(20,20,160);scrollbar-width:auto}";
const OWN = page("Own scrollbars", "#101214", "#e6e9ef", OWN_RULE);
// The same from a page that keeps its styles in a cascade layer, where any
// rule outside a layer would beat them.
const OWN_LAYERED = page("Own scrollbars, layered", "#101214", "#e6e9ef", `@layer page{${OWN_RULE}}`);
// One that follows the viewer's theme, as the contract asks.
const THEMED = `<title>Themed</title><style>:root{--page:#fbfbf9;--ink:#1f1b16}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--page:#161512;--ink:#ece6dc;color-scheme:dark}}
:root[data-theme="dark"]{--page:#161512;--ink:#ece6dc;color-scheme:dark}
body{background:var(--page);color:var(--ink)}p{margin:0;height:120px;width:200px}</style>${BOXES}${FILL}`;
// One whose ground arrives after the viewer's script has run: set by the
// page's own script once the document is parsed.
const LATE = `${page("Late ground", "#ffffff", "#16181c")}<script>document.addEventListener("DOMContentLoaded", () => { document.body.style.background = "#203040"; });</script>`;
// One still loading: a script the page waits for.
const SLOW_SCRIPT = "https://cdnjs.cloudflare.com/ajax/libs/fixture/1.0.0/slow.js";
const LOADING = `${OLD_DARK}<script async src="${SLOW_SCRIPT}"></script>`;
// The root's ground is the one behind the page; the body's covers its own box.
const ROOT_GROUND = page("Root ground", "#405060", "#e6e9ef", "html{background:#102030}body{max-width:600px;margin:0 auto}");
// No one colour to take.
const GRADIENT = `<title>Gradient</title><style>body{background:linear-gradient(#101214,#1a1d21);color:#e6e9ef}p{margin:0;height:120px;width:200px}</style>${BOXES}${FILL}`;

/** The app's own ground in each theme: what shows through a clear track. */
const APP = { dark: [20, 20, 22], light: [255, 255, 255] } as const;

async function openReport(html: string, app: "dark" | "light" = "dark", prepare?: (context: BrowserContext) => Promise<unknown>) {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasHtml(html);
  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: app });
    await prepare?.(context);
    const tab = await context.newPage();
    tab.setDefaultTimeout(8000);
    const errors = trackPageErrors(tab);
    await tab.goto(`${fixture.baseUrl}/canvas/zoom-canvas`);
    const iframe = tab.locator("main iframe");
    const frame = iframe.contentFrame();
    await frame.locator("#inner").waitFor();
    // Away from the bar: a pointer over it changes its shade.
    await tab.mouse.move(40, 400);
    await tab.waitForTimeout(300);
    const opened = context;
    return { tab, iframe, frame, errors, context: opened, close: async () => { await opened.close(); fixture.stop(); } };
  } catch (error) {
    await context?.close().catch(() => {});
    fixture.stop();
    throw error;
  }
}

/** The page's scrollbars as the frame computes and lays them out. */
const bars = (frame: FrameLocator) => frame.locator("html").evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const inner = document.getElementById("inner")!;
  const system = document.getElementById("system")!;
  return {
    scrolls: document.documentElement.scrollHeight > window.innerHeight * 4,
    color: root.scrollbarColor,
    width: root.scrollbarWidth,
    innerColor: getComputedStyle(inner).scrollbarColor,
    innerWidth: getComputedStyle(inner).scrollbarWidth,
    px: { page: window.innerWidth - document.documentElement.clientWidth, inner: inner.offsetWidth - inner.clientWidth, system: system.offsetWidth - system.clientWidth }
  };
});

/** Colours of the screen at these points, read by the browser from a picture of it. */
async function colours(context: BrowserContext, tab: Page, points: Array<[number, number]>): Promise<Rgb[]> {
  const png = (await tab.screenshot()).toString("base64");
  const reader = await context.newPage();
  try {
    return await reader.evaluate(async ({ png, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const pen = canvas.getContext("2d")!;
      pen.drawImage(image, 0, 0);
      return points.map(([x, y]) => [...pen.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3) as [number, number, number]);
    }, { png, points });
  } finally {
    await reader.close();
  }
}

/** The page bar's track and thumb, and the page's ground beside it. The page
 *  is at its top, so the thumb is at the bar's top and the rest is track. */
async function drawn(env: { context: BrowserContext; tab: Page; iframe: Locator; frame: FrameLocator }) {
  const box = (await env.iframe.boundingBox())!;
  const { bar, thumb } = await env.frame.locator("html").evaluate(() => ({
    bar: window.innerWidth - document.documentElement.clientWidth,
    thumb: window.innerHeight * window.innerHeight / document.documentElement.scrollHeight
  }));
  const x = box.x + box.width - bar / 2;
  const [track, thumbAt, ground] = await colours(env.context, env.tab, [
    [x, box.y + box.height * 0.7], [x, box.y + thumb / 2], [box.x + box.width - bar - 6, box.y + box.height * 0.7]
  ]);
  return { track, thumb: thumbAt, ground };
}

/** `colour` laid over `ground` at 14%, as the viewer's thumb is. */
const over = (ground: Rgb): Rgb => ground.map((c) => Math.round(c + (128 - c) * 0.14)) as Rgb;
const near = (a: Rgb, b: Rgb) => a.every((c, i) => Math.abs(c - b[i]!) <= 2);

for (const app of ["dark", "light"] as const) {
  test(`in a ${app} app, a dark page that says nothing of its colour scheme has no light scrollbar: the bar is thin, its track the page's ground`, async () => {
    const env = await openReport(OLD_DARK, app);
    try {
      const measured = await bars(env.frame);
      expect({ ...measured, px: null }).toEqual({
        scrolls: true, color: "rgba(128, 128, 128, 0.14) rgb(16, 18, 20)", width: "thin",
        // A box inside the page is drawn the same way.
        innerColor: "rgba(128, 128, 128, 0.14) rgb(16, 18, 20)", innerWidth: "thin", px: null
      });
      // Thinner than the system's, and still there.
      expect([measured.px.page > 0, measured.px.page < measured.px.system, measured.px.inner === measured.px.page]).toEqual([true, true, true]);

      const { track, thumb, ground } = await drawn(env);
      // The page's own ground, whatever the app's is.
      expect([ground, track]).toEqual([[16, 18, 20], [16, 18, 20]]);
      expect(track).not.toEqual([...APP[app]]);
      expect([thumb, near(thumb, over([16, 18, 20]))]).toEqual([thumb, true]);
      expect(env.errors).toEqual([]);
    } finally {
      await env.close();
    }
  }, 60000);
}

test("the same bar on a light page in a dark app: the track is the page's white, and the thumb reads on it", async () => {
  const env = await openReport(LIGHT);
  try {
    expect((await bars(env.frame)).width).toBe("thin");
    const { track, thumb, ground } = await drawn(env);
    expect([ground, track]).toEqual([[255, 255, 255], [255, 255, 255]]);
    expect([thumb, near(thumb, over([255, 255, 255]))]).toEqual([thumb, true]);
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 60000);

test("the track follows a page that changes with the viewer's theme", async () => {
  const env = await openReport(THEMED);
  try {
    expect((await drawn(env)).track).toEqual([22, 21, 18]);
    await env.tab.emulateMedia({ colorScheme: "light" });
    await env.frame.locator('html[data-theme="light"]').waitFor();
    await env.tab.waitForTimeout(300);
    const { track, ground } = await drawn(env);
    expect([ground, track]).toEqual([[251, 251, 249], [251, 251, 249]]);
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 60000);

test("the track is the page's ground while the page is still loading", async () => {
  let held: Route | null = null;
  const env = await openReport(LOADING, "light", (context) => context.route(SLOW_SCRIPT, (route) => { held = route; }));
  try {
    expect(await env.frame.locator("html").evaluate(() => document.readyState)).toBe("interactive");
    expect((await drawn(env)).track).toEqual([16, 18, 20]);
    await held!.fulfill({ contentType: "text/javascript", body: "" });
    await env.frame.locator("html").evaluate(() => new Promise<void>((resolve) => {
      if (document.readyState === "complete") resolve();
      else window.addEventListener("load", () => resolve());
    }));
    expect((await drawn(env)).track).toEqual([16, 18, 20]);
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 60000);

test("a ground the page sets late, the root's ground over the body's, and a ground of no one colour", async () => {
  const late = await openReport(LATE);
  try {
    expect((await drawn(late)).track).toEqual([32, 48, 64]);
    expect(late.errors).toEqual([]);
  } finally {
    await late.close();
  }
  const root = await openReport(ROOT_GROUND);
  try {
    // Behind the page is the root's colour, and so beside it.
    const { track, ground } = await drawn(root);
    expect([ground, track]).toEqual([[16, 32, 48], [16, 32, 48]]);
    expect(root.errors).toEqual([]);
  } finally {
    await root.close();
  }
  const gradient = await openReport(GRADIENT);
  try {
    // Nothing to take: the track stays clear, and the app shows through.
    expect((await bars(gradient.frame)).color).toBe("rgba(128, 128, 128, 0.14) rgba(0, 0, 0, 0)");
    expect((await drawn(gradient)).track).toEqual([...APP.dark]);
    expect(gradient.errors).toEqual([]);
  } finally {
    await gradient.close();
  }
}, 60000);

for (const [how, html] of [["on html, a selector weaker than the viewer's", OWN], ["inside a cascade layer", OWN_LAYERED]] as const) {
  test(`a page that styles its own scrollbar keeps it: ${how}`, async () => {
    const env = await openReport(html);
    try {
      const measured = await bars(env.frame);
      expect({ color: measured.color, width: measured.width, systemWide: measured.px.page === measured.px.system }).toEqual({
        color: "rgb(200, 30, 30) rgb(20, 20, 160)", width: "auto", systemWide: true
      });
      const { track } = await drawn(env);
      expect(track).toEqual([20, 20, 160]);
      expect(env.errors).toEqual([]);
    } finally {
      await env.close();
    }
  }, 60000);
}
