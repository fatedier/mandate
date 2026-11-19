import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { mountAsync, settle, settleUntil, typeInto } from "../helpers/mount.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { resetBackgroundTasksStore } from "../helpers/subagent-client.js";
import { PersonalAgentPage } from "@/routes/personal/PersonalAgentPage";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useAgentChatStore, type AgentContextUsage } from "@/store/agent-chat";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import type { PersonalAgentDto } from "@shared/api/personal-agent";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { resetAgentPageStore } from "@/store/agent-page";
import { reducedMotion } from "../helpers/motion.js";
import { resetCanvasTitles } from "@/store/canvas-titles";

// The layout at once: how the side moves is split-row.test.tsx's.
beforeEach(() => { reducedMotion(); });

/** What the server lists as the personal agent's background tasks. */
let personalTasks: BackgroundTaskDto[] = [];
/** What its conversation holds, and the canvases the server has. */
let chatMessages: unknown[] = [];
const canvasDocs = new Map<string, Record<string, unknown>>();

afterEach(() => {
  runCleanups();
  usePersonalAgentStore.setState({ agent: null, handoffs: new Map() });
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  resetBackgroundTasksStore();
  personalTasks = [];
  chatMessages = [];
  canvasDocs.clear();
  resetCanvasTitles();
  resetAgentPageStore();
  useAgentPageUi.setState({ open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat", tabs: [], active: "page", fileLines: {}, pagePath: "index.html" });
  localStorage.removeItem("mandate.agent-page.v1");
});

const agent = (over: Partial<PersonalAgentDto>): PersonalAgentDto => ({ threadId: "thr_g", name: "", named: false, unread: false, voiceConfigured: true, lastVisibleSeq: 0, seenSeq: 0, questions: [], ...over });

/** `threadGate`: the thread page answers only once it resolves; `contextUsage`:
 *  what the conversation's last call measured. */
function serve(calls: Array<{ url: string; body: unknown }>, threadGate?: Promise<void>, contextUsage: AgentContextUsage | null = null) {
  let saved: string | null = null;
  mockFetch((call) => {
    const body = call.init?.body ? JSON.parse(String(call.init.body)) : null;
    calls.push({ url: call.url, body });
    // Its conversation's commands: none listed as blocked; /compact taken.
    if (call.url.includes("/api/agents/threads/thr_g/commands")) {
      return call.init?.method === "POST" ? jsonResponse({ taken: true, message: null }) : jsonResponse({ commands: [] });
    }
    if (call.url.includes("/api/settings/config")) {
      saved = body.agent.personalAgentName;
      return jsonResponse({ ok: true, agent: { personalAgentName: saved } });
    }
    // The agent as the server holds it: named once a name was saved.
    if (call.url.endsWith("/api/agents/personal")) return jsonResponse({ agent: agent(saved ? { name: saved, named: true } : {}) });
    if (call.url.includes("/api/agents/personal/handoffs")) return jsonResponse({ handoffs: [] });
    // The server answers with the same agent, now read.
    if (call.url.includes("/api/agents/personal/seen")) return jsonResponse({ agent: { ...usePersonalAgentStore.getState().agent!, unread: false } });
    if (call.url.includes("/api/agents/threads/thr_g/tasks")) return jsonResponse({ tasks: personalTasks });
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
  usePersonalAgentStore.getState().setAgent(agent({}));
  const { host } = await mountAsync(<PersonalAgentPage />, { path: "/agent" });
  expect(host.textContent).toContain("Hi, I'm Mandate.");
  // What it says it does is what it does: it writes the
  // message itself, and sends work to a thread without asking first.
  expect(host.textContent).toContain("Tell a worker what to do. I'll pass it on.");
  expect(host.textContent).toContain("Hand me something new. I'll send it to the right thread and tell you where it went.");
  expect(host.textContent).not.toContain("ask you first");
  expect(host.textContent).not.toContain("in your words");
  const input = host.querySelector<HTMLInputElement>("#personal-agent-name")!;
  await typeInto(input, "Friday");
  expect(host.textContent).toContain("Hi, I'm Friday.");
  await typeInto(input, "   ");
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-slot="personal-agent-start"]')!.click(); });
  await settleUntil(() => calls.some((c) => c.url.includes("/api/settings/config")), "the name was saved");
  expect(calls.find((c) => c.url.includes("/api/settings/config"))!.body).toStrictEqual({ agent: { personalAgentName: "Mandate" } });
  // The header title is a portal into the shell; the empty state is the page's own.
  await settleUntil(() => (host.textContent ?? "").includes("Ask what's going on, or tell a worker what to do."), "the conversation opened");
  expect(host.textContent).not.toContain("What should I be called?");
});

// Back in the conversation, what came after the point read to is marked by a
// line, though the page marks it all seen at once.
test("the page marks with a line what came after the point the user had read to", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  serve(calls);
  const msg = (seq: number, role: "user" | "assistant", text: string) => ({
    id: `m${seq}`, threadId: "thr_g", seq, role, source: role === "user" ? "user" : "self", sourceThreadId: null, wakeId: role === "user" ? null : `w${seq}`,
    createdAt: `2026-11-12T07:0${seq}:00.000Z`, content: role === "user" ? { type: "text", text } : { type: "assistant", text }
  });
  chatMessages = [msg(1, "user", "Did the photo import finish?"), msg(2, "assistant", "Still running."), msg(3, "assistant", "The frost alert fired."), msg(4, "assistant", "Order #34 waits for your approval.")];
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, lastVisibleSeq: 4, seenSeq: 2 }));
  const { host } = await mountAsync(<PersonalAgentPage />, { path: "/agent" });
  await settleUntil(() => calls.some((c) => c.url.includes("/api/agents/personal/seen")), "marked seen");
  // The seen write's answer and the event after it say it is read to the end.
  act(() => { usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: false, lastVisibleSeq: 4, seenSeq: 4 })); });
  await settle();
  const line = host.querySelector<HTMLElement>('[data-slot="new-replies-line"]');
  expect(line?.textContent).toBe("New");
  expect(line?.nextElementSibling?.textContent).toContain("The frost alert fired.");
});

test("named: the page shows the conversation with its empty state, and marks it seen once shown", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let answer!: () => void;
  serve(calls, new Promise<void>((resolve) => { answer = resolve; }));
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, lastVisibleSeq: 4 }));
  const { host } = await mountAsync(<PersonalAgentPage />, { path: "/agent" });
  await settle();
  // Not seen before the conversation is on screen.
  expect(calls.some((c) => c.url.includes("/api/agents/threads/thr_g"))).toBe(true);
  expect(calls.some((c) => c.url.includes("/api/agents/personal/seen"))).toBe(false);
  answer();
  await settleUntil(() => (host.textContent ?? "").includes("I can see every thread and worker."), "the empty state");
  expect(host.textContent).toContain("Jarvis");
  await settleUntil(() => calls.some((c) => c.url.includes("/api/agents/personal/seen")), "marked seen");
  expect(calls.find((c) => c.url.includes("/api/agents/personal/seen"))!.body).toStrictEqual({ seq: 4 });
});

test("voice not set up: the guide points to Settings › Voice instead", async () => {
  serve([]);
  usePersonalAgentStore.getState().setAgent(agent({ voiceConfigured: false }));
  const { host } = await mountAsync(<PersonalAgentPage />, { path: "/agent" });
  expect(host.textContent).toContain("Voice isn't set up yet.");
  expect(host.querySelector('a[href="/settings?tab=voice"]')?.textContent).toBe("Settings › Voice");
});

test("a reply that lands while the page is open and visible is marked seen too", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  serve(calls);
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, lastVisibleSeq: 4 }));
  const { host } = await mountAsync(<PersonalAgentPage />, { path: "/agent" });
  await settleUntil(() => (host.textContent ?? "").includes("Ask what's going on"), "the conversation");
  const seen = () => calls.filter((c) => c.url.includes("/api/agents/personal/seen")).length;
  await settleUntil(() => seen() === 1, "marked seen on open");
  await settle();
  expect(seen()).toBe(1);
  // A handoff came back: the server says unread again, with no new row.
  await act(async () => { usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, lastVisibleSeq: 4 })); });
  await settleUntil(() => seen() === 2, "marked seen again");
  expect(usePersonalAgentStore.getState().agent?.unread).toBe(false);
});

test("the page reads the cards it shows on open and again when the event stream comes back, and asks for nothing by moment", async () => {
  const sentAt = "2026-10-05T10:00:00.000Z";
  const sent = { id: "hof_1", kind: "worker", state: "delivered", text: "x", spoken: false, workerId: "wkr_1", workerName: "release",
    ownerThreadTitle: "Docs overhaul", threadId: "thr_w", threadTitle: null, newThreadTitle: null, reply: null, reason: null, stop: null,
    createdAt: sentAt, updatedAt: sentAt, repliedAt: null };
  let reconnected = false;
  const reads: string[] = [];
  mockFetch((call) => {
    if (call.url.includes("/api/agents/personal/handoffs")) {
      reads.push(call.url);
      return jsonResponse({ handoffs: [reconnected ? { ...sent, state: "failed", stop: "archived", reason: "the worker was archived", updatedAt: "2026-10-05T10:05:00.000Z" } : sent] });
    }
    if (call.url.includes("/api/agents/threads/thr_g")) {
      return jsonResponse({ thread: { id: "thr_g" }, hasMore: false, contextUsage: null, activeWake: null, readAt: null, messages: [
        { id: "m1", threadId: "thr_g", seq: 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1", createdAt: sentAt,
          content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c1", toolName: "message_worker", args: {} }] } },
        { id: "m2", threadId: "thr_g", seq: 2, role: "tool", source: "self", sourceThreadId: null, wakeId: "w1", createdAt: sentAt,
          content: { type: "tool_result", toolCallId: "c1", toolName: "message_worker", result: { handoff: sent } } }
      ] });
    }
    return jsonResponse({});
  });
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true }));
  const { host } = await mountAsync(<PersonalAgentPage />, { path: "/agent" });
  const card = () => host.querySelector('[data-slot="handoff-card"]');
  await settleUntil(() => card() !== null, "the card shows");
  // It reads exactly the handoffs its transcript shows.
  await settleUntil(() => reads.length === 1, "the shown handoffs were read");
  // A change published while the stream was down is not sent again: it reads them again.
  reconnected = true;
  await act(async () => { window.dispatchEvent(new CustomEvent("mandate:sse-open")); });
  await settleUntil(() => card()!.querySelector('[data-slot="handoff-reason"]')?.textContent === "the worker was archived", "the missed change shows on the card");
  expect(reads).toStrictEqual(["/api/agents/personal/handoffs?ids=hof_1", "/api/agents/personal/handoffs?ids=hof_1"]);
  // What comes back is a message in the conversation now: no row is built from a handoff.
  expect(host.querySelector('[data-slot="handoff-outcome"]') === null).toBe(true);
});

/** The page under a header's actions slot, as the shell draws it. */
async function withHeader(contextUsage: AgentContextUsage | null, calls: Array<{ url: string; body: unknown }> = []) {
  serve(calls, undefined, contextUsage);
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true }));
  const { host } = await mountAsync(
    <PaneHeaderSlotsProvider>
      <PaneHeaderActionsSlot />
      <PersonalAgentPage />
    </PaneHeaderSlotsProvider>,
    { path: "/agent" }
  );
  await settleUntil(() => useAgentChatStore.getState().threadsByScope.get("personal:thr_g")?.loaded === true, "the conversation loaded");
  return host.querySelector<HTMLElement>('[data-slot="pane-actions"]')!;
}

const measured = { inputTokens: 102_000, budgetTokens: 250_000, updatedAt: "2026-09-13T00:00:00.000Z" } as AgentContextUsage;

test("the header says how full the agent's context is, as a thread's does", async () => {
  const actions = await withHeader(measured);
  const pill = actions.querySelector<HTMLElement>("[aria-label]")!;
  // The figure and the panel's toggle; History and New side chat are in the ⋯, as on a phone.
  expect(actions.textContent).toBe("Context 41%Panel");
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
  expect(actions.textContent).toBe("Panel");
});

/** The lucide icon an element draws first, by its class. lucide's History
 *  icon (the History tab's) draws as "rotate-ccw-clock". */
const iconOf = (el: Element | undefined) => [...(el?.querySelector("svg")?.classList ?? [])].find((c) => c.startsWith("lucide-"))?.slice("lucide-".length) ?? null;

test("History and New side chat are the ⋯'s first items, with their icons, and no buttons of the header", async () => {
  const actions = await withHeader(null);
  expect([...actions.querySelectorAll("button")].filter((b) => b.textContent === "History" || b.textContent === "New side chat")).toEqual([]);
  const items = await agentMenu(actions);
  expect(items.slice(0, 2).map((i) => [i.textContent, iconOf(i)])).toEqual([["History", "rotate-ccw-clock"], ["New side chat", "messages-square"]]);
});

test("at phone width the ⋯'s History and New side chat carry their icons", async () => {
  onCleanup(fakePhoneWidth());
  const items = await agentMenu(await withHeader(null));
  const item = (name: string) => items.find((i) => i.textContent === name);
  expect([iconOf(item("History")), iconOf(item("New side chat"))]).toEqual(["rotate-ccw-clock", "messages-square"]);
});

// On a phone the Tasks page is reached from the agent's ⋯ too.
test("at phone width the ⋯ reaches Tasks", async () => {
  onCleanup(fakePhoneWidth());
  const items = await agentMenu(await withHeader(null));
  const tasks = items.find((i) => i.textContent === "Tasks");
  expect(tasks?.getAttribute("href")).toBe("/tasks");
});

test("on a desktop the ⋯ has no Tasks: the panel's + opens them", async () => {
  const items = await agentMenu(await withHeader(null));
  expect(items.some((i) => i.textContent === "Tasks")).toBe(false);
});

/** Opens the personal agent's ⋯ and reads its items. */
async function agentMenu(actions: HTMLElement) {
  await act(async () => {
    actions.querySelector<HTMLElement>('[aria-label="Agent actions"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

// The personal agent's ⋯ is a thread's: Compact now always, and its background tasks
// first once it has started one.
test("The personal agent's ⋯ compacts its conversation, and lists its background tasks once it has started one", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const actions = await withHeader(null, calls);
  await settleUntil(() => useBackgroundTasksStore.getState().byThread.has("thr_g"), "its tasks were read");
  const items = await agentMenu(actions);
  expect(items.map((n) => n.textContent)).toEqual(["History", "New side chat", "Compact now"]);
  await act(async () => {
    items.find((n) => n.textContent === "Compact now")!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => calls.some((c) => c.url.endsWith("/api/agents/threads/thr_g/commands") && (c.body as { text?: string } | null)?.text === "/compact"), "/compact sent");
  // Its first task, as the event stream brings it.
  act(() => useBackgroundTasksStore.getState().apply({
    id: "task_g1", kind: "subagent", parentThreadId: "thr_g", childThreadId: "thr_c_g1", type: "general", title: "Weekly summary",
    status: "running", stoppedBy: null, error: null,
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, seq: 2, exitCode: null, command: null, outputPath: null
  }));
  const withTasks = await agentMenu(actions);
  expect(withTasks.map((n) => n.textContent)).toEqual(["History", "New side chat", "Background tasks", "Compact now"]);
  await act(async () => {
    withTasks.find((n) => n.textContent === "Background tasks")!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') !== null, "the list opened");
  expect(document.querySelector('[data-slot="background-tasks-popover"] [data-slot="background-tasks-counts"]')?.textContent).toBe("1 running");
});

test("The personal agent's ⋯ pressed again while its list is open opens its menu alone: the list closes", async () => {
  personalTasks = [{
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
    (await open()).find((n) => n.textContent === "Background tasks")!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"]') !== null, "the list opened");
  expect((await open()).map((n) => n.textContent)).toEqual(["History", "New side chat", "Background tasks", "Compact now"]);
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
  usePersonalAgentStore.getState().setAgent(agent({ name: "Juno", named: true }));
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/home", "/agent"]}>
      <PaneHeaderSlotsProvider>
        <Where />
        <PaneHeaderActionsSlot />
        <PersonalAgentPage />
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
  await act(async () => { buttonIn(host, "Maximize panel")!.click(); });
  expect([chatShown(host), pageHasRow(host)]).toEqual([false, true]);
  expect(saved()).toEqual({ open: true, maximized: true, ratio: 0.5, tabs: [], active: "page", fileLines: {}, pagePath: "index.html" });
  await act(async () => { buttonIn(host, "Restore panel")!.click(); });
  const separator = host.querySelector<HTMLElement>('[role="separator"]')!;
  expect(separator.getAttribute("aria-label")).toBe("Resize page");
  await act(async () => { separator.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })); });
  expect(saved()!.ratio).toBeGreaterThan(0.5);
  expect(saved()!.maximized).toBe(false);
});

// The header is the chat's when the page sits beside it: over the chat's
// column, with the page's tabs in the band over the page. A narrow
// row, one side at a time, keeps the window's header.
test("beside the page the header is the chat pane's, the page's tabs in the band beside it; a narrow row keeps the window's", async () => {
  const host = await renderSplit({ width: 1200 });
  const header = host.querySelector('[data-slot="agent-chat"] [data-slot="pane-header"]');
  expect(header?.querySelector('[data-slot="pane-actions"] [aria-label="Agent actions"]') == null).toBe(false);
  expect(host.querySelectorAll('[data-slot="pane-actions"]').length).toBe(1);
  const tabRow = host.querySelector('[role="tablist"][aria-label="Page tabs"]')!.parentElement!;
  expect(tabRow.className.split(/\s+/)).toContain("h-13");
  runCleanups();
  const narrow = await renderSplit({ width: 600 });
  expect(narrow.querySelector('[data-slot="agent-chat"] [data-slot="pane-header"]') === null).toBe(true);
  expect(narrow.querySelector('[data-slot="pane-actions"]')?.textContent).toContain("Chat");
});

test("a maximized page brings back the window's header, with History in reach in its ⋯", async () => {
  const host = await renderSplit({ width: 1200 });
  await act(async () => { buttonIn(host, "Maximize panel")!.click(); });
  expect(host.querySelector('[data-slot="agent-chat"] [data-slot="pane-header"]') === null).toBe(true);
  const items = await agentMenu(host.querySelector<HTMLElement>('[data-slot="pane-actions"]')!);
  expect(items.map((i) => i.textContent)).toContain("History");
});

test("the header's Panel button closes the page's side and opens it again, lit while it is open", async () => {
  const host = await renderSplit({ width: 1200 });
  const actions = host.querySelector<HTMLElement>('[data-slot="pane-actions"]')!;
  const toggle = () => actions.querySelector<HTMLButtonElement>('[data-slot="panel-toggle"]')!;
  const says = () => [toggle().textContent, toggle().getAttribute("aria-label"), toggle().getAttribute("title"), toggle().getAttribute("aria-pressed")];
  expect(says()).toEqual(["Panel", "Hide panel", "Hide panel", "true"]);
  // The page's own row has no hide button.
  expect(host.querySelector('[data-slot="agent-page"] button[aria-label="Hide panel"]') === null).toBe(true);
  await act(async () => { toggle().click(); });
  expect([chatShown(host), pageShown(host)]).toEqual([true, false]);
  expect(saved()!.open).toBe(false);
  expect(says()).toEqual(["Panel", "Show panel", "Show panel", "false"]);
  await act(async () => { buttonIn(actions, "Panel")!.click(); });
  expect([chatShown(host), pageShown(host)]).toEqual([true, true]);
  expect(saved()!.open).toBe(true);
});

test("a narrow row switches between Chat and Panel, a phone too; on a phone Back returns to Chat", async () => {
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
  // The same word: a phone's side holds Tasks, threads and replies beside the page.
  expect(Array.from(phoneActions.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent)).toEqual(["Chat", "Panel"]);
  await act(async () => { buttonIn(phoneActions, "Panel")!.click(); });
  await settleUntil(() => pageStep, "the page's step");
  expect([chatShown(phone), pageShown(phone), here]).toEqual([false, true, "/agent"]);
  // Its tab row, with the + (canvases open full screen on a phone, so none
  // of theirs); no Hide page: the bar's Chat goes back.
  expect(phone.querySelector('[aria-label="Page tabs"]') !== null).toBe(true);
  expect(phone.querySelector('[data-slot="agent-page"] [aria-label^="Open a thread beside"]') !== null).toBe(true);
  expect(buttonIn(phone.querySelector('[data-slot="agent-page"]')!, "Hide page") === undefined).toBe(true);
  await act(async () => { go(-1); });
  await settleUntil(() => chatShown(phone), "back on the chat");
  expect([pageShown(phone), pageStep, here]).toEqual([false, false, "/agent"]);
});

test("a phone whose row is 720 px or wider still shows one side at a time", async () => {
  const host = await renderSplit({ width: 740, phone: true });
  const actions = host.querySelector<HTMLElement>('[data-slot="pane-actions"]')!;
  expect(Array.from(actions.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent)).toEqual(["Chat", "Panel"]);
  expect([chatShown(host), pageShown(host)]).toEqual([true, false]);
});

// ── Canvases beside the chat ─────────────────────────────────────────────
const CANVAS = "cnv_RelNotes001";

test("a canvas in the personal agent's chat opens as a tab beside it; Page stays the first tab, kept while the canvas shows", async () => {
  canvasDocs.set(CANVAS, {
    id: CANVAS, title: "Release report", kind: "report", html: "<p>Release report</p>", contentRevision: 1,
    scope: "worker", scopeId: "w1", projectId: null, projectName: null, projectSlug: null, workerId: null, workerName: null, workerSlug: null,
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
  expect(host.querySelector('[data-slot="agent-page-body"]') === page).toBe(true);
  expect(page.className.split(/\s+/)).toContain("hidden");
  await act(async () => { buttonIn(host.querySelector('[data-slot="agent-page"]')!, "Page")!.click(); });
  expect(page.className.split(/\s+/)).not.toContain("hidden");
});

test("on a phone Personal agent's page stands alone: no tab row, and a canvas opens over the page", async () => {
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

// A notice lights no dot, but once on screen it is read to, so a later
// reply's New line goes below it.
test("a notice on screen is marked read though it lit no dot, once", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  serve(calls);
  usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: false, lastVisibleSeq: 5, seenSeq: 4 }));
  await mountAsync(<PersonalAgentPage />, { path: "/agent" });
  const seen = () => calls.filter((c) => c.url.includes("/api/agents/personal/seen"));
  await settleUntil(() => seen().length > 0, "marked seen");
  await settle();
  expect(seen().map((c) => c.body)).toStrictEqual([{ seq: 5 }]);
  expect(usePersonalAgentStore.getState().agent?.seenSeq).toBe(5);
});
