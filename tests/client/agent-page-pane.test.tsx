import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { AgentPagePane } from "@/routes/global/page/AgentPagePane";
import { AGENT_PAGE_ID } from "@/routes/global/page/AgentPageFrame";
import { resetAgentPageStore, useAgentPageStore } from "@/store/agent-page";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useAgentChatStore } from "@/store/agent-chat";
import { formatClockMinutes } from "@/lib/format";
import type { AgentPageSourceDto, AgentPageStateDto, AgentPageVersionDto } from "@shared/api/agent-page";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settleUntil, type Mounted } from "../helpers/mount.js";
import { CanvasOpenerProvider } from "@/routes/canvas/CanvasOpenerProvider";
import { useLocation } from "react-router";

let at = "";
function Where() {
  at = useLocation().pathname;
  return null;
}

const sendMessage = useAgentChatStore.getState().sendMessage;
afterEach(() => {
  runCleanups();
  resetAgentPageStore();
  useAgentPageUi.setState({ open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat" });
  useAgentChatStore.setState({ sendMessage });
});

const AT = "2026-10-20T10:06:00.000Z";
const state = (revision: number | null, write: AgentPageStateDto["write"] = null): AgentPageStateDto => ({
  latest: revision === null ? null : { revision, writer: "agent", createdAt: AT },
  write
});
const version = (revision: number, html: string): AgentPageVersionDto => ({ revision, html, writer: "agent", createdAt: AT });
const SOURCES: AgentPageSourceDto[] = [
  { name: "prom-5xx", run: "curl …", everyMs: 300_000, cwd: null, paused: false, lastRunAt: "2026-10-20T10:05:00.000Z", lastError: null },
  { name: "litellm-groups", run: "x", everyMs: 3_600_000, cwd: null, paused: false, lastRunAt: "2026-10-20T09:00:00.000Z", lastError: "exit 1: token expired" }
];

/** The server's page; every request asked of it. */
function serve(page: { state: AgentPageStateDto; versions?: AgentPageVersionDto[]; sources?: AgentPageSourceDto[] }) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let sources = page.sources ?? [];
  mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    const method = call.init?.method ?? "GET";
    const body = call.init?.body ? JSON.parse(String(call.init.body)) : null;
    requests.push({ method, path, body });
    if (path === "/api/agent-page") return jsonResponse(page.state);
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

test("the empty state asks Your agent in the chat", async () => {
  serve({ state: state(null) });
  const sent = mock(async (_scope: unknown, _content: unknown) => {});
  useAgentChatStore.setState({ sendMessage: sent as unknown as typeof sendMessage });
  const host = await render();
  await settleUntil(() => text(host).includes("hasn't made a page yet"), "() => text(host).includes('hasn't made a page yet')");
  expect(text(host)).toContain("Juno hasn't made a page yet.");
  await act(async () => { button(host, "Ask Juno to make its page")!.click(); });
  expect(sent.mock.calls).toStrictEqual([[{ type: "global", threadId: "thr_g" }, "Make your page."]]);
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
  await settleUntil(() => host.querySelector("iframe") !== null, "() => host.querySelector('iframe') !== null");
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
  // The reasons written for Your agent are said in the user's words; any other as it is.
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
    `prom-5xxevery 5m · ran ${formatClockMinutes("2026-10-20T10:05:00.000Z")} · okcurl …PauseRemove`,
    `litellm-groupsevery 1h · failed ${formatClockMinutes("2026-10-20T09:00:00.000Z")} · exit 1: token expiredxPauseRemove`
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
    ["PATCH", "/api/agent-page/sources/prom-5xx", { paused: true }],
    ["PATCH", "/api/agent-page/sources/prom-5xx", { paused: false }],
    ["DELETE", "/api/agent-page/sources/litellm-groups", null]
  ]);
});

test("a new version waits while a page field has focus, and typed values come back by id", async () => {
  serve({ state: state(1), versions: [version(1, "<input id=\"who\">v1"), version(2, "<input id=\"who\">v2")] });
  const host = await render();
  await settleUntil(() => host.querySelector("iframe")?.getAttribute("srcdoc")?.includes("v1") ?? false, "() => host.querySelector('iframe')?.getAttribute('srcdoc')?.");
  const fromFrame = (data: Record<string, unknown>) => act(async () => {
    const frame = host.querySelector("iframe")!;
    window.dispatchEvent(new window.MessageEvent("message", { data: { ...data, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  await fromFrame({ type: "mandate.page.focus", inField: true });
  await fromFrame({ type: "mandate.page.fields", values: { who: "ops-readonly" } });
  await act(async () => { useAgentPageStore.getState().applyState(state(2)); });
  await settleUntil(() => useAgentPageStore.getState().version?.revision === 2, "() => useAgentPageStore.getState().version?.revision === 2");
  // Still the old frame, and a way to take the new one.
  expect(host.querySelector("iframe")!.getAttribute("srcdoc")).toContain("v1");
  expect(button(host, "New version — Reload") !== undefined).toBe(true);
  // Focus moving to another field keeps it.
  await fromFrame({ type: "mandate.page.focus", inField: true });
  expect(host.querySelector("iframe")!.getAttribute("srcdoc")).toContain("v1");
  // Leaving the field lets it in; its load gives back what was typed.
  await fromFrame({ type: "mandate.page.focus", inField: false });
  const frame = host.querySelector("iframe")!;
  expect(frame.getAttribute("srcdoc")).toContain("v2");
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => { frame.dispatchEvent(new window.Event("load")); });
  expect(posted).toContainEqual({ type: "mandate.page.restore", values: { who: "ops-readonly" } });
  expect(button(host, "New version — Reload") !== undefined).toBe(false);
});

test("Reload takes the new version at once; a reconnect reads the page again", async () => {
  const requests = serve({ state: state(1), versions: [version(1, "<input id=\"who\">v1"), version(2, "<input id=\"who\">v2")] });
  const host = await render();
  await settleUntil(() => host.querySelector("iframe") !== null, "() => host.querySelector('iframe') !== null");
  const frame = host.querySelector("iframe")!;
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.focus", inField: true, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  await act(async () => { useAgentPageStore.getState().applyState(state(2)); });
  await settleUntil(() => button(host, "New version — Reload") !== undefined, "() => button(host, 'New version — Reload') !== undefined");
  await act(async () => { button(host, "New version — Reload")!.click(); });
  expect(host.querySelector("iframe")!.getAttribute("srcdoc")).toContain("v2");
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
    const frame = host.querySelector("iframe")!;
    const posted: Array<Record<string, unknown>> = [];
    (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
    await act(async () => {
      window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.get", name, reqId, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
    });
    await settleUntil(() => posted.some((m) => m.reqId === reqId), `the answer to ${name}`);
    return posted.find((m) => m.reqId === reqId);
  };
  let host = await render();
  await settleUntil(() => host.querySelector("iframe") !== null, "the frame");
  expect(await ask(host, "threads", 1)).toMatchObject({ ok: true, data: { value: 1 } });
  expect(await ask(host, "ghost", 2)).toMatchObject({ ok: true, data: { value: null, at: null, error: "no such source" } });
  // The pane goes (another page, a phone's Chat tab) and comes back.
  mounted!.unmount();
  threads = 2;
  host = await render();
  await settleUntil(() => host.querySelector("iframe") !== null, "the frame again");
  expect(await ask(host, "threads", 3)).toMatchObject({ ok: true, data: { value: 2 } });
});

test("what the user typed survives the pane going and coming back", async () => {
  serve({ state: state(1), versions: [version(1, "<input id=\"who\">")] });
  let host = await render();
  await settleUntil(() => host.querySelector("iframe") !== null, "the frame");
  await act(async () => {
    const frame = host.querySelector("iframe")!;
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.fields", values: { who: "ops-readonly" }, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  mounted!.unmount();
  host = await render();
  await settleUntil(() => host.querySelector("iframe") !== null, "the frame again");
  const frame = host.querySelector("iframe")!;
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => { frame.dispatchEvent(new window.Event("load")); });
  expect(posted).toContainEqual({ type: "mandate.page.restore", values: { who: "ops-readonly" } });
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
  await settleUntil(() => host.querySelector("iframe") !== null, "the frame");
  const frame = host.querySelector("iframe")!;
  const fromFrame = (data: Record<string, unknown>) => act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { ...data, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  await fromFrame({ type: "mandate.page.fields", values: { who: "ops-readonly" } });
  await fromFrame({ type: "mandate.page.submit", value: { who: "ops-readonly" }, reqId: 1 });
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
  await settleUntil(() => host.querySelector("iframe") !== null, "the frame");
  const frame = host.querySelector("iframe")!;
  const posted: Array<Record<string, unknown>> = [];
  (frame.contentWindow as Window).postMessage = ((message: Record<string, unknown>) => { posted.push(message); }) as Window["postMessage"];
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.submit", value: 1, reqId: 1, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  await settleUntil(() => posted.some((m) => m.type === "mandate.page.clear"), "the clear");
});

// On a desktop the page is the first tab of the side's row (a canvas opens
// beside it); its own toolbar sits under the row.
test("on a desktop the page is the first tab of a row with Hide chat and Hide panel, its toolbar under the row", async () => {
  serve({ state: state(4, { taskId: "task_a", title: "Put usage first", status: "failed", startedAt: AT, finishedAt: "2026-10-20T10:07:00.000Z", revision: null, error: "Mandate restarted while it ran." }), versions: [version(4, "<p>v4</p>")], sources: SOURCES });
  const host = await render();
  await settleUntil(() => host.querySelector("iframe") !== null, "the page's frame");
  const row = host.querySelector<HTMLElement>('[role="tablist"][aria-label="Page tabs"]')!.parentElement!;
  expect(host.querySelector('[role="tablist"][aria-label="Page tabs"] [role="tab"]')!.textContent).toBe("Page");
  expect([button(row, "Hide chat") !== undefined, button(row, "Hide panel") !== undefined]).toEqual([true, true]);
  // The toolbar is under the row, not in it.
  const failed = host.querySelector('[data-slot="page-failed"]')!;
  expect(row.contains(failed)).toBe(false);
  expect(host.querySelector('[data-slot="page-toolbar"]')!.contains(failed)).toBe(true);
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
  await settleUntil(() => host.querySelector("iframe") !== null, "the page's frame");
  const frame = host.querySelector("iframe")!;
  const fromFrame = (path: string) => act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "mandate.page.open", path, pageId: AGENT_PAGE_ID }, source: frame.contentWindow as Window }));
  });
  await fromFrame("/canvas/cnv_RelNotes001");
  expect([asked, at]).toEqual([["cnv_RelNotes001"], "/agent"]);
  await fromFrame("/threads/thr_1");
  expect(at).toBe("/threads/thr_1");
});
