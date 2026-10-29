import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../fake-phone-width";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { resetBackgroundTasksStore } from "../helpers/subagent-client.js";
import { GlobalAgentPage } from "@/routes/global/GlobalAgentPage";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useAgentChatStore, type AgentContextUsage } from "@/store/agent-chat";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import type { GlobalAgentDto } from "@shared/api/global-agent";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { resetAgentPageStore } from "@/store/agent-page";
import { reducedMotion } from "../helpers/motion.js";
import { resetCanvasTitles } from "@/store/canvas-titles";

// The layout at once: how the side moves is split-row.test.tsx's.
beforeEach(() => { reducedMotion(); });

/** What the server lists as Your agent's background tasks. */
let globalTasks: BackgroundTaskDto[] = [];
/** What its conversation holds, and the canvases the server has. */
let chatMessages: unknown[] = [];
const canvasDocs = new Map<string, Record<string, unknown>>();

afterEach(() => {
  runCleanups();
  useGlobalAgentStore.setState({ agent: null, handoffs: new Map() });
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  resetBackgroundTasksStore();
  globalTasks = [];
  chatMessages = [];
  canvasDocs.clear();
  resetCanvasTitles();
  resetAgentPageStore();
  useAgentPageUi.setState({ open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat", tabs: [], active: "page" });
  localStorage.removeItem("mandate.agent-page.v1");
});

const agent = (over: Partial<GlobalAgentDto>): GlobalAgentDto => ({ threadId: "thr_g", name: "", named: false, unread: false, voiceConfigured: true, lastVisibleSeq: 0, questions: [], ...over });

/** `threadGate`: the thread page answers only once it resolves; `contextUsage`:
 *  what the conversation's last call measured. */
function serve(calls: Array<{ url: string; body: unknown }>, threadGate?: Promise<void>, contextUsage: AgentContextUsage | null = null) {
  let saved: string | null = null;
  mockFetch((call) => {
    const body = call.init?.body ? JSON.parse(String(call.init.body)) : null;
    calls.push({ url: call.url, body });
    if (call.url.includes("/api/settings/config")) {
      saved = body.agent.globalAgentName;
      return jsonResponse({ ok: true, agent: { globalAgentName: saved } });
    }
    // The agent as the server holds it: named once a name was saved.
    if (call.url.endsWith("/api/agents/global")) return jsonResponse({ agent: agent(saved ? { name: saved, named: true } : {}) });
    if (call.url.includes("/api/agents/global/handoffs")) return jsonResponse({ handoffs: [] });
    // The server answers with the same agent, now read.
    if (call.url.includes("/api/agents/global/seen")) return jsonResponse({ agent: { ...useGlobalAgentStore.getState().agent!, unread: false } });
    if (call.url.includes("/api/agents/threads/thr_g/tasks")) return jsonResponse({ tasks: globalTasks });
    const titles = /\/api\/canvases\/titles\?ids=([^&]*)/.exec(call.url);
    if (titles) {
      return jsonResponse({ canvases: decodeURIComponent(titles[1]!).split(",").flatMap((id) => {
        const doc = canvasDocs.get(id);
        return doc ? [{ id, title: doc.title, kind: doc.kind }] : [];
      }) });
    }
    const doc = /\/api\/canvas\/([A-Za-z0-9_-]+)$/.exec(call.url);
    if (doc) return canvasDocs.has(doc[1]!) ? jsonResponse({ canvas: canvasDocs.get(doc[1]!) }) : jsonResponse({ error: "canvas not found" }, 404);
    if (call.url.includes("/api/agents/threads/thr_g")) {
      const page = () => jsonResponse({ thread: { id: "thr_g" }, messages: chatMessages, hasMore: false, contextUsage, activeWake: null, readAt: null });
      return threadGate ? threadGate.then(page) : page();
    }
    return jsonResponse({});
  });
}

test("unnamed: the guide previews the name as typed; a blank Start saves Mandate and opens the conversation", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  serve(calls);
  useGlobalAgentStore.getState().setAgent(agent({}));
  const { host } = await mountAsync(<GlobalAgentPage />, { path: "/agent" });
  expect(host.textContent).toContain("Hi, I'm Mandate.");
  // What it says it does is what it does: it writes the
  // message itself, and sends work to a thread without asking first.
  expect(host.textContent).toContain("Tell a worker what to do. I'll pass it on.");
  expect(host.textContent).toContain("Hand me something new. I'll send it to the right thread and tell you where it went.");
  expect(host.textContent).not.toContain("ask you first");
  expect(host.textContent).not.toContain("in your words");
  const input = host.querySelector<HTMLInputElement>("#global-agent-name")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, "Friday");
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("Hi, I'm Friday.");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, "   ");
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  });
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-slot="global-agent-start"]')!.click(); });
  await settleUntil(() => calls.some((c) => c.url.includes("/api/settings/config")), "the name was saved");
  expect(calls.find((c) => c.url.includes("/api/settings/config"))!.body).toEqual({ agent: { globalAgentName: "Mandate" } });
  // The header title is a portal into the shell; the empty state is the page's own.
  await settleUntil(() => (host.textContent ?? "").includes("Ask what's going on, or tell a worker what to do."), "the conversation opened");
  expect(host.textContent).not.toContain("What should I be called?");
});

test("named: the page shows the conversation with its empty state, and marks it seen once shown", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let answer!: () => void;
  serve(calls, new Promise<void>((resolve) => { answer = resolve; }));
  useGlobalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, lastVisibleSeq: 4 }));
  const { host } = await mountAsync(<GlobalAgentPage />, { path: "/agent" });
  await settle();
  // Not seen before the conversation is on screen.
  expect(calls.some((c) => c.url.includes("/api/agents/threads/thr_g"))).toBe(true);
  expect(calls.some((c) => c.url.includes("/api/agents/global/seen"))).toBe(false);
  answer();
  await settleUntil(() => (host.textContent ?? "").includes("I can see every thread and worker."), "the empty state");
  expect(host.textContent).toContain("Jarvis");
  await settleUntil(() => calls.some((c) => c.url.includes("/api/agents/global/seen")), "marked seen");
  expect(calls.find((c) => c.url.includes("/api/agents/global/seen"))!.body).toEqual({ seq: 4 });
});

test("voice not set up: the guide points to Settings › Voice instead", async () => {
  serve([]);
  useGlobalAgentStore.getState().setAgent(agent({ voiceConfigured: false }));
  const { host } = await mountAsync(<GlobalAgentPage />, { path: "/agent" });
  expect(host.textContent).toContain("Voice isn't set up yet.");
  expect(host.querySelector('a[href="/settings?tab=voice"]')?.textContent).toBe("Settings › Voice");
});

test("a reply that lands while the page is open and visible is marked seen too", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  serve(calls);
  useGlobalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, lastVisibleSeq: 4 }));
  const { host } = await mountAsync(<GlobalAgentPage />, { path: "/agent" });
  await settleUntil(() => (host.textContent ?? "").includes("Ask what's going on"), "the conversation");
  const seen = () => calls.filter((c) => c.url.includes("/api/agents/global/seen")).length;
  await settleUntil(() => seen() === 1, "marked seen on open");
  await settle();
  expect(seen()).toBe(1);
  // A handoff came back: the server says unread again, with no new row.
  await act(async () => { useGlobalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, lastVisibleSeq: 4 })); });
  await settleUntil(() => seen() === 2, "marked seen again");
  expect(useGlobalAgentStore.getState().agent?.unread).toBe(false);
});

test("the page reads the cards it shows on open and again when the event stream comes back, and asks for nothing by moment", async () => {
  const sentAt = "2026-10-05T10:00:00.000Z";
  const sent = { id: "hof_1", kind: "feature", state: "delivered", text: "x", spoken: false, featureId: "feat_1", featureName: "release",
    ownerThreadTitle: "Docs overhaul", threadId: "thr_w", threadTitle: null, newThreadTitle: null, reply: null, reason: null, stop: null,
    createdAt: sentAt, updatedAt: sentAt, repliedAt: null };
  let reconnected = false;
  const reads: string[] = [];
  mockFetch((call) => {
    if (call.url.includes("/api/agents/global/handoffs")) {
      reads.push(call.url);
      return jsonResponse({ handoffs: [reconnected ? { ...sent, state: "failed", stop: "archived", reason: "the worker was archived", updatedAt: "2026-10-05T10:05:00.000Z" } : sent] });
    }
    if (call.url.includes("/api/agents/threads/thr_g")) {
      return jsonResponse({ thread: { id: "thr_g" }, hasMore: false, contextUsage: null, activeWake: null, readAt: null, messages: [
        { id: "m1", threadId: "thr_g", seq: 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1", createdAt: sentAt,
          content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c1", toolName: "message_feature", args: {} }] } },
        { id: "m2", threadId: "thr_g", seq: 2, role: "tool", source: "self", sourceThreadId: null, wakeId: "w1", createdAt: sentAt,
          content: { type: "tool_result", toolCallId: "c1", toolName: "message_feature", result: { handoff: sent } } }
      ] });
    }
    return jsonResponse({});
  });
  useGlobalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true }));
  const { host } = await mountAsync(<GlobalAgentPage />, { path: "/agent" });
  const card = () => host.querySelector('[data-slot="handoff-card"]');
  await settleUntil(() => card() !== null, "the card shows");
  // It reads exactly the handoffs its transcript shows.
  await settleUntil(() => reads.length === 1, "the shown handoffs were read");
  // A change published while the stream was down is not sent again: it reads them again.
  reconnected = true;
  await act(async () => { window.dispatchEvent(new CustomEvent("mandate:sse-open")); });
  await settleUntil(() => card()!.querySelector('[data-slot="handoff-reason"]')?.textContent === "the worker was archived", "the missed change shows on the card");
  expect(reads).toStrictEqual(["/api/agents/global/handoffs?ids=hof_1", "/api/agents/global/handoffs?ids=hof_1"]);
  // What comes back is a message in the conversation now: no row is built from a handoff.
  expect(host.querySelector('[data-slot="handoff-outcome"]') === null).toBe(true);
});

/** The page under a header's actions slot, as the shell draws it. */
async function withHeader(contextUsage: AgentContextUsage | null) {
  serve([], undefined, contextUsage);
  useGlobalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true }));
  const { host } = await mountAsync(
    <PaneHeaderSlotsProvider>
      <PaneHeaderActionsSlot />
      <GlobalAgentPage />
    </PaneHeaderSlotsProvider>,
    { path: "/agent" }
  );
  await settleUntil(() => useAgentChatStore.getState().threadsByScope.get("global:thr_g")?.loaded === true, "the conversation loaded");
  return host.querySelector<HTMLElement>('[data-slot="pane-actions"]')!;
}

const measured = { inputTokens: 102_000, budgetTokens: 250_000, updatedAt: "2026-09-13T00:00:00.000Z", source: "compression_budget" } as AgentContextUsage;

test("the header says how full the agent's context is, as a thread's does", async () => {
  const actions = await withHeader(measured);
  const pill = actions.querySelector<HTMLElement>("[aria-label]")!;
  expect(actions.textContent).toBe("Context 41%");
  expect(pill.getAttribute("aria-label")).toBe("Last successful agent call used 102k of 250k compression budget.");
  expect(pill.className).not.toContain("flex-col-reverse");
});

test("on a phone the figure takes the compact form, its meter under the number", async () => {
  onCleanup(fakePhoneWidth());
  const actions = await withHeader(measured);
  expect(actions.textContent).toBe("Context 41%");
  expect(actions.querySelector<HTMLElement>("[aria-label]")!.className).toContain("flex-col-reverse");
});

test("before a call has measured it, the header shows no figure", async () => {
  const actions = await withHeader(null);
  expect(actions.textContent).toBe("");
});

test("Your agent's page has a ⋯ once it has started a background task; its one item opens the list", async () => {
  const actions = await withHeader(null);
  await settleUntil(() => useBackgroundTasksStore.getState().byThread.has("thr_g"), "its tasks were read");
  // None started: no menu, for a menu with nothing in it would offer nothing.
  expect(actions.querySelector('[aria-label="Agent actions"]') === null).toBe(true);
  // Its first task, as the event stream brings it.
  act(() => useBackgroundTasksStore.getState().apply({
    id: "task_g1", kind: "subagent", parentThreadId: "thr_g", childThreadId: "thr_c_g1", type: "general", title: "Weekly summary",
    status: "running", stoppedBy: null, error: null,
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, seq: 2, exitCode: null, command: null, outputPath: null
  }));
  await settleUntil(() => actions.querySelector('[aria-label="Agent actions"]') !== null, "the ⋯ came");
  const trigger = actions.querySelector<HTMLElement>('[aria-label="Agent actions"]')!;
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((n) => n.textContent)).toEqual(["Background tasks"]);
  await act(async () => {
    items[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') !== null, "the list opened");
  expect(document.querySelector('[data-slot="background-tasks-popover"] [data-slot="background-tasks-counts"]')?.textContent).toBe("1 running");
});

test("Your agent's ⋯ pressed again while its list is open opens its menu alone: the list closes", async () => {
  globalTasks = [{
    id: "task_g2", kind: "subagent", parentThreadId: "thr_g", childThreadId: "thr_c_g2", type: "general", title: "Weekly summary",
    status: "finished", stoppedBy: null, error: null,
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), seq: 3, exitCode: null, command: null, outputPath: null
  }];
  const actions = await withHeader(null);
  await settleUntil(() => actions.querySelector('[aria-label="Agent actions"]') !== null, "the ⋯ came");
  const open = async () => {
    await act(async () => {
      actions.querySelector<HTMLElement>('[aria-label="Agent actions"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  };
  await act(async () => {
    (await open())[0]!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') !== null, "the list opened");
  expect((await open()).map((n) => n.textContent)).toEqual(["Background tasks"]);
  expect(document.querySelector('[data-slot="background-tasks-popover"]') === null).toBe(true);
});

// ── The page beside the chat ─────────────────────────────────────────────
// happy-dom lays nothing out: the row is told its width (as the split row's
// own tests do).
function measuredAs(width: number) {
  const proto = window.HTMLElement.prototype;
  const rect = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true, writable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, width, height: 600, right: width, bottom: 600, toJSON: () => ({}) }) as DOMRect
  });
  onCleanup(() => {
    if (rect) Object.defineProperty(proto, "getBoundingClientRect", rect); else delete (proto as unknown as Record<string, unknown>).getBoundingClientRect;
  });
}

let here = "";
let pageStep = false;
let go: (to: number) => void = () => {};
function Where() {
  const location = useLocation();
  const navigate = useNavigate();
  here = location.pathname;
  pageStep = (location.state as { agentPage?: boolean } | null)?.agentPage === true;
  go = (to) => { void navigate(to); };
  return null;
}

async function renderSplit({ width = 0, phone = false }: { width?: number; phone?: boolean } = {}) {
  if (phone) onCleanup(fakePhoneWidth());
  if (width) measuredAs(width);
  serve([]);
  useGlobalAgentStore.getState().setAgent(agent({ name: "Juno", named: true }));
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/home", "/agent"]}>
      <PaneHeaderSlotsProvider>
        <Where />
        <PaneHeaderActionsSlot />
        <GlobalAgentPage />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settleUntil(() => host.querySelector('[data-slot="agent-chat"]') !== null, "the split row");
  return host;
}
const chatShown = (host: HTMLElement) => !host.querySelector('[data-slot="agent-chat"]')!.className.split(/\s+/).includes("hidden");
const pageShown = (host: HTMLElement) => host.querySelector('[data-slot="agent-page"]') !== null;
const pageHasRow = (host: HTMLElement) => host.querySelector('[data-slot="agent-page"]')!.className.split(/\s+/).includes("flex-1");
const buttonIn = (root: ParentNode, label: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button, [role='tab']")).find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
const saved = () => (JSON.parse(localStorage.getItem("mandate.agent-page.v1") ?? "{}") as { state?: Record<string, unknown> }).state;

test("the page sits beside the chat and its open state, size and full screen are remembered", async () => {
  const host = await renderSplit({ width: 1200 });
  expect([chatShown(host), pageShown(host), pageHasRow(host)]).toEqual([true, true, false]);
  expect(host.querySelector('[data-slot="agent-page"]')!.getAttribute("aria-label")).toBe("Page");
  await act(async () => { buttonIn(host, "Hide chat")!.click(); });
  expect([chatShown(host), pageHasRow(host)]).toEqual([false, true]);
  expect(saved()).toEqual({ open: true, maximized: true, ratio: 0.5, tabs: [], active: "page" });
  await act(async () => { buttonIn(host, "Show chat")!.click(); });
  const separator = host.querySelector<HTMLElement>('[role="separator"]')!;
  expect(separator.getAttribute("aria-label")).toBe("Resize page");
  await act(async () => { separator.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })); });
  expect(saved()!.ratio).toBeGreaterThan(0.5);
  expect(saved()!.maximized).toBe(false);
});

test("closed, a Panel button opens it again", async () => {
  const host = await renderSplit({ width: 1200 });
  const actions = host.querySelector<HTMLElement>('[data-slot="pane-actions"]')!;
  expect(buttonIn(actions, "Panel") === undefined).toBe(true);
  await act(async () => { buttonIn(host, "Hide panel")!.click(); });
  expect([chatShown(host), pageShown(host)]).toEqual([true, false]);
  expect(saved()!.open).toBe(false);
  await act(async () => { buttonIn(actions, "Panel")!.click(); });
  expect([chatShown(host), pageShown(host)]).toEqual([true, true]);
  expect(saved()!.open).toBe(true);
});

test("a narrow row switches between Chat and Panel, a phone between Chat and Page; on a phone Back returns to Chat", async () => {
  const host = await renderSplit({ width: 600 });
  const actions = host.querySelector<HTMLElement>('[data-slot="pane-actions"]')!;
  expect([chatShown(host), pageShown(host)]).toEqual([true, false]);
  const tabs = () => Array.from(actions.querySelectorAll<HTMLElement>('[role="tab"]')).map((tab) => `${tab.textContent}:${tab.getAttribute("aria-selected")}`);
  // The side holds canvas tabs too on a desktop.
  expect(tabs()).toEqual(["Chat:true", "Panel:false"]);
  await act(async () => { buttonIn(actions, "Panel")!.click(); });
  expect([chatShown(host), pageShown(host), pageHasRow(host), tabs()]).toEqual([false, true, true, ["Chat:false", "Panel:true"]]);
  // Not a phone: no step in the history.
  expect(pageStep).toBe(false);
  await act(async () => { buttonIn(actions, "Chat")!.click(); });
  expect([chatShown(host), pageShown(host)]).toEqual([true, false]);
  runCleanups();
  reducedMotion();
  useAgentPageUi.setState({ narrow: false, narrowView: "chat" });

  const phone = await renderSplit({ width: 390, phone: true });
  const phoneActions = phone.querySelector<HTMLElement>('[data-slot="pane-actions"]')!;
  await act(async () => { buttonIn(phoneActions, "Page")!.click(); });
  await settleUntil(() => pageStep, "the page's step");
  expect([chatShown(phone), pageShown(phone), here]).toEqual([false, true, "/agent"]);
  // The page alone: canvases open full screen on a phone, so no tab row.
  expect(phone.querySelector('[aria-label="Page tabs"]') === null).toBe(true);
  expect(buttonIn(phone.querySelector('[data-slot="agent-page"]')!, "Hide page") === undefined).toBe(false);
  await act(async () => { go(-1); });
  await settleUntil(() => chatShown(phone), "back on the chat");
  expect([pageShown(phone), pageStep, here]).toEqual([false, false, "/agent"]);
});

test("a phone whose row is 720 px or wider still shows one side at a time", async () => {
  const host = await renderSplit({ width: 740, phone: true });
  const actions = host.querySelector<HTMLElement>('[data-slot="pane-actions"]')!;
  expect(Array.from(actions.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent)).toEqual(["Chat", "Page"]);
  expect([chatShown(host), pageShown(host)]).toEqual([true, false]);
});

// ── Canvases beside the chat ─────────────────────────────────────────────
const CANVAS = "cnv_RelNotes001";

test("a canvas in Your agent's chat opens as a tab beside it; Page stays the first tab, kept while the canvas shows", async () => {
  canvasDocs.set(CANVAS, {
    id: CANVAS, title: "Release report", kind: "report", html: "<p>Release report</p>", contentRevision: 1,
    scope: "worker", scopeId: "w1", projectId: null, projectName: null, projectSlug: null, featureId: null, featureName: null, featureSlug: null,
    threadId: "thr_w", createdAt: "2026-10-28T08:00:00.000Z", updatedAt: "2026-10-28T09:16:00.000Z"
  });
  chatMessages = [{
    id: "m1", threadId: "thr_g", seq: 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: "wk", createdAt: "2026-10-28T09:20:00.000Z",
    content: { type: "assistant", text: `The release report is out: [read it](/canvas/${CANVAS}).` }
  }];
  const host = await renderSplit({ width: 1200 });
  await settleUntil(() => host.querySelector(`[data-slot="agent-chat"] a[href="/canvas/${CANVAS}"]`) !== null, "the link");
  const page = host.querySelector('[data-slot="agent-page-body"]')!;
  await act(async () => { host.querySelector<HTMLElement>(`[data-slot="agent-chat"] a[href="/canvas/${CANVAS}"]`)!.click(); });
  await settle();
  const tab = host.querySelector(`[data-slot="agent-page"] [data-canvas-tab="${CANVAS}"]`)!;
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(here).toBe("/agent");
  // The page is kept, hidden, as it was.
  expect(host.querySelector('[data-slot="agent-page-body"]')).toBe(page);
  expect(page.className.split(/\s+/)).toContain("hidden");
  await act(async () => { buttonIn(host.querySelector('[data-slot="agent-page"]')!, "Page")!.click(); });
  expect(page.className.split(/\s+/)).not.toContain("hidden");
});

test("on a phone Your agent's page stands alone: no tab row, and a canvas opens over the page", async () => {
  canvasDocs.set(CANVAS, { id: CANVAS, title: "Release report", kind: "report" });
  chatMessages = [{
    id: "m1", threadId: "thr_g", seq: 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: "wk", createdAt: "2026-10-28T09:20:00.000Z",
    content: { type: "assistant", text: `See [it](/canvas/${CANVAS}).` }
  }];
  const host = await renderSplit({ width: 390, phone: true });
  await settleUntil(() => host.querySelector(`a[href="/canvas/${CANVAS}"]`) !== null, "the link");
  await act(async () => { host.querySelector<HTMLElement>(`a[href="/canvas/${CANVAS}"]`)!.click(); });
  expect(here).toBe(`/canvas/${CANVAS}`);
  expect(useAgentPageUi.getState().tabs).toEqual([]);
  expect(host.querySelector('[aria-label="Page tabs"]') === null).toBe(true);
});
