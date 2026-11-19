import { afterEach, expect, mock, test } from "bun:test";
import { act, Activity } from "react";
import { PageShownContext } from "@/lib/page-shown";
import { AgentPagePane } from "@/routes/personal/page/AgentPagePane";
import { AGENT_PAGE_ID } from "@/routes/personal/page/AgentPageFrame";
import { resetAgentPageStore, useAgentPageStore } from "@/store/agent-page";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useAgentChatStore } from "@/store/agent-chat";
import { formatClockMinutes } from "@/lib/format";
import type { AgentPageSourceDto, AgentPageStateDto, AgentPageUpdateDto, AgentPageVersionDto } from "@shared/api/agent-page";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settleUntil, type Mounted, settleRounds } from "../helpers/mount.js";
import { CanvasOpenerProvider } from "@/routes/canvas/CanvasOpenerProvider";
import { useLocation } from "react-router";
import { useReplyTabsStore } from "@/store/reply-tabs";
import type { ReplyTabDto, ThreadTabDto } from "@shared/api-contracts";
import { useThreadTabsStore } from "@/store/thread-tabs";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useThreadStatusStore } from "@/store/thread-status";
import { managerThreadDto } from "../helpers/client-builders.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { onCleanup } from "../helpers/cleanup.js";
import { useClosedTabsStore } from "@/store/closed-tabs";
import { reopenClosedTab } from "@/lib/reopen-closed-tab";
import { resetCanvasTitles, useCanvasTitles } from "@/store/canvas-titles";
import { usePageQuotes } from "@/store/page-quotes";
import { replyTabId } from "@/lib/panel-tabs";
import { openThreadBeside } from "@/routes/thread-tabs/open-thread-beside";

/** The frame given what the pane says: the last one, since another page of
 *  the version draws under the one in sight, after it in the document. */
const liveFrame = (host: HTMLElement) => [...host.querySelectorAll("iframe")].at(-1);

let at = "";
function Where() {
  at = useLocation().pathname;
  return null;
}

const sendMessage = useAgentChatStore.getState().sendMessage;
/** The replies the server keeps open in the personal agent's panel. */
let replyTabsServed: ReplyTabDto[] = [];
/** The threads the server keeps open beside the personal agent. */
let threadTabsServed: ThreadTabDto[] = [];
/** Opening a thread beside the agent fails (the server unreachable). */
let threadTabPostsFail = false;
/** Thread tab opens and closes answered only once this settles (a slow server). */
let threadTabWrites: Promise<void> | null = null;
/** The reply list read answered only once this settles. */
let replyTabReads: Promise<void> | null = null;
const managerThreads = useManagerThreadsStore.getState();
afterEach(() => {
  runCleanups();
  resetAgentPageStore();
  replyTabsServed = [];
  threadTabsServed = [];
  threadTabPostsFail = false;
  threadTabWrites = null;
  replyTabReads = null;
  useReplyTabsStore.setState({ byThread: new Map(), latest: new Map(), applied: new Map() });
  useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
  useManagerThreadsStore.setState({
    threads: managerThreads.threads, archived: managerThreads.archived,
    loaded: managerThreads.loaded, archivedLoaded: managerThreads.archivedLoaded, archivedReadFailed: managerThreads.archivedReadFailed
  });
  useThreadStatusStore.setState({ states: new Map() });
  useAgentPageUi.setState({ open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat", tabs: [], active: "page", fileLines: {}, history: false, recent: [], pagePath: "index.html", order: undefined });
  useAgentChatStore.setState({ sendMessage });
  useClosedTabsStore.setState({ byPanel: {} });
  resetCanvasTitles();
});

const AT = "2026-10-20T10:06:00.000Z";
const state = (revision: number | null, write: AgentPageStateDto["write"] = null): AgentPageStateDto => ({
  latest: revision === null ? null : { revision, writer: "agent", createdAt: AT },
  write
});
/** A version whose first page is `html`, with any other pages it has. */
const version = (revision: number, html: string, more: Record<string, string> = {}): AgentPageVersionDto =>
  ({ revision, pages: { "index.html": html, ...more }, writer: "agent", createdAt: AT });
const SOURCES: AgentPageSourceDto[] = [
  { name: "soil-sensors", run: "curl …", everyMs: 300_000, cwd: null, paused: false, lastRunAt: "2026-10-20T10:00:00.000Z", lastError: null },
  { name: "seed-orders", run: "x", everyMs: 3_600_000, cwd: null, paused: false, lastRunAt: "2026-10-20T09:00:00.000Z", lastError: "exit 1: no order sheet" }
];

const update = (over: Partial<AgentPageUpdateDto> & Pick<AgentPageUpdateDto, "name">): AgentPageUpdateDto => ({
  when: "0 9 * * *", whenText: "Daily 09:00", task: "Sum up yesterday.", paused: false,
  nextRunAt: "2026-10-21T09:00:00.000Z", lastRunAt: null, lastOutcome: null, lastError: null, ...over
});
const UPDATES: AgentPageUpdateDto[] = [
  update({ name: "morning-summary", lastRunAt: "2026-10-20T09:03:00.000Z", lastOutcome: "updated" }),
  update({ name: "order-notes", when: "0 */2 * * 1-5", whenText: "cron 0 */2 * * 1-5", nextRunAt: "2026-10-20T12:00:00.000Z", lastRunAt: "2026-10-20T10:00:00.000Z", lastOutcome: "unchanged" }),
  update({ name: "frost-watch", lastRunAt: "2026-10-20T09:01:00.000Z", lastOutcome: "failed", lastError: "it reached its step limit" }),
  update({ name: "weekly" })
];

/** The server's page; every request asked of it. */
function serve(page: { state: AgentPageStateDto; versions?: AgentPageVersionDto[]; sources?: AgentPageSourceDto[]; updates?: AgentPageUpdateDto[] }) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let sources = page.sources ?? [];
  let updates = page.updates ?? [];
  mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    const method = call.init?.method ?? "GET";
    const body = call.init?.body ? JSON.parse(String(call.init.body)) : null;
    requests.push({ method, path, body });
    if (path === "/api/agent-page") return jsonResponse(page.state);
    if (path === "/api/agents/threads/thr_g/reply-tabs") {
      if (method === "GET" && replyTabReads) return replyTabReads.then(() => jsonResponse({ tabs: replyTabsServed }));
      // A reply opened in the panel: a tab with an id of its own.
      if (method === "POST" && !replyTabsServed.some((t) => t.messageId === body.messageId)) {
        replyTabsServed = [...replyTabsServed, { ...replyTab(`rtab_${replyTabsServed.length + 100}`, body.text), messageId: body.messageId }];
      }
      return jsonResponse({ tabs: replyTabsServed });
    }
    if (path === "/api/agents/personal/thread-tabs") {
      if (method === "POST" && threadTabPostsFail) return jsonResponse({ error: "server unreachable" }, 503);
      const open = () => {
        if (method === "POST" && !threadTabsServed.some((t) => t.threadId === body.threadId)) threadTabsServed = [...threadTabsServed, threadTab(body.threadId)];
        return jsonResponse({ tabs: threadTabsServed });
      };
      return method === "POST" && threadTabWrites ? threadTabWrites.then(open) : open();
    }
    // A pinned thread's conversation: empty.
    if (/^\/api\/agents\/threads\/thr_(?!g\b)[^/]+(\/messages)?$/.test(path)) {
      return jsonResponse({ thread: { id: path.split("/")[4] }, messages: [], hasMore: false, contextUsage: null, activeWake: null, readAt: null });
    }
    const unpinned = path.match(/^\/api\/agents\/personal\/thread-tabs\/(.+)$/);
    if (unpinned && method === "DELETE") {
      const id = decodeURIComponent(unpinned[1]!);
      const close = () => {
        if (!threadTabsServed.some((t) => t.threadId === id)) return jsonResponse({ error: "thread tab not found" }, 404);
        threadTabsServed = threadTabsServed.filter((t) => t.threadId !== id);
        return jsonResponse({ tabs: threadTabsServed });
      };
      return threadTabWrites ? threadTabWrites.then(close) : close();
    }
    const closed = path.match(/^\/api\/agents\/threads\/thr_g\/reply-tabs\/(.+)$/);
    if (closed && method === "DELETE") {
      const id = decodeURIComponent(closed[1]!);
      if (!replyTabsServed.some((t) => t.id === id)) return jsonResponse({ error: "reply tab not found" }, 404);
      replyTabsServed = replyTabsServed.filter((t) => t.id !== id);
      return jsonResponse({ tabs: replyTabsServed });
    }
    const v = path.match(/^\/api\/agent-page\/versions\/(\d+)$/);
    if (v) return jsonResponse(page.versions?.find((x) => x.revision === Number(v[1])) ?? {}, page.versions ? 200 : 404);
    if (path === "/api/agent-page/sources") return jsonResponse({ sources });
    const s = path.match(/^\/api\/agent-page\/sources\/(.+)$/);
    if (s && method === "PATCH") {
      sources = sources.map((x) => (x.name === decodeURIComponent(s[1]!) ? { ...x, paused: body.paused } : x));
      return jsonResponse({ source: sources.find((x) => x.name === decodeURIComponent(s[1]!)) });
    }
    if (s && method === "DELETE") {
      sources = sources.filter((x) => x.name !== decodeURIComponent(s[1]!));
      return jsonResponse({ removed: true });
    }
    if (path === "/api/agent-page/updates") return jsonResponse({ updates });
    const u = path.match(/^\/api\/agent-page\/updates\/(.+)$/);
    if (u && method === "PATCH") {
      updates = updates.map((x) => (x.name === decodeURIComponent(u[1]!) ? { ...x, paused: body.paused } : x));
      return jsonResponse({ update: updates.find((x) => x.name === decodeURIComponent(u[1]!)) });
    }
    if (u && method === "DELETE") {
      updates = updates.filter((x) => x.name !== decodeURIComponent(u[1]!));
      return jsonResponse({ removed: true });
    }
    return jsonResponse({}, 404);
  });
  return requests;
}

let mounted: Mounted | null = null;
async function render() {
  mounted = await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" });
  return mounted.host;
}
const text = (host: HTMLElement) => host.textContent ?? "";
const button = (root: ParentNode, label: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);

test("the empty state asks the personal agent in the chat", async () => {
  serve({ state: state(null) });
  const sent = mock(async (_scope: unknown, _content: unknown) => {});
  useAgentChatStore.setState({ sendMessage: sent as unknown as typeof sendMessage });
  const host = await render();
  await settleUntil(() => text(host).includes("hasn't made a page yet"), "() => text(host).includes('hasn't made a page yet')");
  expect(text(host)).toContain("Juno hasn't made a page yet.");
  await act(async () => { button(host, "Ask Juno to make its page")!.click(); });
  expect(sent.mock.calls).toStrictEqual([[{ type: "personal", threadId: "thr_g" }, "Make your page."]]);
});

test("while the first page is being made, the empty state's button cannot ask again", async () => {
  const running = { taskId: "task_a", title: "First page", status: "running" as const, startedAt: AT, finishedAt: null, revision: null, error: null };
  serve({ state: state(null, running) });
  const host = await render();
  await settleUntil(() => text(host).includes("hasn't made a page yet"), "() => text(host).includes('hasn't made a page yet')");
  expect(button(host, "Ask Juno to make its page")!.disabled).toBe(true);
  // It ended without a page: the button asks again.
  await act(async () => { useAgentPageStore.getState().applyState(state(null, { ...running, status: "failed", finishedAt: AT, error: "the user stopped it" })); });
  expect(button(host, "Ask Juno to make its page")!.disabled).toBe(false);
});

test("the header says when the page was updated, Updating… while a page subagent writes, and Update failed with its reason", async () => {
  serve({ state: state(2), versions: [version(2, "<h1>Today</h1>")] });
  const host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "() => host.querySelector('iframe') !== null");
  expect(text(host)).toContain(`Page· updated ${formatClockMinutes(AT)}`);
  const running = { taskId: "task_a", title: "Put usage first", status: "running" as const, startedAt: AT, finishedAt: null, revision: null, error: null };
  await act(async () => { useAgentPageStore.getState().applyState(state(2, running)); });
  expect(host.querySelector('[data-slot="page-updating"]')?.textContent).toBe("Updating…");
  const failed = { ...running, status: "failed" as const, finishedAt: "2026-10-20T10:08:00.000Z", error: "Mandate restarted while it ran" };
  await act(async () => { useAgentPageStore.getState().applyState(state(2, failed)); });
  const mark = host.querySelector<HTMLButtonElement>('[data-slot="page-failed"]')!;
  expect([host.querySelector('[data-slot="page-updating"]') !== null, mark.textContent, mark.title]).toEqual([false, "· Update failed", "Mandate restarted while it ran."]);
  await act(async () => { mark.click(); });
  expect(document.body.textContent).toContain("Mandate restarted while it ran.");
  // The reasons written for the personal agent are said in the user's words; any other as it is.
  const shown = async (error: string) => {
    await act(async () => { useAgentPageStore.getState().applyState(state(2, { ...failed, error })); });
    return host.querySelector<HTMLButtonElement>('[data-slot="page-failed"]')!.title;
  };
  expect(await shown("the user stopped it")).toBe("You stopped it.");
  expect(await shown("you stopped it")).toBe("Juno stopped it.");
  expect(await shown("its conversation was archived")).toBe("The conversation was archived.");
  expect(await shown("it reached its step limit")).toBe("it reached its step limit");
  // A version published after the failure: the page is good again.
  await act(async () => { useAgentPageStore.getState().applyState({ latest: { revision: 3, writer: "agent", createdAt: "2026-10-20T10:09:00.000Z" }, write: failed }); });
  expect(host.querySelector('[data-slot="page-failed"]') !== null).toBe(false);
});

test("the sources menu lists each source with its schedule and last run, and pauses, resumes and removes it", async () => {
  const requests = serve({ state: state(1), versions: [version(1, "<p>x</p>")], sources: SOURCES });
  const host = await render();
  await settleUntil(() => button(host, "Sources · 2") !== undefined, "() => button(host, 'Sources · 2') !== undefined");
  await act(async () => { button(host, "Sources · 2")!.click(); });
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-source]"));
  expect(rows().map((row) => row.textContent)).toEqual([
    `soil-sensorsevery 5m · ran ${formatClockMinutes("2026-10-20T10:00:00.000Z")} · okcurl …PauseRemove`,
    `seed-ordersevery 1h · failed ${formatClockMinutes("2026-10-20T09:00:00.000Z")} · exit 1: no order sheetxPauseRemove`
  ]);
  // Each source's command, whole on hover however long.
  expect(rows().map((row) => row.querySelector<HTMLElement>('[data-slot="source-command"]')?.title)).toStrictEqual(["curl …", "x"]);
  expect(document.body.textContent).toContain("Built in: threads, workers, what waits on you, token usage, canvases, answers");
  await act(async () => { button(rows()[0]!, "Pause")!.click(); });
  await settleUntil(() => button(rows()[0]!, "Resume") !== undefined, "() => button(rows()[0]!, 'Resume') !== undefined");
  expect(rows()[0]!.textContent).toContain("every 5m · paused");
  await act(async () => { button(rows()[0]!, "Resume")!.click(); });
  await settleUntil(() => button(rows()[0]!, "Pause") !== undefined, "() => button(rows()[0]!, 'Pause') !== undefined");
  await act(async () => { button(rows()[1]!, "Remove")!.click(); });
  await settleUntil(() => rows().length === 1, "() => rows().length === 1");
  expect(requests.filter((r) => r.method !== "GET").map((r) => [r.method, r.path, r.body])).toStrictEqual([
    ["PATCH", "/api/agent-page/sources/soil-sensors", { paused: true }],
    ["PATCH", "/api/agent-page/sources/soil-sensors", { paused: false }],
    ["DELETE", "/api/agent-page/sources/seed-orders", null]
  ]);
});

test("the updates menu lists each update with its time, its next run and how it last went, and pauses, resumes and removes it", async () => {
  const requests = serve({ state: state(1), versions: [version(1, "<p>x</p>")], updates: UPDATES });
  const host = await render();
  await settleUntil(() => button(host, "Updates · 4") !== undefined, "the updates menu");
  await act(async () => { button(host, "Updates · 4")!.click(); });
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-update]"));
  const clock = formatClockMinutes;
  expect(rows().map((row) => row.textContent)).toEqual([
    `morning-summaryDaily 09:00 · next ${clock("2026-10-21T09:00:00.000Z")} · updated ${clock("2026-10-20T09:03:00.000Z")}PauseRemove`,
    `order-notescron 0 */2 * * 1-5 · next ${clock("2026-10-20T12:00:00.000Z")} · nothing changed ${clock("2026-10-20T10:00:00.000Z")}PauseRemove`,
    `frost-watchDaily 09:00 · next ${clock("2026-10-21T09:00:00.000Z")} · failed ${clock("2026-10-20T09:01:00.000Z")} · it reached its step limitPauseRemove`,
    `weeklyDaily 09:00 · next ${clock("2026-10-21T09:00:00.000Z")} · not run yetPauseRemove`
  ]);
  // What each asks its page subagent, whole on hover.
  expect(rows()[0]!.title).toBe("Sum up yesterday.");
  await act(async () => { button(rows()[0]!, "Pause")!.click(); });
  await settleUntil(() => button(rows()[0]!, "Resume") !== undefined, "paused");
  expect(rows()[0]!.textContent).toContain("Daily 09:00 · paused");
  await act(async () => { button(rows()[0]!, "Resume")!.click(); });
  await settleUntil(() => button(rows()[0]!, "Pause") !== undefined, "resumed");
  await act(async () => { button(rows()[3]!, "Remove")!.click(); });
  await settleUntil(() => rows().length === 3, "removed");
  expect(requests.filter((r) => r.method !== "GET").map((r) => [r.method, r.path, r.body])).toStrictEqual([
    ["PATCH", "/api/agent-page/updates/morning-summary", { paused: true }],
    ["PATCH", "/api/agent-page/updates/morning-summary", { paused: false }],
    ["DELETE", "/api/agent-page/updates/weekly", null]
  ]);
  // The server's list, whole, as it changes.
  await act(async () => { useAgentPageStore.getState().applyUpdates([UPDATES[1]!]); });
  expect(rows().map((row) => row.dataset.update)).toEqual(["order-notes"]);
});

test("a new version waits while a page field has focus, and typed values come back by id", async () => {
  serve({ state: state(1), versions: [version(1, "<input id=\"who\">v1"), version(2, "<input id=\"who\">v2")] });
  const host = await render();
  await settleUntil(() => liveFrame(host)?.getAttribute("srcdoc")?.includes("v1") ?? false, "() => host.querySelector('iframe')?.getAttribute('srcdoc')?.");
  const fromFrame = (data: Record<string, unknown>) => act(async () => {
    const frame = liveFrame(host)!;
    window.dispatchEvent(new window.MessageEvent("message", { data: { ...data, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  await fromFrame({ type: "mandate.page.focus", inField: true });
  await fromFrame({ type: "mandate.page.fields", values: { who: "gardener" } });
  await act(async () => { useAgentPageStore.getState().applyState(state(2)); });
  await settleUntil(() => useAgentPageStore.getState().version?.revision === 2, "() => useAgentPageStore.getState().version?.revision === 2");
  // Still the old frame, and a way to take the new one.
  expect(liveFrame(host)!.getAttribute("srcdoc")).toContain("v1");
  expect(button(host, "New version — Reload") !== undefined).toBe(true);
  // Focus moving to another field keeps it.
  await fromFrame({ type: "mandate.page.focus", inField: true });
  expect(liveFrame(host)!.getAttribute("srcdoc")).toContain("v1");
  // Leaving the field lets it in; its load gives back what was typed.
  await fromFrame({ type: "mandate.page.focus", inField: false });
  const frame = liveFrame(host)!;
  expect(frame.getAttribute("srcdoc")).toContain("v2");
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => { frame.dispatchEvent(new window.Event("load")); });
  expect(posted).toContainEqual({ type: "mandate.page.restore", values: { who: "gardener" } });
  expect(button(host, "New version — Reload") !== undefined).toBe(false);
});

test("a link to another page shows it; a new version stays on it, one without it goes back to the first page", async () => {
  serve({ state: state(1), versions: [
    version(1, "<h1>Home v1</h1>", { "orders.html": "<h1>Orders v1</h1>" }),
    version(2, "<h1>Home v2</h1>", { "orders.html": "<h1>Orders v2</h1>" }),
    version(3, "<h1>Home v3</h1>")
  ] });
  const host = await render();
  const srcdoc = () => liveFrame(host)?.getAttribute("srcdoc") ?? "";
  await settleUntil(() => srcdoc().includes("Home v1"), "the first page");
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.go", path: "orders.html", pageId: AGENT_PAGE_ID }, source: liveFrame(host)!.contentWindow as Window }));
  });
  expect(srcdoc()).toContain("Orders v1");
  // Where the user is, kept for the next time the page opens.
  expect(useAgentPageUi.getState().pagePath).toBe("orders.html");
  await act(async () => { useAgentPageStore.getState().applyState(state(2)); });
  await settleUntil(() => srcdoc().includes("Orders v2"), "the same page, newer");
  await act(async () => { useAgentPageStore.getState().applyState(state(3)); });
  await settleUntil(() => srcdoc().includes("Home v3"), "the first page, the other one gone");
});

test("what was typed is kept for each page: another page does not get it, the way back does", async () => {
  serve({ state: state(1), versions: [version(1, "<input id=\"q\">home", { "orders.html": "<input id=\"q\">orders" })] });
  const host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "the frame");
  const fromFrame = (data: Record<string, unknown>) => act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { ...data, pageId: AGENT_PAGE_ID }, source: liveFrame(host)!.contentWindow as Window }));
  });
  /** What the frame showing is given back when it loads. */
  const restored = async () => {
    const frame = liveFrame(host)!;
    const posted: Array<Record<string, unknown>> = [];
    (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
    await act(async () => { frame.dispatchEvent(new window.Event("load")); });
    return posted.find((m) => m.type === "mandate.page.restore")?.values;
  };
  await fromFrame({ type: "mandate.page.fields", values: { q: "on home" } });
  await fromFrame({ type: "mandate.page.go", path: "orders.html" });
  expect(await restored()).toEqual({});
  await fromFrame({ type: "mandate.page.fields", values: { q: "on the list" } });
  await fromFrame({ type: "mandate.page.go", path: "index.html" });
  expect(await restored()).toEqual({ q: "on home" });
  await fromFrame({ type: "mandate.page.go", path: "orders.html" });
  expect(await restored()).toEqual({ q: "on the list" });
});

test("Reload takes the new version at once; a reconnect reads the page again", async () => {
  const requests = serve({ state: state(1), versions: [version(1, "<input id=\"who\">v1"), version(2, "<input id=\"who\">v2")] });
  const host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "() => host.querySelector('iframe') !== null");
  const frame = liveFrame(host)!;
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.focus", inField: true, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  await act(async () => { useAgentPageStore.getState().applyState(state(2)); });
  await settleUntil(() => button(host, "New version — Reload") !== undefined, "() => button(host, 'New version — Reload') !== undefined");
  await act(async () => { button(host, "New version — Reload")!.click(); });
  expect(liveFrame(host)!.getAttribute("srcdoc")).toContain("v2");
  const reads = () => requests.filter((r) => r.path === "/api/agent-page").length;
  const before = reads();
  await act(async () => { window.dispatchEvent(new CustomEvent("mandate:sse-open")); });
  await settleUntil(() => reads() === before + 1, "() => reads() === before + 1");
});

test("a page reopened reads afresh what it asks for, and a source that is not there answers as absent", async () => {
  let threads = 1;
  mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") return jsonResponse(state(1));
    if (path === "/api/agent-page/versions/1") return jsonResponse(version(1, "<p>x</p>"));
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    if (path === "/api/agent-page/data/threads") return jsonResponse({ name: "threads", value: threads, at: null, error: null });
    return jsonResponse({ error: "page source not found" }, 404);
  });
  const ask = async (host: HTMLElement, name: string, reqId: number) => {
    const frame = liveFrame(host)!;
    const posted: Array<Record<string, unknown>> = [];
    (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
    await act(async () => {
      window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.get", name, reqId, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
    });
    await settleUntil(() => posted.some((m) => m.reqId === reqId), `the answer to ${name}`);
    return posted.find((m) => m.reqId === reqId);
  };
  let host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "the frame");
  expect(await ask(host, "threads", 1)).toMatchObject({ ok: true, data: { value: 1 } });
  expect(await ask(host, "ghost", 2)).toMatchObject({ ok: true, data: { value: null, at: null, error: "no such source" } });
  // The pane goes (another page, a phone's Chat tab) and comes back.
  mounted!.unmount();
  threads = 2;
  host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "the frame again");
  expect(await ask(host, "threads", 3)).toMatchObject({ ok: true, data: { value: 2 } });
});

test("what the user typed survives the pane going and coming back", async () => {
  serve({ state: state(1), versions: [version(1, "<input id=\"who\">")] });
  let host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "the frame");
  await act(async () => {
    const frame = liveFrame(host)!;
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.fields", values: { who: "gardener" }, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  mounted!.unmount();
  host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "the frame again");
  const frame = liveFrame(host)!;
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => { frame.dispatchEvent(new window.Event("load")); });
  expect(posted).toContainEqual({ type: "mandate.page.restore", values: { who: "gardener" } });
});

test("an answer sent while the pane goes still lets go of what was typed", async () => {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  mockFetch(async (call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") return jsonResponse(state(1));
    if (path === "/api/agent-page/versions/1") return jsonResponse(version(1, "<input id=\"who\">"));
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    if (path === "/api/agent-page/answers") { await answered; return jsonResponse({ answer: { id: "pga_1", value: 1, at: AT, read: false } }); }
    return jsonResponse({}, 404);
  });
  const host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "the frame");
  const frame = liveFrame(host)!;
  const fromFrame = (data: Record<string, unknown>) => act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { ...data, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  await fromFrame({ type: "mandate.page.fields", values: { who: "gardener" } });
  await fromFrame({ type: "mandate.page.submit", value: { who: "gardener" }, reqId: 1 });
  // The user goes to the chat before the answer is kept.
  mounted!.unmount();
  answer();
  await settleUntil(() => Object.keys(useAgentPageStore.getState().held).length === 0, "held let go");
});

test("a kept answer tells the frame showing to let go of what was typed", async () => {
  mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") return jsonResponse(state(1));
    if (path === "/api/agent-page/versions/1") return jsonResponse(version(1, "<input id=\"who\">"));
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    if (path === "/api/agent-page/answers") return jsonResponse({ answer: { id: "pga_1", value: 1, at: AT, read: false } });
    return jsonResponse({}, 404);
  });
  const host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "the frame");
  const frame = liveFrame(host)!;
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.submit", value: 1, reqId: 1, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  await settleUntil(() => posted.some((m) => m.type === "mandate.page.clear"), "the clear");
});

test("an answer kept lets go of what was typed on its own page only", async () => {
  mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") return jsonResponse(state(1));
    if (path === "/api/agent-page/versions/1") return jsonResponse(version(1, "<input id=\"q\">home", { "review.html": "<input id=\"q\">review" }));
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    if (path === "/api/agent-page/answers") return jsonResponse({ answer: { id: "pga_1", value: 1, at: AT, read: false } });
    return jsonResponse({}, 404);
  });
  const host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "the frame");
  const fromFrame = (data: Record<string, unknown>) => act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { ...data, pageId: AGENT_PAGE_ID }, source: liveFrame(host)!.contentWindow as Window }));
  });
  await fromFrame({ type: "mandate.page.fields", values: { q: "draft on home" } });
  await fromFrame({ type: "mandate.page.go", path: "review.html" });
  await fromFrame({ type: "mandate.page.fields", values: { q: "sent from review" } });
  const frame = liveFrame(host)!;
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  await fromFrame({ type: "mandate.page.submit", value: 1, reqId: 1 });
  await settleUntil(() => posted.some((m) => m.type === "mandate.page.clear"), "the clear on the page that sent it");
  expect(useAgentPageStore.getState().held).toEqual({ "index.html": { q: "draft on home" } });
  // The way back to the first page: its draft, and no clear for it.
  await fromFrame({ type: "mandate.page.go", path: "index.html" });
  const home = liveFrame(host)!;
  const homePosted: Array<Record<string, unknown>> = [];
  (home.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { homePosted.push(message); }) as Window["postMessage"];
  await act(async () => { home.dispatchEvent(new window.Event("load")); });
  expect(homePosted.find((m) => m.type === "mandate.page.restore")?.values).toEqual({ q: "draft on home" });
  expect(homePosted.some((m) => m.type === "mandate.page.clear")).toBe(false);
});

// On a desktop the page is the first tab of the side's row (a canvas opens
// beside it); its own toolbar sits under the row.
test("on a desktop the page is the first tab of a row with its maximize and no hide button, its toolbar under the row", async () => {
  serve({ state: state(4, { taskId: "task_a", title: "Put usage first", status: "failed", startedAt: AT, finishedAt: "2026-10-20T10:07:00.000Z", revision: null, error: "Mandate restarted while it ran." }), versions: [version(4, "<p>v4</p>")], sources: SOURCES });
  const host = await render();
  await settleUntil(() => liveFrame(host) !== undefined, "the page's frame");
  const row = host.querySelector<HTMLElement>('[role="tablist"][aria-label="Page tabs"]')!.parentElement!;
  expect(host.querySelector('[role="tablist"][aria-label="Page tabs"] [role="tab"]')!.textContent).toBe("Page");
  expect([button(row, "Maximize panel") !== undefined, button(row, "Hide panel") === undefined]).toEqual([true, true]);
  // The toolbar is under the row, not in it.
  const failed = host.querySelector('[data-slot="page-failed"]')!;
  expect(row.contains(failed)).toBe(false);
  expect(host.querySelector('[data-slot="page-toolbar"]')!.contains(failed)).toBe(true);
});

// The tab row already says Page: the toolbar under it is drawn on a desktop
// only once it has something of its own to say.
test("on a desktop a page not made yet has no toolbar row under its tab; one with a version says when it was updated there", async () => {
  serve({ state: state(null) });
  const empty = await render();
  await settleUntil(() => text(empty).includes("hasn't made a page yet"), "the empty state");
  expect(empty.querySelector('[data-slot="page-toolbar"]') === null).toBe(true);
  mounted?.unmount();
  serve({ state: state(2), versions: [version(2, "<h1>Today</h1>")] });
  const made = await render();
  await settleUntil(() => made.querySelector("iframe") !== null, "the page's frame");
  expect(made.querySelector('[data-slot="page-toolbar"]')?.textContent).toContain("updated");
});

// A canvas the page links to opens as any canvas does on this page: beside
// the chat on a desktop. Another of Mandate's pages is gone to.
test("a canvas the page opens goes through the page's opener; another page is navigated to", async () => {
  serve({ state: state(2), versions: [version(2, "<p>v2</p>")] });
  const asked: string[] = [];
  mounted = await mountAsync(
    <CanvasOpenerProvider open={(id) => asked.push(id)}><AgentPagePane name="Juno" threadId="thr_g" /><Where /></CanvasOpenerProvider>,
    { path: "/agent" }
  );
  const host = mounted.host;
  await settleUntil(() => liveFrame(host) !== undefined, "the page's frame");
  const frame = liveFrame(host)!;
  const fromFrame = (path: string) => act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.open", path, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  await fromFrame("/canvas/cnv_RelNotes001");
  expect([asked, at]).toStrictEqual([["cnv_RelNotes001"], "/agent"]);
  await fromFrame("/threads/thr_1");
  expect(at).toBe("/threads/thr_1");
});

const replyTab = (id: string, text: string): ReplyTabDto => ({
  id, threadId: "thr_g", messageId: `msg_${id}`, text, repliedAt: "2026-10-20T10:04:00.000Z", createdAt: "2026-10-20T10:05:00.000Z"
});
const tabNames = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('[role="tablist"][aria-label="Page tabs"] [role="tab"]')).map((tab) => tab.textContent?.replace(/\s+/g, " ").trim());

// The replies opened from the personal agent's chat are tabs after the canvases, the
// same on every device; on a phone, where canvases open full screen, they
// give the panel a tab row of its own.
test("reply tabs follow the canvas tabs on the personal agent's panel", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  replyTabsServed = [replyTab("rtab_1", "**Release check**: two of three ready.")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "page" });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"]') !== null, "the reply's tab");
  expect(tabNames(host)).toEqual(["Page", "Canvas", "Release check: two of three ready."]);
  await act(async () => { (host.querySelector('[data-reply-tab="rtab_1"]') as HTMLElement).click(); });
  expect(host.querySelector('[data-slot="reply-tab-view"]')?.textContent).toContain("two of three ready.");
  expect(host.querySelector('[data-slot="agent-page-body"]')!.classList.contains("hidden")).toBe(true);
});

// In the order the person dragged them into: any kind among the
// others, Page first and fixed; a close with nothing shown before it goes to
// the tab on its left as drawn.
test("the panel draws its tabs in the stored order across kinds, Page first and fixed; closing the shown tab with nothing shown before goes to its left neighbour as drawn", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  replyTabsServed = [replyTab("rtab_1", "**Release check**: two of three ready.")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "canvas:cnv_a", recent: [], order: [replyTabId("rtab_1"), "canvas:cnv_a"] });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"]') !== null, "the reply's tab");
  expect(tabNames(host)).toEqual(["Page", "Release check: two of three ready.", "Canvas"]);
  const groups = [...host.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Page tabs"] > [role="tab"]')].map((tab) => tab.dataset.sortOrder ?? null);
  expect(groups).toEqual([null, "tabs", "tabs"]);
  await closeTabIn(host, '[data-canvas-tab="cnv_a"]');
  expect(useAgentPageUi.getState().active).toBe(replyTabId("rtab_1"));
});

// On a phone, as on a desktop, the row is always there: + opens a thread
// beside the agent from the start. No Hide page: the bar's Chat does it.
test("on a phone the panel always has its tab row with the +, no Hide page, and no canvas tabs in it", async () => {
  onCleanup(fakePhoneWidth());
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "page" });
  let host = await render();
  await settleUntil(() => useReplyTabsStore.getState().byThread.has("thr_g"), "the reply tabs read");
  expect(tabNames(host)).toEqual(["Page"]);
  expect(host.querySelector('[aria-label="Open a thread beside Juno"]') !== null).toBe(true);
  expect(button(host, "Hide page") === undefined).toBe(true);
  mounted!.unmount();
  useReplyTabsStore.setState({ byThread: new Map(), latest: new Map(), applied: new Map() });
  replyTabsServed = [replyTab("rtab_1", "Photo import done.")];
  host = await render();
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"]') !== null, "the reply's tab");
  expect(tabNames(host)).toEqual(["Page", "Photo import done."]);
});

test("a shown reply tab removed elsewhere falls back to the tab before it; Close here does the same", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  replyTabsServed = [replyTab("rtab_1", "First reply."), replyTab("rtab_2", "Second reply."), replyTab("rtab_3", "Third reply.")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "reply:rtab_2" });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-slot="reply-tab-view"]')?.textContent?.includes("Second reply.") === true, "the second reply shows");
  // Closed on another device: the list the server reports no longer has it.
  replyTabsServed = replyTabsServed.filter((t) => t.id !== "rtab_2");
  await act(async () => { useReplyTabsStore.getState().changed("thr_g"); });
  await settleUntil(() => useAgentPageUi.getState().active === "reply:rtab_1", "the tab before it opens");
  // Closed here, the first reply tab: the canvas before it.
  const close = host.querySelector('[data-reply-tab="rtab_1"] [aria-label^="Close"]') as HTMLElement;
  await act(async () => { close.click(); });
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"]') === null, "its tab goes");
  expect(useAgentPageUi.getState().active).toBe("canvas:cnv_a");
  expect(replyTabsServed.map((t) => t.id)).toEqual(["rtab_3"]);
});

// A phone's row has no canvas or file tabs: one shown there before (on a
// wider screen) is not gone back to.
test("on a phone a reply closed goes back past a canvas shown before it, which its row does not have", async () => {
  onCleanup(fakePhoneWidth());
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  replyTabsServed = [replyTab("rtab_1", "First reply."), replyTab("rtab_2", "Second reply.")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "reply:rtab_2", recent: ["page", "reply:rtab_1", "canvas:cnv_a", "reply:rtab_2"] });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_2"]') !== null, "the second reply's tab");
  await act(async () => { host.querySelector<HTMLElement>('[data-reply-tab="rtab_2"] [aria-label^="Close"]')!.click(); });
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_2"]') === null, "its tab goes");
  expect(useAgentPageUi.getState().active).toBe("reply:rtab_1");
});

test("a shown reply tab that goes with the tabs before it falls back to the nearest one still there", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  replyTabsServed = [replyTab("rtab_1", "First reply."), replyTab("rtab_2", "Second reply."), replyTab("rtab_3", "Third reply.")];
  useAgentPageUi.setState({ tabs: [], active: "reply:rtab_3" });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-slot="reply-tab-view"]')?.textContent?.includes("Third reply.") === true, "the third reply shows");
  // Both closed on another device while this one was not listening.
  replyTabsServed = replyTabsServed.filter((t) => t.id === "rtab_1");
  await act(async () => { useReplyTabsStore.getState().changed("thr_g"); });
  await settleUntil(() => useAgentPageUi.getState().active === "reply:rtab_1", "the first reply opens");
});

// A reply tab switched away from is kept as it was left, as a canvas tab is:
// a long reply keeps its place.
test("a reply tab switched away from and back to is the same view, so it keeps its place", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  replyTabsServed = [replyTab("rtab_1", "A long reply.")];
  useAgentPageUi.setState({ tabs: [], active: "reply:rtab_1" });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-slot="reply-tab-view"]') !== null, "the reply shows");
  const view = host.querySelector('[data-slot="reply-tab-view"]')!;
  const tabNamed = (name: string) => Array.from(host.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Page tabs"] [role="tab"]')).find((t) => t.textContent?.trim() === name)!;
  await act(async () => { tabNamed("Page").click(); });
  expect(host.querySelector('[data-slot="agent-page-body"]')!.classList.contains("hidden")).toBe(false);
  expect([view.isConnected, view.classList.contains("hidden")]).toEqual([true, true]);
  await act(async () => { tabNamed("A long reply.").click(); });
  expect(host.querySelector('[data-slot="reply-tab-view"]:not(.hidden)') === view).toBe(true);
});

// A close the server refuses reads the list again: a tab another device
// already closed (its event missed) goes at once rather than at the next one.
test("a close refused because the tab is already gone reads the list again, and the tab goes", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  replyTabsServed = [replyTab("rtab_1", "First reply."), replyTab("rtab_2", "Second reply.")];
  const host = await render();
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"][role="tab"]') !== null, "the reply tabs");
  // Closed on another device; this one did not hear of it.
  replyTabsServed = replyTabsServed.filter((t) => t.id !== "rtab_1");
  const close = host.querySelector('[data-reply-tab="rtab_1"][role="tab"] [aria-label^="Close"]') as HTMLElement;
  await act(async () => { close.click(); });
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"][role="tab"]') === null, "the gone tab leaves");
  expect(host.querySelector('[data-reply-tab="rtab_2"][role="tab"]') !== null).toBe(true);
});

const threadTab = (threadId: string): ThreadTabDto => ({ threadId, createdAt: "2026-10-20T10:05:00.000Z" });
/** Open threads as the sidebar has them, and one archived. */
function seedThreads() {
  useManagerThreadsStore.setState({
    threads: new Map([
      ["thr_docs", managerThreadDto("thr_docs", { title: "Docs layout", lastActivityAt: "2026-10-20T10:01:00.000Z" })],
      ["thr_ci", managerThreadDto("thr_ci", { title: "CI speed-up", lastActivityAt: "2026-10-20T09:00:00.000Z" })]
    ]),
    archived: [{ id: "thr_old", title: "Old release", archivedAt: "2026-10-19T10:00:00.000Z", lastActivityAt: "2026-10-19T10:00:00.000Z", workers: 0, canvases: 0, labels: [], projects: [] }]
  });
  useThreadStatusStore.setState({ states: new Map([["thr_ci", "working"], ["thr_docs", "idle"]]) });
}
const threadTabEl = (host: HTMLElement, threadId: string) => host.querySelector<HTMLElement>(`[data-thread-tab="${threadId}"][role="tab"]`);
async function openAddMenu(host: HTMLElement) {
  const trigger = host.querySelector<HTMLElement>('[aria-label="Open a thread beside Juno"]')!;
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

// Threads opened beside the personal agent are the first tabs after Page, then the
// canvases, then the replies; each is named by its thread, with the state
// mark the sidebar gives it.
test("thread tabs come right after Page, named by their threads with the sidebar's marks", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci"), threadTab("thr_old")];
  replyTabsServed = [replyTab("rtab_1", "Photo import done.")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "page" });
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_old") !== null && host.querySelector('[data-reply-tab="rtab_1"]') !== null, "the thread and reply tabs");
  expect(tabNames(host)).toEqual(["Page", "CI speed-up", "Old release", "Canvas", "Photo import done."]);
  expect(threadTabEl(host, "thr_ci")!.querySelector('[role="img"]')?.getAttribute("data-mark")).toBe("pulse");
});

test("a thread tab shows its conversation under a bar that opens the thread; an archived one is read-only", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci"), threadTab("thr_old")];
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab");
  await act(async () => { threadTabEl(host, "thr_ci")!.click(); });
  const view = () => host.querySelector<HTMLElement>('[data-slot="thread-tab-view"]');
  expect(view()?.querySelector('[data-slot="thread-tab-title"]')?.textContent).toBe("CI speed-up");
  const link = view()!.querySelector<HTMLAnchorElement>('a[href="/threads/thr_ci"]');
  expect(link?.textContent?.trim()).toBe("Open thread");
  expect(host.querySelector('[data-slot="agent-page-body"]')!.classList.contains("hidden")).toBe(true);
  expect(view()!.querySelector('[data-slot="archived-note"]') === null).toBe(true);
  await act(async () => { threadTabEl(host, "thr_old")!.click(); });
  await settleUntil(() => view()?.querySelector('[data-slot="archived-note"]') != null, "the archived note");
  expect(view()!.querySelector('[data-slot="thread-tab-title"]')?.textContent).toBe("Old release");
});

test("a shown thread tab closed elsewhere falls back to the one before it, then Page; Close here closes it on the server", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci"), threadTab("thr_docs")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "thread:thr_docs" });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-slot="thread-tab-title"]')?.textContent === "Docs layout", "the docs thread shows");
  // Closed on another device: the list the server reports no longer has it.
  threadTabsServed = threadTabsServed.filter((t) => t.threadId !== "thr_docs");
  await act(async () => { useThreadTabsStore.getState().changed(); });
  await settleUntil(() => useAgentPageUi.getState().active === "thread:thr_ci", "the thread tab before it opens");
  const close = threadTabEl(host, "thr_ci")!.querySelector<HTMLElement>('[aria-label^="Close"]')!;
  await act(async () => { close.click(); });
  await settleUntil(() => threadTabEl(host, "thr_ci") === null, "its tab goes");
  expect([useAgentPageUi.getState().active, threadTabsServed]).toEqual(["page", []]);
});

test("closing the first canvas while it shows goes to the thread tab before it", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "canvas:cnv_a" });
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab");
  const close = host.querySelector<HTMLElement>('[data-canvas-tab="cnv_a"] [aria-label^="Close"]')!;
  await act(async () => { close.click(); });
  expect(useAgentPageUi.getState().active).toBe("thread:thr_ci");
});

test("the + lists the open threads in the sidebar's order with their marks and a tick on those open; one chosen opens beside", async () => {
  seedThreads();
  const requests = serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_docs")];
  useThreadStatusStore.setState({ states: new Map([["thr_ci", "needs_you"], ["thr_docs", "idle"]]) });
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_docs") !== null, "the docs tab");
  const all = await openAddMenu(host);
  // Tasks and the agent's Notes first; then what asks for the user first, as the
  // sidebar sorts them; the archived one is not offered.
  // Then New terminal (no terminal is pinned here, so no Terminals group).
  expect(all.slice(0, 4).map((item) => item.textContent?.trim())).toEqual(["Tasks", "Notes", "Calendar", "New terminal"]);
  const items = all.slice(4);
  expect(items.map((item) => item.textContent?.trim())).toEqual(["CI speed-up", "Docs layout"]);
  expect(items.map((item) => item.querySelector('[role="img"][aria-label="Open"]') !== null)).toEqual([false, true]);
  expect(items[0]!.querySelector('[data-mark="dot"]')).not.toBeNull();
  await act(async () => { items[0]!.click(); });
  await settleUntil(() => useAgentPageUi.getState().active === "thread:thr_ci", "the chosen thread shows");
  expect(requests.filter((r) => r.method === "POST" && r.path === "/api/agents/personal/thread-tabs").map((r) => r.body)).toStrictEqual([{ threadId: "thr_ci" }]);
  expect(tabNames(host)).toEqual(["Page", "Docs layout", "CI speed-up"]);
});

test("on a phone the panel has a tab row while threads are open beside it, with the +", async () => {
  onCleanup(fakePhoneWidth());
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "page" });
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab");
  expect(tabNames(host)).toEqual(["Page", "CI speed-up"]);
  expect(host.querySelector('[aria-label="Open a thread beside Juno"]')).not.toBeNull();
});

// A thread in neither list (the archived one not read yet, or its read
// failed) is not known to be open: no composer until it is.
test("a thread tab whose thread is in neither list waits for them, and says so when the read failed", async () => {
  useManagerThreadsStore.setState({ threads: new Map(), archived: [], loaded: true, archivedLoaded: false, archivedReadFailed: false });
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_old")];
  useAgentPageUi.setState({ tabs: [], active: "thread:thr_old" });
  const host = await render();
  const view = () => host.querySelector<HTMLElement>('[data-slot="thread-tab-view"]');
  await settleUntil(() => view() !== null, "the thread tab's view");
  expect(view()!.querySelector('[data-slot="composer"]') === null).toBe(true);
  expect(view()!.textContent).toContain("Loading");
  act(() => useManagerThreadsStore.setState({ archivedReadFailed: true }));
  expect(view()!.textContent).toContain("Couldn't load the thread.");
  act(() => useManagerThreadsStore.setState({
    archived: [{ id: "thr_old", title: "Old release", archivedAt: "2026-10-19T10:00:00.000Z", lastActivityAt: "2026-10-19T10:00:00.000Z", workers: 0, canvases: 0, labels: [], projects: [] }], archivedLoaded: true, archivedReadFailed: false
  }));
  await settleUntil(() => view()?.querySelector('[data-slot="archived-note"]') != null, "the archived note");
  expect(view()!.querySelector('[data-slot="composer"]') === null).toBe(true);
});
// Too many to fit: the row's list names them by kind, as the panel orders them.
test("a full row's list of all tabs groups the panel's threads, canvases and replies", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci")];
  replyTabsServed = [replyTab("rtab_1", "Photo import done.")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "page" });
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null && host.querySelector('[data-reply-tab="rtab_1"]') !== null, "the tabs");
  const row = host.querySelector<HTMLElement>('[role="tablist"][aria-label="Page tabs"]')!;
  Object.defineProperty(row, "clientWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => 700 });
  act(() => { row.dispatchEvent(new window.Event("scroll")); });
  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="All tabs"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const groups = [...document.querySelectorAll('[data-slot="all-tabs-menu"] [role="group"]')].map((g) => g.getAttribute("aria-label"));
  expect(groups).toEqual(["Threads", "Canvases", "Replies"]);
});

test("a file opened beside the personal agent is a tab after the canvases, named by its file, its view at the lines asked for", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a", "file:/tmp/project-1/notes/index.md"], active: "file:/tmp/project-1/notes/index.md", fileLines: { "file:/tmp/project-1/notes/index.md": { line: 4 } } });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-slot="file-view"]') !== null, "the file's view");
  const tab = host.querySelector<HTMLElement>('[data-file-tab="/tmp/project-1/notes/index.md"]')!;
  expect([tab.textContent, tab.getAttribute("aria-selected")]).toEqual(["index.md", "true"]);
  expect(host.querySelector('[data-slot="file-view"]')!.getAttribute("data-line")).toBe("4");
  // Closing it goes to its left neighbour, the canvas.
  await act(async () => { tab.querySelector<HTMLElement>('[aria-label^="Close"]')!.click(); });
  expect(useAgentPageUi.getState().active).toBe("canvas:cnv_a");
});

// Reopen: what was closed in the personal agent's panel comes back from the
// row's Reopen, newest first; a canvas or file where it stood, a thread or a
// reply through the server as it was first opened. In memory only.
const reopenButton = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Reopen a closed tab"]');
async function openReopen(host: HTMLElement) {
  await act(async () => {
    reopenButton(host)!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[data-slot="recently-closed-menu"] [role="menuitem"]')];
}
const reopenNames = (rows: HTMLElement[]) => rows.map((row) => row.querySelector('[data-slot="recently-closed-name"]')?.textContent);
const closeTabIn = async (host: HTMLElement, selector: string) => {
  await act(async () => { host.querySelector<HTMLElement>(`${selector} [aria-label^="Close"]`)!.click(); });
};

test("a canvas closed beside the personal agent comes back from Reopen where it stood, shown; with nothing left Reopen goes", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a", "canvas:cnv_b", "canvas:cnv_c"], active: "page" });
  const host = await render();
  expect(reopenButton(host) === null).toBe(true);
  await closeTabIn(host, '[data-canvas-tab="cnv_b"]');
  expect(useAgentPageUi.getState().tabs).toEqual(["canvas:cnv_a", "canvas:cnv_c"]);
  const rows = await openReopen(host);
  expect(reopenNames(rows)).toEqual(["Canvas"]);
  await act(async () => { rows[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["canvas:cnv_a", "canvas:cnv_b", "canvas:cnv_c"], active: "canvas:cnv_b" });
  expect(reopenButton(host) === null).toBe(true);
});

test("a thread tab closed comes back through the server as + opens one; a reply tab closed comes back with its reply", async () => {
  seedThreads();
  const requests = serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci")];
  replyTabsServed = [replyTab("rtab_1", "**Release check**: two of three ready.")];
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null && host.querySelector('[data-reply-tab="rtab_1"]') !== null, "the thread and reply tabs");
  await closeTabIn(host, '[data-thread-tab="thr_ci"][role="tab"]');
  await settleUntil(() => threadTabEl(host, "thr_ci") === null, "the thread tab goes");
  await closeTabIn(host, '[data-reply-tab="rtab_1"]');
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"]') === null, "the reply tab goes");
  // Newest first.
  let rows = await openReopen(host);
  expect(reopenNames(rows)).toEqual(["Release check: two of three ready.", "CI speed-up"]);
  await act(async () => { rows[1]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab is back");
  expect(useAgentPageUi.getState().active).toBe("thread:thr_ci");
  expect(requests.filter((r) => r.method === "POST").map((r) => [r.path, r.body])).toEqual([["/api/agents/personal/thread-tabs", { threadId: "thr_ci" }]]);
  rows = await openReopen(host);
  await act(async () => { rows[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => replyTabsServed.length === 1, "the reply's tab is back on the server");
  expect(requests.filter((r) => r.method === "POST").at(-1)).toEqual({ method: "POST", path: "/api/agents/threads/thr_g/reply-tabs", body: { messageId: "msg_rtab_1", text: "**Release check**: two of three ready." } });
  await settleUntil(() => useAgentPageUi.getState().active === `reply:${replyTabsServed[0]!.id}`, "the reply's tab is shown");
  expect(reopenButton(host) === null).toBe(true);
});

test("History and Tasks closed come back to their own places", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  useAgentPageUi.setState({ tabs: ["tasks", "canvas:cnv_a"], history: true, active: "page" });
  const host = await render();
  await closeTabIn(host, '[data-tasks-tab]');
  await act(async () => { host.querySelector<HTMLElement>('[aria-label="Close History"]')!.click(); });
  expect([useAgentPageUi.getState().history, useAgentPageUi.getState().tabs]).toEqual([false, ["canvas:cnv_a"]]);
  let rows = await openReopen(host);
  expect(reopenNames(rows)).toEqual(["History", "Tasks"]);
  await act(async () => { rows[1]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  rows = await openReopen(host);
  await act(async () => { rows[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(tabNames(host).slice(0, 3)).toEqual(["Page", "History", "Tasks"]);
});

test("a closed tab opened again some other way leaves the list", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a", "canvas:cnv_b"], active: "page" });
  const host = await render();
  await closeTabIn(host, '[data-canvas-tab="cnv_a"]');
  await closeTabIn(host, '[data-canvas-tab="cnv_b"]');
  expect(reopenNames(await openReopen(host))).toEqual(["Canvas", "Canvas"]);
  await act(async () => { document.querySelector('[data-slot="recently-closed-menu"]')!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await act(async () => { useAgentPageUi.getState().openCanvas("cnv_a"); });
  const rows = await openReopen(host);
  expect(rows.length).toBe(1);
  await act(async () => { rows[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(useAgentPageUi.getState().active).toBe("canvas:cnv_b");
});

test("on a phone Reopen lists only what its row shows: no canvas", async () => {
  onCleanup(fakePhoneWidth());
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  replyTabsServed = [replyTab("rtab_1", "Photo import done.")];
  // Closed on a wider screen before it narrowed.
  useClosedTabsStore.getState().record("personal", { id: "canvas:cnv_a", label: "Thumbnail cache report", icon: null, closedAt: Date.now(), after: null });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"]') !== null, "the reply's tab");
  expect(reopenButton(host) === null).toBe(true);
  await closeTabIn(host, '[data-reply-tab="rtab_1"]');
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"]') === null, "its tab goes");
  // The row stays while something can come back.
  expect(reopenNames(await openReopen(host))).toEqual(["Photo import done."]);
});

test("the desktop's Reopen Closed Tab reopens the panel's latest closed tab", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a", "canvas:cnv_b"], active: "page" });
  const host = await render();
  await closeTabIn(host, '[data-canvas-tab="cnv_b"]');
  await closeTabIn(host, '[data-canvas-tab="cnv_a"]');
  await act(async () => { reopenClosedTab(); });
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["canvas:cnv_a"], active: "canvas:cnv_a" });
  mounted!.unmount();
  mounted = null;
  // No panel in sight: nothing to reopen into.
  await act(async () => { reopenClosedTab(); });
  expect(useAgentPageUi.getState().tabs).toEqual(["canvas:cnv_a"]);
});

test("a closed tab whose thing is gone leaves the list: a deleted canvas, a deleted thread", async () => {
  seedThreads();
  useManagerThreadsStore.setState({ loaded: true, archivedLoaded: true });
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  const at = Date.now();
  for (const id of ["canvas:cnv_a", "canvas:cnv_b", "thread:thr_ci", "thread:thr_gone", "thread:thr_old"]) {
    useClosedTabsStore.getState().record("personal", { id, label: id, icon: null, closedAt: at, after: null });
  }
  // cnv_b is not there any more; cnv_a's title is not read yet.
  useCanvasTitles.setState({ titles: new Map([["cnv_b", null]]) });
  const host = await render();
  expect(reopenNames(await openReopen(host))).toEqual(["thread:thr_old", "thread:thr_ci", "canvas:cnv_a"]);
});

test("a closed reply opened in the panel again from its chat leaves the list", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  replyTabsServed = [replyTab("rtab_1", "Photo import done.")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "page" });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"]') !== null, "the reply's tab");
  await closeTabIn(host, '[data-reply-tab="rtab_1"]');
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"]') === null, "its tab goes");
  await closeTabIn(host, '[data-canvas-tab="cnv_a"]');
  expect(reopenNames(await openReopen(host))).toEqual(["Canvas", "Photo import done."]);
  await act(async () => { document.querySelector('[data-slot="recently-closed-menu"]')!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  // Its chat's Open in panel: a new tab for the same reply.
  await act(async () => { await useReplyTabsStore.getState().add("thr_g", "msg_rtab_1", "Photo import done."); });
  await settleUntil(() => host.querySelector('[data-reply-tab]') !== null, "the reply's new tab");
  expect(reopenNames(await openReopen(host))).toEqual(["Canvas"]);
});

test("a reopen the server refused stays in the list to try again", async () => {
  seedThreads();
  const requests = serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "page" });
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab");
  await closeTabIn(host, '[data-thread-tab="thr_ci"][role="tab"]');
  await settleUntil(() => threadTabEl(host, "thr_ci") === null, "the thread tab goes");
  await closeTabIn(host, '[data-canvas-tab="cnv_a"]');
  threadTabPostsFail = true;
  let rows = await openReopen(host);
  expect(reopenNames(rows)).toEqual(["Canvas", "CI speed-up"]);
  await act(async () => { rows[1]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => requests.some((r) => r.method === "POST"), "the open is sent");
  // Its refusal answered.
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  rows = await openReopen(host);
  // In its place among the others, by when it closed.
  expect(reopenNames(rows)).toEqual(["Canvas", "CI speed-up"]);
  threadTabPostsFail = false;
  await act(async () => { rows[1]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab is back");
});

// The five listed are the newest that can come back: a tab open again, or
// one whose canvas is gone, takes none of them.
test("Reopen lists the five newest that can come back, past ones open again or gone", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  const canvases = ["cnv_a", "cnv_b", "cnv_c", "cnv_d", "cnv_e", "cnv_f", "cnv_g", "cnv_h"];
  useAgentPageUi.setState({ tabs: canvases.map((id) => `canvas:${id}`), active: "page" });
  const host = await render();
  for (const id of canvases.slice(0, 6)) await closeTabIn(host, `[data-canvas-tab="${id}"]`);
  // cnv_f opened again from the chat; cnv_e's canvas deleted.
  await act(async () => { useAgentPageUi.getState().openCanvas("cnv_f"); });
  await act(async () => { useCanvasTitles.setState({ titles: new Map([["cnv_e", null]]) }); });
  await closeTabIn(host, '[data-canvas-tab="cnv_g"]');
  await closeTabIn(host, '[data-canvas-tab="cnv_h"]');
  // Six can come back (h, g, d, c, b, a): the newest five are listed.
  const rows = await openReopen(host);
  expect(rows.length).toBe(5);
  await act(async () => { rows[4]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect(useAgentPageUi.getState().active).toBe("canvas:cnv_b");
});

test("on a phone the bar under the row comes only with something to say, as on a desktop", async () => {
  onCleanup(fakePhoneWidth());
  serve({ state: state(null) });
  const empty = await render();
  expect(empty.querySelector('[data-slot="page-toolbar"]') === null).toBe(true);
  mounted!.unmount();
  resetAgentPageStore();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  const made = await render();
  await settleUntil(() => made.querySelector('[data-slot="page-toolbar"]') !== null, "the bar");
  expect(made.querySelector('[data-slot="page-toolbar"]')?.textContent).toContain("updated");
});

/** The page's frame, as the pane shows it: what it says to the host, and
 *  what the host posts to it. */
async function pageFrame(host: HTMLElement) {
  await settleUntil(() => liveFrame(host) !== undefined, "() => host.querySelector('iframe') !== null");
  const frame = liveFrame(host)!;
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  const say = (data: Record<string, unknown>) => act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { ...data, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  const quoting = () => posted.filter((m) => m.type === "mandate.page.quoting").map((m) => m.on);
  return { say, quoting };
}
const QUOTE_KEY = "personal:thr_g";
const press = (b: HTMLElement | undefined) => act(async () => { b!.click(); });
const strip = (host: HTMLElement) => host.querySelector("[data-slot='page-quoting']");
/** Whether the mode is on: the Quote button, pressed, is all that shows it. */
const on = (host: HTMLElement) => button(host, "Quote")?.getAttribute("aria-pressed") === "true";

test("Quote is in the page's bar only while the page marks an item; a pick goes into the composer and ends the mode", async () => {
  usePageQuotes.setState({ byKey: new Map() });
  onCleanup(() => usePageQuotes.setState({ byKey: new Map() }));
  serve({ state: state(1), versions: [version(1, "<div data-quote='Order #12 waits'>Order</div>")] });
  const host = await render();
  const frame = await pageFrame(host);
  expect(button(host, "Quote")).toBeUndefined();
  await frame.say({ type: "mandate.page.quotable", any: true });
  const quote = button(host, "Quote")!;
  expect(quote.getAttribute("title")).toBe("Quote an item in the chat");
  await press(quote);
  expect(frame.quoting()).toEqual([true]);
  // No line over the page says so: the pressed button and the outlined items do.
  expect([on(host), strip(host) === null, button(host, "Cancel") === undefined]).toEqual([true, true, true]);
  await frame.say({ type: "mandate.page.quote", text: "Order #12 waits" });
  expect(usePageQuotes.getState().byKey.get(QUOTE_KEY)).toEqual([{ path: "index.html", text: "Order #12 waits" }]);
  expect(on(host)).toBe(false);
  expect(frame.quoting()).toEqual([true, false]);
  // The page stops marking items: the button goes.
  await frame.say({ type: "mandate.page.quotable", any: false });
  expect(button(host, "Quote")).toBeUndefined();
});

test("Esc in the page or the app, and Quote pressed again end the mode", async () => {
  usePageQuotes.setState({ byKey: new Map() });
  onCleanup(() => usePageQuotes.setState({ byKey: new Map() }));
  serve({ state: state(1), versions: [version(1, "<div data-quote='x'>x</div>")] });
  const host = await render();
  const frame = await pageFrame(host);
  await frame.say({ type: "mandate.page.quotable", any: true });
  await press(button(host, "Quote"));
  await frame.say({ type: "mandate.page.quoteEnd" });
  expect(on(host)).toBe(false);
  await press(button(host, "Quote"));
  await act(async () => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(on(host)).toBe(false);
  await press(button(host, "Quote"));
  expect(on(host)).toBe(true);
  await press(button(host, "Quote"));
  expect(on(host)).toBe(false);
  expect(frame.quoting()).toEqual([true, false, true, false, true, false]);
  // Nothing picked meanwhile.
  expect(usePageQuotes.getState().byKey.has(QUOTE_KEY)).toBe(false);
});

test("a new version of the page ends the mode, and its frame says again whether it marks an item", async () => {
  usePageQuotes.setState({ byKey: new Map() });
  onCleanup(() => usePageQuotes.setState({ byKey: new Map() }));
  serve({ state: state(1), versions: [version(1, "<div data-quote='x'>v1</div>"), version(2, "<p>v2</p>")] });
  const host = await render();
  const frame = await pageFrame(host);
  await frame.say({ type: "mandate.page.quotable", any: true });
  await press(button(host, "Quote"));
  await act(async () => { useAgentPageStore.getState().applyState(state(2)); });
  await settleUntil(() => liveFrame(host)?.getAttribute("srcdoc")?.includes("v2") ?? false, "() => srcdoc includes v2");
  expect(button(host, "Quote")).toBeUndefined();
});

test("with 3 quotes in the composer Quote is disabled and says why", async () => {
  usePageQuotes.setState({ byKey: new Map([[QUOTE_KEY, ["a", "b", "c"].map((text) => ({ path: "index.html", text }))]]) });
  onCleanup(() => usePageQuotes.setState({ byKey: new Map() }));
  serve({ state: state(1), versions: [version(1, "<div data-quote='x'>x</div>")] });
  const host = await render();
  const frame = await pageFrame(host);
  await frame.say({ type: "mandate.page.quotable", any: true });
  const quote = button(host, "Quote")!;
  expect(quote.disabled).toBe(true);
  expect(quote.getAttribute("title")).toBe("Up to 3 quotes");
});

test("on a phone a quote picked brings the chat back", async () => {
  usePageQuotes.setState({ byKey: new Map() });
  onCleanup(() => usePageQuotes.setState({ byKey: new Map() }));
  onCleanup(fakePhoneWidth());
  useAgentPageUi.setState({ narrow: true, narrowView: "side", open: true });
  serve({ state: state(1), versions: [version(1, "<div data-quote='x'>x</div>")] });
  const host = await render();
  const frame = await pageFrame(host);
  await frame.say({ type: "mandate.page.quotable", any: true });
  await press(button(host, "Quote"));
  await frame.say({ type: "mandate.page.quote", text: "Frost warning" });
  expect(useAgentPageUi.getState().narrowView).toBe("chat");
  expect(usePageQuotes.getState().byKey.get(QUOTE_KEY)).toEqual([{ path: "index.html", text: "Frost warning" }]);
});

test("leaving the page while quoting ends the mode: back on it, the page is the page's again", async () => {
  usePageQuotes.setState({ byKey: new Map() });
  onCleanup(() => usePageQuotes.setState({ byKey: new Map() }));
  serve({ state: state(1), versions: [version(1, "<div data-quote='x'>x</div>")] });
  // As the app keeps the page while another one shows (shell/KeptPage).
  const kept = (mode: "visible" | "hidden") => (
    <Activity mode={mode}><PageShownContext.Provider value={mode === "visible"}><AgentPagePane name="Juno" threadId="thr_g" /></PageShownContext.Provider></Activity>
  );
  mounted = await mountAsync(kept("visible"), { path: "/agent" });
  const host = mounted.host;
  const frame = await pageFrame(host);
  await frame.say({ type: "mandate.page.quotable", any: true });
  await press(button(host, "Quote"));
  expect(on(host)).toBe(true);
  await act(async () => { mounted!.rerender(kept("hidden")); });
  await act(async () => { mounted!.rerender(kept("visible")); });
  expect(on(host)).toBe(false);
  expect(frame.quoting().at(-1)).toBe(false);
  // A quote the page posts now is not taken.
  await frame.say({ type: "mandate.page.quote", text: "Late" });
  expect(usePageQuotes.getState().byKey.has(QUOTE_KEY)).toBe(false);
});

// A row in the order the person dragged it into closes, reopens and
// falls back by that order: the tabs as drawn, any kind.
test("in a reordered row Tasks closed with nothing shown before it goes to the tab on its left as drawn", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  useAgentPageUi.setState({ tabs: ["tasks", "notes", "canvas:cnv_a"], active: "tasks", recent: [], order: ["notes", "canvas:cnv_a", "tasks"] });
  const host = await render();
  await settleUntil(() => host.querySelector("[data-tasks-tab]") !== null, "the Tasks tab");
  await closeTabIn(host, "[data-tasks-tab]");
  expect(useAgentPageUi.getState().active).toBe("canvas:cnv_a");
});

test("in a reordered row Tasks from Reopen comes back where it stood, and a canvas after the tabs dragged comes back after the one before it", async () => {
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  // Canvases b and c were opened after the drag: not in the order.
  useAgentPageUi.setState({ tabs: ["tasks", "notes", "canvas:cnv_a", "canvas:cnv_b", "canvas:cnv_c"], active: "page", order: ["notes", "tasks", "canvas:cnv_a"] });
  const host = await render();
  await settleUntil(() => host.querySelector("[data-tasks-tab]") !== null, "the Tasks tab");
  await closeTabIn(host, "[data-tasks-tab]");
  let rows = await openReopen(host);
  await act(async () => { rows[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => host.querySelector("[data-tasks-tab]") !== null, "Tasks is back");
  expect(tabNames(host)).toEqual(["Page", "Notes", "Tasks", "Canvas", "Canvas", "Canvas"]);
  await closeTabIn(host, '[data-canvas-tab="cnv_c"]');
  rows = await openReopen(host);
  await act(async () => { rows[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  const canvases = () => [...host.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Page tabs"] [data-canvas-tab]')].map((tab) => tab.dataset.canvasTab);
  await settleUntil(() => canvases().length === 3, "the canvas is back");
  expect(canvases()).toEqual(["cnv_a", "cnv_b", "cnv_c"]);
});

test("in a reordered row a thread tab closed here and opened again later comes last", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "page", order: ["thread:thr_ci", "canvas:cnv_a"] });
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab");
  expect(tabNames(host)).toEqual(["Page", "CI speed-up", "Canvas"]);
  await closeTabIn(host, '[data-thread-tab="thr_ci"][role="tab"]');
  await settleUntil(() => threadTabEl(host, "thr_ci") === null, "the thread tab goes");
  await act(async () => { await openThreadBeside("thr_ci"); });
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab is back");
  expect(tabNames(host)).toEqual(["Page", "Canvas", "CI speed-up"]);
});

test("in a reordered row a shown thread tab closed elsewhere falls back to the tab before it as drawn", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci"), threadTab("thr_docs")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "thread:thr_docs", recent: [], order: ["thread:thr_ci", "canvas:cnv_a", "thread:thr_docs"] });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-slot="thread-tab-title"]')?.textContent === "Docs layout", "the docs thread shows");
  threadTabsServed = threadTabsServed.filter((t) => t.threadId !== "thr_docs");
  await act(async () => { useThreadTabsStore.getState().changed(); });
  await settleUntil(() => threadTabEl(host, "thr_docs") === null, "its tab goes");
  expect(useAgentPageUi.getState().active).toBe("canvas:cnv_a");
});

test("a drop before the thread tabs have come keeps a thread's saved place", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a", "canvas:cnv_b"], active: "page", order: ["canvas:cnv_a", "thread:thr_ci", "canvas:cnv_b"] });
  // The list not read yet (as on a page just loaded).
  useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
  const radixGlobals = globalThis as { DOMRect?: unknown };
  if (!radixGlobals.DOMRect) {
    radixGlobals.DOMRect = (window as unknown as { DOMRect: unknown }).DOMRect;
    onCleanup(() => { delete radixGlobals.DOMRect; });
  }
  const host = await render();
  useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
  const canvasA = host.querySelector<HTMLElement>('[data-canvas-tab="cnv_a"]')!;
  await act(async () => { canvasA.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"] [role="menuitem"]')];
  await settleUntil(() => items().length === 2, "the tab's menu");
  await act(async () => { items()[1]!.click(); });
  // As the same move once the list has come: b never moved, so the thread stays before it.
  expect(useAgentPageUi.getState().order).toEqual(["thread:thr_ci", "canvas:cnv_b", "canvas:cnv_a"]);
  await settleRounds(3);
});

test("after a drag, a tab opened later comes last, whatever its kind", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  useAgentPageUi.setState({ tabs: ["tasks", "canvas:cnv_a"], active: "page", order: ["canvas:cnv_a", "tasks"] });
  const host = await render();
  await settleUntil(() => host.querySelector("[data-tasks-tab]") !== null, "the Tasks tab");
  await act(async () => { await openThreadBeside("thr_ci"); });
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab");
  await act(async () => { useAgentPageUi.getState().openNotes(); });
  await settleUntil(() => host.querySelector("[data-notes-tab]") !== null, "the Notes tab");
  expect(tabNames(host)).toEqual(["Page", "Canvas", "Tasks", "CI speed-up", "Notes"]);
  expect(useAgentPageUi.getState().order).toEqual(["canvas:cnv_a", "tasks", "thread:thr_ci", "notes"]);
});

test("after a drag, a thread tab being closed keeps its place until the server lets it go, and one closed elsewhere comes last when opened again", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci"), threadTab("thr_docs")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a"], active: "page", order: ["thread:thr_ci", "canvas:cnv_a", "thread:thr_docs"] });
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_docs") !== null, "the thread tabs");
  let release = () => {};
  threadTabWrites = new Promise<void>((resolve) => { release = resolve; });
  await closeTabIn(host, '[data-thread-tab="thr_ci"][role="tab"]');
  await settleRounds(3);
  expect(tabNames(host)).toEqual(["Page", "CI speed-up", "Canvas", "Docs layout"]);
  await act(async () => { release(); });
  await settleUntil(() => threadTabEl(host, "thr_ci") === null, "the thread tab goes");
  threadTabWrites = null;
  // Closed on another device.
  threadTabsServed = threadTabsServed.filter((t) => t.threadId !== "thr_docs");
  await act(async () => { useThreadTabsStore.getState().changed(); });
  await settleUntil(() => threadTabEl(host, "thr_docs") === null, "the docs tab goes");
  await act(async () => { await openThreadBeside("thr_docs"); });
  await settleUntil(() => threadTabEl(host, "thr_docs") !== null, "the docs tab is back");
  expect(tabNames(host)).toEqual(["Page", "Canvas", "Docs layout"]);
});

test("a tab moved while a thread from Reopen is on its way stays moved", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci")];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a", "canvas:cnv_b"], active: "page", order: ["thread:thr_ci", "canvas:cnv_a", "canvas:cnv_b"] });
  const radixGlobals = globalThis as { DOMRect?: unknown };
  if (!radixGlobals.DOMRect) {
    radixGlobals.DOMRect = (window as unknown as { DOMRect: unknown }).DOMRect;
    onCleanup(() => { delete radixGlobals.DOMRect; });
  }
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab");
  await closeTabIn(host, '[data-thread-tab="thr_ci"][role="tab"]');
  await settleUntil(() => threadTabEl(host, "thr_ci") === null, "the thread tab goes");
  let release = () => {};
  threadTabWrites = new Promise<void>((resolve) => { release = resolve; });
  const rows = await openReopen(host);
  await act(async () => { rows[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  // Meanwhile canvas a goes right, past b.
  await act(async () => { host.querySelector<HTMLElement>('[data-canvas-tab="cnv_a"]')!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"] [role="menuitem"]')];
  await settleUntil(() => items().length === 2, "the tab's menu");
  await act(async () => { items()[1]!.click(); });
  await act(async () => { release(); });
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab is back");
  expect(tabNames(host)).toEqual(["Page", "CI speed-up", "Canvas", "Canvas"]);
  expect(useAgentPageUi.getState().order).toEqual(["thread:thr_ci", "canvas:cnv_b", "canvas:cnv_a"]);
  await settleRounds(3);
});

test("a thread tab closed before the first drag comes back from Reopen after the tab that stood before it as drawn", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  threadTabsServed = [threadTab("thr_ci")];
  useAgentPageUi.setState({ tabs: ["notes", "canvas:cnv_a"], active: "page" });
  const radixGlobals = globalThis as { DOMRect?: unknown };
  if (!radixGlobals.DOMRect) {
    radixGlobals.DOMRect = (window as unknown as { DOMRect: unknown }).DOMRect;
    onCleanup(() => { delete radixGlobals.DOMRect; });
  }
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null && host.querySelector("[data-notes-tab]") !== null, "the tabs");
  expect(tabNames(host)).toEqual(["Page", "Notes", "CI speed-up", "Canvas"]);
  await closeTabIn(host, '[data-thread-tab="thr_ci"][role="tab"]');
  await settleUntil(() => threadTabEl(host, "thr_ci") === null, "the thread tab goes");
  // The first drag: Notes right, past the canvas.
  await act(async () => { host.querySelector<HTMLElement>("[data-notes-tab]")!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"] [role="menuitem"]')];
  await settleUntil(() => items().length === 2, "the tab's menu");
  await act(async () => { items()[1]!.click(); });
  expect(tabNames(host)).toEqual(["Page", "Canvas", "Notes"]);
  await settleRounds(3);
  const rows = await openReopen(host);
  await act(async () => { rows[0]!.click(); await new Promise((r) => setTimeout(r, 0)); });
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab is back");
  expect(tabNames(host)).toEqual(["Page", "Canvas", "Notes", "CI speed-up"]);
});

test("server tabs that came while the panel was not drawn go last in the order they came", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  // Both came while the page was elsewhere: the reply first, the thread later.
  replyTabsServed = [{ ...replyTab("rtab_1", "Photo import done."), createdAt: "2026-10-20T10:06:00.000Z" }];
  threadTabsServed = [{ threadId: "thr_ci", createdAt: "2026-10-20T10:09:00.000Z" }];
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a", "canvas:cnv_b"], active: "page", order: ["canvas:cnv_b", "canvas:cnv_a"] });
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null && host.querySelector('[data-reply-tab="rtab_1"]') !== null, "the server's tabs");
  await settleUntil(() => (useAgentPageUi.getState().order ?? []).length === 4, "the order has them");
  expect(tabNames(host)).toEqual(["Page", "Canvas", "Canvas", "Photo import done.", "CI speed-up"]);
});

test("on a page just loaded, server tabs that came unseen go in the order they came though their lists answer in another", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  replyTabsServed = [{ ...replyTab("rtab_1", "Photo import done."), createdAt: "2026-10-20T10:06:00.000Z" }];
  threadTabsServed = [{ threadId: "thr_ci", createdAt: "2026-10-20T10:09:00.000Z" }];
  let release = () => {};
  replyTabReads = new Promise<void>((resolve) => { release = resolve; });
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a", "canvas:cnv_b"], active: "page", order: ["canvas:cnv_b", "canvas:cnv_a"] });
  const host = await render();
  await settleUntil(() => threadTabEl(host, "thr_ci") !== null, "the thread tab, its list first");
  await settleRounds(3);
  await act(async () => { release(); });
  await settleUntil(() => host.querySelector('[data-reply-tab="rtab_1"]') !== null, "the reply tab");
  await settleUntil(() => (useAgentPageUi.getState().order ?? []).length === 4, "the order has them");
  expect(tabNames(host)).toEqual(["Page", "Canvas", "Canvas", "Photo import done.", "CI speed-up"]);
});

test("after a drag, the panel's own tabs opened while a server list has not come still go last in the order opened", async () => {
  seedThreads();
  serve({ state: state(4), versions: [version(4, "<p>v4</p>")] });
  // The reply list never answers (a slow or failed request).
  replyTabReads = new Promise<void>(() => {});
  useAgentPageUi.setState({ tabs: ["canvas:cnv_a", "canvas:cnv_b"], active: "page", order: ["canvas:cnv_b", "canvas:cnv_a"] });
  const host = await render();
  await settleUntil(() => host.querySelector('[data-canvas-tab="cnv_a"]') !== null, "the canvas tabs");
  await act(async () => { useAgentPageUi.getState().openCalendar(); });
  await settleRounds(2);
  await act(async () => { useAgentPageUi.getState().openNotes(); });
  await settleUntil(() => host.querySelector("[data-notes-tab]") !== null && host.querySelector("[data-calendar-tab]") !== null, "Calendar and Notes");
  expect(tabNames(host)).toEqual(["Page", "Canvas", "Canvas", "Calendar", "Notes"]);
  expect(useAgentPageUi.getState().order).toEqual(["canvas:cnv_b", "canvas:cnv_a", "calendar", "notes"]);
});
