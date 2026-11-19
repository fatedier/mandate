import { afterEach, expect, jest, test } from "bun:test";
import { act, Activity } from "react";
import { AgentPageFrame, AGENT_PAGE_ID, PAGE_HOLD_MAX_MS } from "@/routes/personal/page/AgentPageFrame";
import { PageShownContext } from "@/lib/page-shown";
import { AGENT_PAGE_BUILTINS, type AgentPageDataDto } from "@shared/api/agent-page";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { useUIStore } from "@/store/ui";
import { mountAsync, type Mounted } from "../helpers/mount.js";
import { fakeClock } from "../helpers/fake-clock.js";

let mounted: Mounted | null = null;
afterEach(() => { runCleanups(); mounted = null; });

const DATA: Record<string, AgentPageDataDto> = {
  threads: { name: "threads", value: [{ id: "thr_1" }], at: "2026-10-20T10:00:00.000Z", error: null }
};

interface Calls { subscribed: string[]; unsubscribed: string[]; submitted: unknown[]; opened: string[]; went: string[]; fields: Array<Record<string, string>>; focus: boolean[]; quotes: string[]; quotable: boolean[]; quoteEnds: number }

const SITE = { "index.html": "<h1>Today</h1>", "orders/list.html": "<h1>Orders</h1>" };

async function render(over: { held?: Record<string, string>; data?: (name: string) => AgentPageDataDto | null; submit?: (value: unknown) => Promise<{ ok: boolean; error?: string }>; path?: string } = {}) {
  const calls: Calls = { subscribed: [], unsubscribed: [], submitted: [], opened: [], went: [], fields: [], focus: [], quotes: [], quotable: [], quoteEnds: 0 };
  const props = {
    version: { revision: 3, pages: SITE as Record<string, string> },
    path: over.path ?? "index.html",
    onGo: (path: string) => { calls.went.push(path); },
    held: over.held ?? {},
    onFields: (values: Record<string, string>) => { calls.fields.push(values); },
    onFocus: (inField: boolean) => { calls.focus.push(inField); },
    data: over.data ?? ((name: string) => DATA[name] ?? null),
    subscribe: (name: string) => { calls.subscribed.push(name); },
    unsubscribe: (name: string) => { calls.unsubscribed.push(name); },
    submit: over.submit ?? (async (value: unknown) => { calls.submitted.push(value); return { ok: true }; }),
    open: (path: string) => { calls.opened.push(path); },
    quoting: false,
    onQuotable: (any: boolean) => { calls.quotable.push(any); },
    onQuote: (text: string) => { calls.quotes.push(text); },
    onQuoteEnd: () => { calls.quoteEnds += 1; }
  };
  mounted = await mountAsync(<Activity mode="visible"><PageShownContext.Provider value={true}><AgentPageFrame {...props} /></PageShownContext.Provider></Activity>);
  const frame = mounted.host.querySelector("iframe")!;
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  const fromFrame = (data: Record<string, unknown>) => act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { ...data, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  // As in a page kept while another shows (shell/KeptPage).
  const shown = (mode: "visible" | "hidden", over: Partial<typeof props> = {}) => act(async () => {
    mounted!.rerender(<Activity mode={mode}><PageShownContext.Provider value={mode === "visible"}><AgentPageFrame {...props} {...over} /></PageShownContext.Provider></Activity>);
  });
  return { frame, posted, calls, fromFrame, props, shown };
}

test("the page's frame carries window.mandate before the page's scripts", async () => {
  const { frame } = await render();
  const srcdoc = frame.getAttribute("srcdoc")!;
  expect(srcdoc.indexOf("data-mandate-page")).toBeGreaterThan(srcdoc.indexOf("data-mandate-runtime"));
  expect(srcdoc.indexOf("data-mandate-page")).toBeLessThan(srcdoc.indexOf("</head>"));
  expect(srcdoc).toContain("<h1>Today</h1>");
  // What it loads by relative path comes from its version's folder.
  expect(srcdoc).toContain('<base href="http://localhost/api/agent-page/files/3/"');
});

test("a page in a folder resolves its links from there; the whole folder may load", async () => {
  const { frame } = await render({ path: "orders/list.html" });
  const srcdoc = frame.getAttribute("srcdoc")!;
  expect(srcdoc).toContain("<h1>Orders</h1>");
  expect(srcdoc).not.toContain("<h1>Today</h1>");
  expect(srcdoc).toContain('<base href="http://localhost/api/agent-page/files/3/orders/"');
  // A stylesheet one folder up is the folder's too.
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(srcdoc)![1]!;
  expect(csp.split("; ").find((rule) => rule.startsWith("style-src"))!.split(" ").at(-1)).toBe("http://localhost/api/agent-page/files/3/");
});

test("a page the version does not have shows its first page", async () => {
  const { frame } = await render({ path: "gone.html" });
  expect(frame.getAttribute("srcdoc")).toContain("<h1>Today</h1>");
});

test("going to another page of the version is passed on; anything else is not", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.go", path: "orders/list.html" });
  await t.fromFrame({ type: "mandate.page.go", path: "style.css" });
  await t.fromFrame({ type: "mandate.page.go", path: "nope.html" });
  expect(t.calls.went).toEqual(["orders/list.html"]);
});

const frames = () => [...mounted!.host.querySelectorAll("iframe")];
const inSight = (frame: HTMLIFrameElement) => frame.closest("[data-page-frame]")!.hasAttribute("data-in-sight");
/** What the host posts to this frame. */
function caught(frame: HTMLIFrameElement) {
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  return posted;
}
const fromFrameOf = (frame: HTMLIFrameElement, data: Record<string, unknown>) => act(async () => {
  window.dispatchEvent(new window.MessageEvent("message", { data: { ...data, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
});
const loaded = (frame: HTMLIFrameElement) => act(async () => { frame.dispatchEvent(new window.Event("load")); });

test("another page of the version is drawn under the one in sight, which stays until it has drawn", async () => {
  const t = await render();
  const first = t.frame;
  await t.shown("visible", { path: "orders/list.html" });
  const [before, next] = frames();
  // The page in sight is the same frame, not loaded again, and takes no input.
  expect(before === first).toBe(true);
  expect([inSight(first), first.closest("[data-page-frame]")!.hasAttribute("inert")]).toEqual([true, true]);
  expect(next!.getAttribute("srcdoc")).toContain("<h1>Orders</h1>");
  expect(inSight(next!)).toBe(false);
  const posted = caught(next!);
  await loaded(next!);
  // Loaded with nothing it asked for still to come: once given back what
  // was typed, it is asked to say once it has drawn.
  const types = posted.map((m) => m.type);
  expect(types.filter((type) => type === "mandate.page.whenDrawn").length).toBe(1);
  expect(types.indexOf("mandate.page.whenDrawn")).toBeGreaterThan(types.indexOf("mandate.page.restore"));
  expect(frames().length).toBe(2);
  await fromFrameOf(next!, { type: "mandate.page.drawn" });
  // Compared by identity: a deep compare of two elements walks the whole document.
  expect(frames().length === 1 && frames()[0] === next).toBe(true);
  expect(inSight(next!)).toBe(true);
});

test("the next page is asked to say it has drawn once its document is read, not only when its pictures have loaded", async () => {
  const t = await render({ held: { who: "ops" } });
  await t.shown("visible", { path: "orders/list.html" });
  const next = frames()[1]!;
  const posted = caught(next);
  await fromFrameOf(next, { type: "mandate.page.subscribe", name: "threads" });
  await fromFrameOf(next, { type: "mandate.page.ready" });
  expect(posted.map((m) => m.type)).toEqual(["mandate.page.data", "mandate.page.preview", "mandate.page.whenDrawn"]);
  // Drawn before its load: in sight now.
  await fromFrameOf(next, { type: "mandate.page.drawn" });
  expect(frames().length === 1 && frames()[0] === next).toBe(true);
});

test("the next page is asked as soon as its document is read, with data still to come: it judges that itself", async () => {
  const t = await render({ data: (name) => (name === "prom" ? null : DATA[name] ?? null) });
  await t.shown("visible", { path: "orders/list.html" });
  const next = frames()[1]!;
  const posted = caught(next);
  await fromFrameOf(next, { type: "mandate.page.subscribe", name: "prom" });
  await fromFrameOf(next, { type: "mandate.page.get", name: "prom", reqId: 1 });
  await fromFrameOf(next, { type: "mandate.page.ready" });
  expect(posted.at(-1)).toEqual({ type: "mandate.page.whenDrawn" });
  expect(frames().length).toBe(2);
  // What it says when it has its data and has painted (page-bridge).
  await fromFrameOf(next, { type: "mandate.page.drawn" });
  expect(frames().length === 1 && frames()[0] === next).toBe(true);
});

test("what the page in sight follows is let go of only once the next page is in sight: the next gets the data at once", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.subscribe", name: "threads" });
  await t.shown("visible", { path: "orders/list.html" });
  const next = frames()[1]!;
  const posted = caught(next);
  await fromFrameOf(next, { type: "mandate.page.subscribe", name: "threads" });
  expect(posted[0]).toEqual({ type: "mandate.page.data", name: "threads", data: { value: [{ id: "thr_1" }], at: "2026-10-20T10:00:00.000Z", error: null } });
  expect(t.calls.unsubscribed).toEqual([]);
  await loaded(next);
  await fromFrameOf(next, { type: "mandate.page.drawn" });
  expect([t.calls.subscribed, t.calls.unsubscribed]).toEqual([["threads", "threads"], ["threads"]]);
});

test("the page in sight says nothing more once another is coming", async () => {
  const t = await render();
  await t.shown("visible", { path: "orders/list.html" });
  await t.fromFrame({ type: "mandate.page.fields", values: { who: "ops" } });
  await t.fromFrame({ type: "mandate.page.go", path: "index.html" });
  await t.fromFrame({ type: "mandate.page.quotable", any: true });
  expect([t.calls.fields, t.calls.went, t.calls.quotable]).toEqual([[], [], []]);
});

test("back to the page in sight before the next has drawn: it stays, the next goes", async () => {
  const t = await render();
  await t.shown("visible", { path: "orders/list.html" });
  await t.shown("visible", { path: "index.html" });
  expect(frames().length === 1 && frames()[0] === t.frame).toBe(true);
  expect([inSight(t.frame), t.frame.closest("[data-page-frame]")!.hasAttribute("inert")]).toEqual([true, false]);
  await t.fromFrame({ type: "mandate.page.go", path: "orders/list.html" });
  expect(t.calls.went).toEqual(["orders/list.html"]);
});

test("the page in sight goes after a while when the next never says it has drawn", async () => {
  const t = await render();
  // The fake clock from here: the mount waits on the real one.
  fakeClock();
  await t.shown("visible", { path: "orders/list.html" });
  await act(async () => { jest.advanceTimersByTime(PAGE_HOLD_MAX_MS - 1); });
  expect(frames().length).toBe(2);
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(frames().length).toBe(1);
  expect(frames()[0]!.getAttribute("srcdoc")).toContain("<h1>Orders</h1>");
});

test("a get is answered from data, and one for data not loaded yet when it comes", async () => {
  let prom: AgentPageDataDto | null = null;
  const t = await render({ data: (name) => (name === "prom" ? prom : DATA[name] ?? null) });
  await t.fromFrame({ type: "mandate.page.get", name: "threads", reqId: 1 });
  expect(t.posted).toStrictEqual([{ type: "mandate.page.result", reqId: 1, ok: true, data: { value: [{ id: "thr_1" }], at: "2026-10-20T10:00:00.000Z", error: null } }]);
  await t.fromFrame({ type: "mandate.page.get", name: "prom", reqId: 2 });
  expect([t.posted.length, t.calls.subscribed]).toEqual([1, ["prom"]]);
  prom = { name: "prom", value: 3, at: null, error: null };
  // The store's update re-renders the frame's owner.
  mounted!.rerender(<Activity mode="visible"><PageShownContext.Provider value={true}><AgentPageFrame {...t.props} data={(name) => (name === "prom" ? prom : null)} /></PageShownContext.Provider></Activity>);
  await act(async () => {});
  expect(t.posted.at(-1)).toEqual({ type: "mandate.page.result", reqId: 2, ok: true, data: { value: 3, at: null, error: null } });
});

test("a followed source's data is sent when it subscribes and each time it changes", async () => {
  let threads: AgentPageDataDto = DATA.threads!;
  const t = await render({ data: (name) => (name === "threads" ? threads : null) });
  await t.fromFrame({ type: "mandate.page.subscribe", name: "threads" });
  expect(t.posted).toStrictEqual([{ type: "mandate.page.data", name: "threads", data: { value: [{ id: "thr_1" }], at: "2026-10-20T10:00:00.000Z", error: null } }]);
  threads = { ...threads, value: [] };
  mounted!.rerender(<Activity mode="visible"><PageShownContext.Provider value={true}><AgentPageFrame {...t.props} data={(name) => (name === "threads" ? threads : null)} /></PageShownContext.Provider></Activity>);
  await act(async () => {});
  expect(t.posted.at(-1)).toEqual({ type: "mandate.page.data", name: "threads", data: { value: [], at: "2026-10-20T10:00:00.000Z", error: null } });
  expect(t.posted.length).toBe(2);
  // A render with the same data sends nothing again.
  mounted!.rerender(<Activity mode="visible"><PageShownContext.Provider value={true}><AgentPageFrame {...t.props} held={{ other: "x" }} data={(name) => (name === "threads" ? threads : null)} /></PageShownContext.Provider></Activity>);
  await act(async () => {});
  expect(t.posted.length).toBe(2);
});

test("a submit calls submit and posts its result; a refused one never reaches it", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.submit", value: { pick: "c" }, reqId: 4 });
  expect(t.calls.submitted).toStrictEqual([{ pick: "c" }]);
  expect(t.posted).toStrictEqual([{ type: "mandate.page.result", reqId: 4, ok: true }]);
  await t.fromFrame({ type: "mandate.page.submit", value: "x".repeat(10_000), reqId: 5 });
  expect(t.calls.submitted.length).toBe(1);
  expect(t.posted.at(-1)).toEqual({ type: "mandate.page.result", reqId: 5, ok: false, error: "an answer is at most 8 KB of JSON" });
  const failing = await render({ submit: async () => ({ ok: false, error: "the answer is not JSON" }) });
  await failing.fromFrame({ type: "mandate.page.submit", value: 1, reqId: 6 });
  expect(failing.posted).toStrictEqual([{ type: "mandate.page.result", reqId: 6, ok: false, error: "the answer is not JSON" }]);
});

test("open navigates to Mandate's pages only; fields and focus reach the owner", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.open", path: "/threads/thr_1?worker=wkr_2" });
  await t.fromFrame({ type: "mandate.page.open", path: "https://evil.example" });
  expect(t.calls.opened).toStrictEqual(["/threads/thr_1?worker=wkr_2"]);
  await t.fromFrame({ type: "mandate.page.fields", values: { who: "ops" } });
  await t.fromFrame({ type: "mandate.page.focus", inField: true });
  expect([t.calls.fields, t.calls.focus]).toEqual([[{ who: "ops" }], [true]]);
});

test("on load, data not yet sent goes first, then the held fields; data the page has is not sent again", async () => {
  let prom: AgentPageDataDto | null = null;
  const t = await render({ held: { who: "ops-readonly" }, data: (name) => (name === "prom" ? prom : DATA[name] ?? null) });
  await t.fromFrame({ type: "mandate.page.subscribe", name: "threads" });
  await t.fromFrame({ type: "mandate.page.subscribe", name: "prom" });
  expect(t.posted.map((m) => m.type)).toStrictEqual(["mandate.page.data"]);
  t.posted.length = 0;
  // The data arrives in the same moment as the load, with no render between.
  prom = { name: "prom", value: 1, at: null, error: null };
  await act(async () => { t.frame.dispatchEvent(new window.Event("load")); });
  const page = t.posted.filter((m) => String(m.type).startsWith("mandate.page."));
  // The colors of now first: the page may have been built with another theme's.
  expect(page.map((m) => [m.type, (m as { name?: string }).name ?? null])).toStrictEqual([["mandate.page.style", null], ["mandate.page.data", "prom"], ["mandate.page.restore", null]]);
  expect(page.at(-1)).toEqual({ type: "mandate.page.restore", values: { who: "ops-readonly" } });
});

test("once the page's document is read, the held fields go to it to be shown, before its load", async () => {
  const t = await render({ held: { who: "ops-readonly" } });
  await t.fromFrame({ type: "mandate.page.subscribe", name: "threads" });
  t.posted.length = 0;
  await t.fromFrame({ type: "mandate.page.ready" });
  // To be shown only: the load's restore, after the data, still settles them.
  expect(t.posted.filter((m) => String(m.type).startsWith("mandate.page."))).toStrictEqual([{ type: "mandate.page.preview", values: { who: "ops-readonly" } }]);
});

test("a page that reloads itself and subscribes again gets the data again", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.subscribe", name: "threads" });
  await t.fromFrame({ type: "mandate.page.subscribe", name: "threads" });
  expect(t.posted.map((m) => m.type)).toStrictEqual(["mandate.page.data", "mandate.page.data"]);
});

test("a message that breaks the host's check is refused, never left hanging", async () => {
  const t = await render();
  const breaking = { pageId: AGENT_PAGE_ID, reqId: 9, get type(): string { throw new Error("broken"); } };
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: breaking, source: t.frame.contentWindow as Window }));
  });
  expect(t.posted).toStrictEqual([{ type: "mandate.page.result", reqId: 9, ok: false, error: "not a message the host takes" }]);
});

test("a new version is a new frame", async () => {
  const t = await render();
  const first = t.frame;
  mounted!.rerender(<Activity mode="visible"><PageShownContext.Provider value={true}><AgentPageFrame {...t.props} version={{ revision: 4, pages: { "index.html": "<h1>Later</h1>" } }} /></PageShownContext.Provider></Activity>);
  await act(async () => {});
  // At once, as it always came: no page is held over it.
  expect(frames().length).toBe(1);
  const next = mounted!.host.querySelector("iframe")!;
  expect(next === first).toBe(false);
  expect(next.getAttribute("srcdoc")).toContain("<h1>Later</h1>");
});

test("Esc in the focused page reaches the page pane, as it does a worker's", async () => {
  const keysIn = async (paneMode: string | null) => {
    const props = {
      version: { revision: 1, pages: { "index.html": "<input>" } }, path: "index.html", onGo: () => {}, held: {}, onFields: () => {}, onFocus: () => {},
      data: () => null, subscribe: () => {}, unsubscribe: () => {}, submit: async () => ({ ok: true }), open: () => {}
    };
    const m = await mountAsync(<div {...(paneMode ? { "data-pane-mode": paneMode } : {})}><AgentPageFrame {...props} /></div>);
    const frame = m.host.querySelector("iframe")!;
    const keys: string[] = [];
    m.host.addEventListener("keydown", (event) => { keys.push((event as KeyboardEvent).key); });
    frame.focus();
    await act(async () => {
      window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.canvas.key", canvasId: AGENT_PAGE_ID, key: "Escape" }, source: frame.contentWindow as Window }));
    });
    m.unmount();
    return keys;
  };
  expect(await keysIn("page")).toEqual(["Escape"]);
  expect(await keysIn(null)).toEqual([]);
});

test("a page cannot make the host hold more than its limits: gets waiting, sources followed", async () => {
  const t = await render({ data: () => null });
  for (let reqId = 1; reqId <= 101; reqId += 1) await t.fromFrame({ type: "mandate.page.get", name: "missing", reqId });
  expect(t.posted).toStrictEqual([{ type: "mandate.page.result", reqId: 101, ok: false, error: "too many requests waiting" }]);
  const many = await render({ data: () => null });
  for (let i = 0; i < 40; i += 1) await many.fromFrame({ type: "mandate.page.subscribe", name: `source_${i}` });
  // Every built-in and twenty sources of its own.
  expect(many.calls.subscribed.length).toBe(AGENT_PAGE_BUILTINS.length + 20);
  await many.fromFrame({ type: "mandate.page.get", name: "source_39", reqId: 1 });
  expect(many.posted).toStrictEqual([{ type: "mandate.page.result", reqId: 1, ok: false, error: "too many sources followed" }]);
});

test("hidden in a kept page it lets go of what it followed, and shown again follows it again", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.subscribe", name: "threads" });
  await t.fromFrame({ type: "mandate.page.subscribe", name: "prom" });
  await t.shown("hidden");
  expect(t.calls.unsubscribed.sort()).toStrictEqual(["prom", "threads"]);
  t.calls.subscribed.length = 0;
  await t.shown("visible");
  // The same frame: the page does not subscribe again itself.
  expect(t.calls.subscribed.sort()).toStrictEqual(["prom", "threads"]);
});

test("a new version that comes while its page is hidden waits to be shown, so its frame starts with someone listening", async () => {
  const t = await render();
  await t.shown("visible");
  await t.shown("hidden");
  await t.shown("hidden", { version: { revision: 4, pages: { "index.html": "<h1>Later</h1>" } } });
  expect(mounted!.host.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<h1>Today</h1>");
  await t.shown("visible", { version: { revision: 4, pages: { "index.html": "<h1>Later</h1>" } } });
  expect(mounted!.host.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<h1>Later</h1>");
});

test("a first version that comes while its page is hidden makes no frame until the page shows", async () => {
  const props = { version: { revision: 1, pages: { "index.html": "<h1>First</h1>" } }, path: "index.html", onGo: () => {}, held: {}, onFields: () => {}, onFocus: () => {}, data: () => null, subscribe: () => {}, unsubscribe: () => {}, submit: async () => ({ ok: true }), open: () => {} };
  mounted = await mountAsync(<Activity mode="hidden"><PageShownContext.Provider value={false}><AgentPageFrame {...props} /></PageShownContext.Provider></Activity>);
  expect(mounted.host.querySelector("iframe") === null).toBe(true);
  await act(async () => { mounted!.rerender(<Activity mode="visible"><PageShownContext.Provider value={true}><AgentPageFrame {...props} /></PageShownContext.Provider></Activity>); });
  expect(mounted.host.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<h1>First</h1>");
});

test("a frame that goes lets go of what it followed", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.subscribe", name: "threads" });
  await t.fromFrame({ type: "mandate.page.subscribe", name: "prom" });
  // A new version replaces the frame: the old one lets go.
  mounted!.rerender(<Activity mode="visible"><PageShownContext.Provider value={true}><AgentPageFrame {...t.props} version={{ revision: 9, pages: { "index.html": "<p>9</p>" } }} /></PageShownContext.Provider></Activity>);
  await act(async () => {});
  expect(t.calls.unsubscribed.sort()).toStrictEqual(["prom", "threads"]);
});

/** Sets the app's tokens on its root, as globals.css would for a theme, and
 *  takes them off after the test. */
function appTokens(values: Record<string, string>, theme: "light" | "dark") {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(values)) root.style.setProperty(name, value);
  root.dataset.theme = theme;
  onCleanup(() => {
    for (const name of Object.keys(values)) root.style.removeProperty(name);
    delete root.dataset.theme;
  });
}

test("the page's head carries the app's colors and fonts, after the base rules and before the page's own styles", async () => {
  appTokens({ "--background": "#ffffff", "--foreground": "#1a1a1c", "--font-sans": "-apple-system, sans-serif" }, "light");
  const { frame } = await render();
  const srcdoc = frame.getAttribute("srcdoc")!;
  const style = srcdoc.indexOf("<style data-mandate-page-style>");
  expect(style).toBeGreaterThan(srcdoc.indexOf("data-mandate-reset"));
  // Its own element, closed after its rules.
  expect(srcdoc.slice(style)).toMatch(/^<style data-mandate-page-style>[^<]*<\/style>/);
  expect(style).toBeLessThan(srcdoc.indexOf("<h1>Today</h1>"));
  expect(srcdoc).toContain("--mandate-bg:#ffffff;--mandate-fg:#1a1a1c");
  expect(srcdoc).toContain("--mandate-font:-apple-system, sans-serif");
  expect(srcdoc).toContain("body{background:var(--mandate-bg);color:var(--mandate-fg);font-family:var(--mandate-font)");
});

test("a new theme's colors reach the page in its frame, and the theme is said again after them", async () => {
  appTokens({ "--background": "#ffffff" }, "light");
  const before = useUIStore.getState().theme;
  onCleanup(() => useUIStore.setState({ theme: before }));
  const t = await render();
  await act(async () => { t.frame.dispatchEvent(new window.Event("load")); });
  t.posted.length = 0;
  // As in the app: the theme renders first, and the shell stamps the root
  // after (an effect of AppShell's), when the new tokens apply.
  await act(async () => { useUIStore.setState({ theme: "dark" }); });
  await act(async () => {
    document.documentElement.style.setProperty("--background", "#141416");
    document.documentElement.dataset.theme = "dark";
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  // The same frame: a new head would have reloaded the page.
  expect(mounted!.host.querySelector("iframe") === t.frame).toBe(true);
  const style = t.posted.findIndex((m) => m.type === "mandate.page.style");
  expect(style).toBeGreaterThanOrEqual(0);
  expect(String(t.posted[style]!.css)).toContain("--mandate-bg:#141416");
  expect(t.posted.slice(style + 1)).toStrictEqual([{ type: "mandate.canvas.theme", theme: "dark" }]);
  // Nothing changed since: nothing is sent again.
  const sent = t.posted.length;
  mounted!.rerender(<Activity mode="visible"><PageShownContext.Provider value={true}><AgentPageFrame {...t.props} held={{ again: "x" }} /></PageShownContext.Provider></Activity>);
  await act(async () => {});
  expect(t.posted.filter((m) => m.type === "mandate.page.style").length).toBe(1);
  expect(t.posted.length).toBe(sent);
});

test("the frame is told when quoting starts and ends, and a document that loads meanwhile is told it is on", async () => {
  const t = await render();
  // The page said it marks an item (so the bar offers Quote).
  await t.fromFrame({ type: "mandate.page.quotable", any: true });
  const told = () => t.posted.filter((m) => m.type === "mandate.page.quoting").map((m) => m.on);
  expect(told()).toEqual([]);
  await t.shown("visible", { quoting: true });
  expect(told()).toEqual([true]);
  // The page reloaded itself: its new document starts outside the mode.
  await act(async () => { t.frame.dispatchEvent(new window.Event("load")); });
  expect(told()).toEqual([true, true]);
  await t.shown("visible", { quoting: false });
  expect(told()).toEqual([true, true, false]);
});

test("a quote is taken only while quoting, and only one each time the mode is on", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.quote", text: "Before" });
  await t.shown("visible", { quoting: true });
  await t.fromFrame({ type: "mandate.page.quote", text: "  Order #12\n waits " });
  await t.fromFrame({ type: "mandate.page.quote", text: "Second" });
  await t.shown("visible", { quoting: false });
  await t.fromFrame({ type: "mandate.page.quote", text: "After" });
  await t.shown("visible", { quoting: true });
  await t.fromFrame({ type: "mandate.page.quote", text: "Again" });
  expect(t.calls.quotes).toEqual(["Order #12 waits", "Again"]);
});

test("whether the page has items to quote, and Esc in it while quoting, are passed on", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.quotable", any: true });
  await t.fromFrame({ type: "mandate.page.quotable", any: false });
  expect(t.calls.quotable).toEqual([true, false]);
  await t.fromFrame({ type: "mandate.page.quoteEnd" });
  expect(t.calls.quoteEnds).toBe(0);
  await t.shown("visible", { quoting: true });
  await t.fromFrame({ type: "mandate.page.quoteEnd" });
  expect(t.calls.quoteEnds).toBe(1);
});

test("a kept page shown again asks its frame whether it has an item to quote: what it said while hidden was not heard", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.focus", inField: false });
  const asked = () => t.posted.filter((m) => m.type === "mandate.page.askQuotable").length;
  expect(asked()).toBe(0);
  await t.shown("hidden");
  await t.shown("visible");
  expect(asked()).toBe(1);
});
