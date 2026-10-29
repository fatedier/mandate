import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { AgentPageFrame, AGENT_PAGE_ID } from "@/routes/global/page/AgentPageFrame";
import type { AgentPageDataDto } from "@shared/api/agent-page";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { useUIStore } from "@/store/ui";
import { mountAsync, type Mounted } from "../helpers/mount.js";

let mounted: Mounted | null = null;
afterEach(() => { runCleanups(); mounted = null; });

const DATA: Record<string, AgentPageDataDto> = {
  threads: { name: "threads", value: [{ id: "thr_1" }], at: "2026-10-20T10:00:00.000Z", error: null }
};

interface Calls { subscribed: string[]; unsubscribed: string[]; submitted: unknown[]; opened: string[]; fields: Array<Record<string, string>>; focus: boolean[] }

async function render(over: { held?: Record<string, string>; data?: (name: string) => AgentPageDataDto | null; submit?: (value: unknown) => Promise<{ ok: boolean; error?: string }> } = {}) {
  const calls: Calls = { subscribed: [], unsubscribed: [], submitted: [], opened: [], fields: [], focus: [] };
  const props = {
    version: { revision: 3, html: "<h1>Today</h1>" },
    held: over.held ?? {},
    onFields: (values: Record<string, string>) => { calls.fields.push(values); },
    onFocus: (inField: boolean) => { calls.focus.push(inField); },
    data: over.data ?? ((name: string) => DATA[name] ?? null),
    subscribe: (name: string) => { calls.subscribed.push(name); },
    unsubscribe: (name: string) => { calls.unsubscribed.push(name); },
    submit: over.submit ?? (async (value: unknown) => { calls.submitted.push(value); return { ok: true }; }),
    open: (path: string) => { calls.opened.push(path); }
  };
  mounted = await mountAsync(<AgentPageFrame {...props} />);
  const frame = mounted.host.querySelector("iframe")!;
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  const fromFrame = (data: Record<string, unknown>) => act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { ...data, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  return { frame, posted, calls, fromFrame, props };
}

test("the page's frame carries window.mandate before the page's scripts", async () => {
  const { frame } = await render();
  const srcdoc = frame.getAttribute("srcdoc")!;
  expect(srcdoc.indexOf("data-mandate-page")).toBeGreaterThan(srcdoc.indexOf("data-mandate-runtime"));
  expect(srcdoc.indexOf("data-mandate-page")).toBeLessThan(srcdoc.indexOf("</head>"));
  expect(srcdoc).toContain("<h1>Today</h1>");
  expect(srcdoc).toContain("/api/agent-page/assets/");
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
  mounted!.rerender(<AgentPageFrame {...t.props} data={(name) => (name === "prom" ? prom : null)} />);
  await act(async () => {});
  expect(t.posted.at(-1)).toEqual({ type: "mandate.page.result", reqId: 2, ok: true, data: { value: 3, at: null, error: null } });
});

test("a followed source's data is sent when it subscribes and each time it changes", async () => {
  let threads: AgentPageDataDto = DATA.threads!;
  const t = await render({ data: (name) => (name === "threads" ? threads : null) });
  await t.fromFrame({ type: "mandate.page.subscribe", name: "threads" });
  expect(t.posted).toStrictEqual([{ type: "mandate.page.data", name: "threads", data: { value: [{ id: "thr_1" }], at: "2026-10-20T10:00:00.000Z", error: null } }]);
  threads = { ...threads, value: [] };
  mounted!.rerender(<AgentPageFrame {...t.props} data={(name) => (name === "threads" ? threads : null)} />);
  await act(async () => {});
  expect(t.posted.at(-1)).toEqual({ type: "mandate.page.data", name: "threads", data: { value: [], at: "2026-10-20T10:00:00.000Z", error: null } });
  expect(t.posted.length).toBe(2);
  // A render with the same data sends nothing again.
  mounted!.rerender(<AgentPageFrame {...t.props} held={{ other: "x" }} data={(name) => (name === "threads" ? threads : null)} />);
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
  await t.fromFrame({ type: "mandate.page.open", path: "/threads/thr_1?worker=feat_2" });
  await t.fromFrame({ type: "mandate.page.open", path: "https://evil.example" });
  expect(t.calls.opened).toStrictEqual(["/threads/thr_1?worker=feat_2"]);
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
  mounted!.rerender(<AgentPageFrame {...t.props} version={{ revision: 4, html: "<h1>Later</h1>" }} />);
  await act(async () => {});
  const next = mounted!.host.querySelector("iframe")!;
  expect(next === first).toBe(false);
  expect(next.getAttribute("srcdoc")).toContain("<h1>Later</h1>");
});

test("Esc in the focused page reaches the page pane, as it does a worker's", async () => {
  const keysIn = async (paneMode: string | null) => {
    const props = {
      version: { revision: 1, html: "<input>" }, held: {}, onFields: () => {}, onFocus: () => {},
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
  expect(many.calls.subscribed.length).toBe(27);
  await many.fromFrame({ type: "mandate.page.get", name: "source_39", reqId: 1 });
  expect(many.posted).toStrictEqual([{ type: "mandate.page.result", reqId: 1, ok: false, error: "too many sources followed" }]);
});

test("a frame that goes lets go of what it followed", async () => {
  const t = await render();
  await t.fromFrame({ type: "mandate.page.subscribe", name: "threads" });
  await t.fromFrame({ type: "mandate.page.subscribe", name: "prom" });
  // A new version replaces the frame: the old one lets go.
  mounted!.rerender(<AgentPageFrame {...t.props} version={{ revision: 9, html: "<p>9</p>" }} />);
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
  mounted!.rerender(<AgentPageFrame {...t.props} held={{ again: "x" }} />);
  await act(async () => {});
  expect(t.posted.filter((m) => m.type === "mandate.page.style").length).toBe(1);
  expect(t.posted.length).toBe(sent);
});
