import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { Route, Routes, useLocation } from "react-router";
import { mountAsync, settle, settleUntil, typeInto } from "../helpers/mount.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { reducedMotion } from "../helpers/motion.js";
import { backgroundTask, resetBackgroundTasksStore } from "../helpers/subagent-client.js";
import { PersonalAgentPage } from "@/routes/personal/PersonalAgentPage";
import { SideChatPage } from "@/routes/side-chat/SideChatPage";
import { ConfirmHost } from "@/components/ConfirmDialog";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useAgentChatStore } from "@/store/agent-chat";
import { useSideChatsStore } from "@/store/side-chats";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider, PaneHeaderTitleSlot } from "@/shell/pane-header-slots";
import { resetAgentPageStore } from "@/store/agent-page";
import { resetCanvasTitles } from "@/store/canvas-titles";
import type { SideChatDto } from "@shared/api/side-chat";
import type { PersonalAgentDto } from "@shared/api/personal-agent";

// A side chat is opened from the agent's page and has a page of its own:
// its chat and the canvases it wrote, ended by Send (a summary the user
// reads first) or Discard (asked first).

beforeEach(() => { reducedMotion(); });

afterEach(() => {
  runCleanups();
  usePersonalAgentStore.setState({ agent: null, handoffs: new Map() });
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  useSideChatsStore.setState({ sideChats: null });
  resetBackgroundTasksStore();
  resetCanvasTitles();
  resetAgentPageStore();
});

const CREATED = "2026-11-09T08:00:00.000Z";
const agent = (over: Partial<PersonalAgentDto> = {}): PersonalAgentDto => ({ threadId: "thr_g", name: "Jarvis", named: true, unread: false, voiceConfigured: true, lastVisibleSeq: 0, seenSeq: 0, questions: [], ...over });
const sideChat = (over: Partial<SideChatDto> = {}): SideChatDto => ({
  id: "thr_s1", title: "Pricing", named: true, createdAt: CREATED, lastActivityAt: CREATED, lastVisibleSeq: 3, seenSeq: 3, working: false, ...over
});
const boundary = { id: "m_b", threadId: "thr_s1", seq: 3, role: "user", source: "side-chat-boundary", sourceThreadId: null, wakeId: null, createdAt: CREATED,
  content: { type: "text", text: "[Side chat] Everything above is your conversation…" } };
const userRow = { id: "m_u", threadId: "thr_s1", seq: 4, role: "user", source: "user", sourceThreadId: null, wakeId: null, createdAt: CREATED,
  content: { type: "text", text: "What about pricing?" } };

interface Served {
  calls: Array<{ url: string; method: string; body: unknown }>;
  summary?: Promise<unknown>;
  /** Held until it settles: the new side chat's answer. */
  create?: Promise<unknown>;
  rows?: unknown[];
  canvases?: unknown[];
  tasks?: unknown[];
}

function serve(s: Served) {
  mockFetch(async (call) => {
    const method = call.init?.method ?? "GET";
    const body = call.init?.body ? JSON.parse(String(call.init.body)) : null;
    s.calls.push({ url: call.url, method, body });
    if (call.url.endsWith("/api/agents/personal/side-chats") && method === "POST") {
      await s.create;
      return jsonResponse({ sideChat: sideChat({ title: "New side chat", named: false }) }, 201);
    }
    if (call.url.includes("/side-chats/thr_s1/summary")) return jsonResponse(await (s.summary ?? Promise.resolve({ summary: "Seat pricing." })));
    if (call.url.includes("/side-chats/thr_s1/send")) return jsonResponse({ ok: true });
    if (call.url.includes("/side-chats/thr_s1/seen")) return jsonResponse({ sideChat: sideChat({ seenSeq: body.seq }) });
    if (call.url.endsWith("/side-chats/thr_s1") && method === "DELETE") return jsonResponse({ ok: true });
    if (call.url.endsWith("/side-chats/thr_s1") && method === "PATCH") return jsonResponse({ sideChat: sideChat({ title: body.title }) });
    if (call.url.includes("/canvases")) return jsonResponse({ canvases: s.canvases ?? [] });
    // A canvas itself: not served here (its view says so, with its Close tab).
    if (call.url.includes("/api/canvas/")) return jsonResponse({ error: "canvas not found" }, 404);
    if (call.url.includes("/tasks")) return jsonResponse({ tasks: s.tasks ?? [], olderDone: null, seq: 1 });
    if (call.url.includes("/commands")) return jsonResponse({ commands: [] });
    if (call.url.includes("/api/agents/threads/thr_s1")) return jsonResponse({ thread: { id: "thr_s1" }, hasMore: false, contextUsage: null, activeWake: null, readAt: null, messages: s.rows ?? [boundary] });
    if (call.url.includes("/api/agents/threads/thr_g")) return jsonResponse({ thread: { id: "thr_g" }, hasMore: false, contextUsage: null, activeWake: null, readAt: null, messages: [] });
    return jsonResponse({});
  });
}

function Where() {
  return <div data-slot="where">{useLocation().pathname}</div>;
}

async function mountAt(path: string) {
  const { host } = await mountAsync(
    <PaneHeaderSlotsProvider>
      <PaneHeaderTitleSlot />
      <PaneHeaderActionsSlot />
      <Routes>
        <Route path="/agent" element={<PersonalAgentPage />} />
        <Route path="/agent/side-chats/:threadId" element={<SideChatPage />} />
      </Routes>
      <Where />
      <ConfirmHost />
    </PaneHeaderSlotsProvider>,
    { path }
  );
  const where = () => host.querySelector('[data-slot="where"]')?.textContent;
  const actions = () => host.querySelector<HTMLElement>('[data-slot="pane-actions"]')!;
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name);
  return { host, where, actions, button };
}

async function openMenu(trigger: HTMLElement) {
  await act(async () => {
    trigger.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

test("New side chat, in the agent's ⋯, opens a side chat and goes to its page", async () => {
  const s: Served = { calls: [] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([]);
  const page = await mountAt("/agent");
  // Not a button of the header: an item of its ⋯, as on a phone.
  expect(page.button("New side chat") === undefined).toBe(true);
  const items = await openMenu(page.actions().querySelector<HTMLElement>('[aria-label="Agent actions"]')!);
  await act(async () => { items.find((i) => i.textContent === "New side chat")!.click(); });
  await settleUntil(() => page.where() === "/agent/side-chats/thr_s1", "its page opens");
  expect(s.calls.filter((c) => c.method === "POST" && c.url.endsWith("/side-chats")).length).toBe(1);
  expect(useSideChatsStore.getState().sideChats!.map((c) => c.id)).toEqual(["thr_s1"]);
});

test("on a phone New side chat is in the agent's ⋯", async () => {
  onCleanup(fakePhoneWidth());
  const s: Served = { calls: [] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([]);
  const page = await mountAt("/agent");
  expect(page.button("New side chat") === undefined).toBe(true);
  const items = await openMenu(page.actions().querySelector<HTMLElement>('[aria-label="Agent actions"]')!);
  await act(async () => { items.find((i) => i.textContent === "New side chat")!.click(); });
  await settleUntil(() => page.where() === "/agent/side-chats/thr_s1", "its page opens");
});

// Its header is the chat pane's, over the chat's column; Discard, an
// end that cannot be undone, is in its ⋯, never on the header beside Send.
test("the side chat page shows its title and where it came from over its chat, Send in its header and Discard in its ⋯", async () => {
  const s: Served = { calls: [] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat()]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => page.host.querySelector('[data-slot="side-chat-title"]') !== null, "its header");
  expect(page.host.querySelector('[data-slot="side-chat-chat"] [data-slot="pane-header"] [data-slot="side-chat-title"]')!.textContent).toBe("Pricing");
  expect(page.host.querySelector('[data-slot="side-chat-origin"]')!.textContent).toBe("Side chat of Jarvis · since Nov 9");
  expect([page.button("Send to Jarvis") !== undefined, page.button("Discard") === undefined]).toEqual([true, true]);
  const items = await openMenu(page.actions().querySelector<HTMLElement>('[aria-label="Side chat actions"]')!);
  expect(items.map((i) => i.textContent)).toEqual(["Rename", "Compact now", "Discard side chat"]);
});

test("on a phone Send and Discard are in the side chat's ⋯", async () => {
  onCleanup(fakePhoneWidth());
  const s: Served = { calls: [] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat()]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => page.actions().querySelector('[aria-label="Side chat actions"]') !== null, "its menu");
  // Its title has the top bar: where it started is its first row's to say.
  expect(page.host.querySelector('[data-slot="side-chat-title"]')?.textContent).toBe("Pricing");
  expect(page.host.querySelector('[data-slot="side-chat-origin"]') === null).toBe(true);
  expect([page.button("Send to Jarvis") === undefined, page.button("Discard") === undefined]).toEqual([true, true]);
  const items = await openMenu(page.actions().querySelector<HTMLElement>('[aria-label="Side chat actions"]')!);
  expect(items.map((i) => i.textContent)).toEqual(["Rename", "Compact now", "Send to Jarvis", "Discard side chat"]);
  // Chat and Canvases, one at a time.
  const views = [...page.host.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
  expect(views).toEqual(["Chat", "Canvases"]);
});

test("its first row says where it started; with nothing after it, what it is for", async () => {
  const s: Served = { calls: [] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat()]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  const start = () => page.host.querySelector('[data-slot="side-chat-start"]')?.textContent;
  await settleUntil(() => start() !== undefined, "its first row");
  expect(start()).toBe("Started from Jarvis's conversation on Nov 9. Thread updates don't come here.");
  expect(page.host.querySelector('[data-slot="side-chat-empty"]')?.textContent).toBe(
    "What do you want to work out?This side chat knows Jarvis's conversation up to now. Send it to Jarvis when it is done, or discard it."
  );
  // Its words are the model's, never a bubble.
  expect(page.host.textContent!.includes("Everything above is your conversation")).toBe(false);
});

test("once something follows the first row, the what-it-is-for goes", async () => {
  const s: Served = { calls: [], rows: [boundary, userRow] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat()]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => page.host.textContent!.includes("What about pricing?"), "its row");
  expect(page.host.querySelector('[data-slot="side-chat-start"]') !== null).toBe(true);
  expect(page.host.querySelector('[data-slot="side-chat-empty"]') === null).toBe(true);
});

test("the composer says Reply in this side chat and has no mic", async () => {
  const s: Served = { calls: [] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat()]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => page.host.querySelector("textarea") !== null, "its composer");
  expect(page.host.querySelector("textarea")!.getAttribute("placeholder")).toBe("Reply in this side chat");
  expect(page.host.querySelector('[aria-label="Start voice"]') === null).toBe(true);
});

test("Send shows the summary, takes a note and sends", async () => {
  let answer!: (v: unknown) => void;
  const s: Served = { calls: [], summary: new Promise((resolve) => { answer = resolve; }) };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat()]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => page.button("Send to Jarvis") !== undefined, "its Send");
  await act(async () => { page.button("Send to Jarvis")!.click(); });
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  await settleUntil(() => dialog()?.textContent?.includes("Writing the summary…") ?? false, "the summary being written");
  expect(dialog()!.textContent!.includes("Jarvis gets this summary and your note, and the whole side chat as a file. The side chat then closes.")).toBe(true);
  await act(async () => { answer({ summary: "Seat pricing." }); });
  await settleUntil(() => dialog()?.querySelector('[data-slot="side-chat-summary"]')?.textContent === "Seat pricing.", "the summary");
  const note = dialog()!.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(note.getAttribute("placeholder")).toBe("Add a note for Jarvis (optional)");
  await typeInto(note, "Go with it.");
  const send = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Send to Jarvis")!;
  await act(async () => { send.click(); });
  await settleUntil(() => page.where() === "/agent", "back to the agent");
  expect(s.calls.filter((c) => c.url.includes("/send")).map((c) => c.body)).toEqual([{ summary: "Seat pricing.", note: "Go with it." }]);
  expect(useSideChatsStore.getState().sideChats).toEqual([]);
});

test("a summary that could not be written says why and can be tried again", async () => {
  const s: Served = { calls: [], summary: Promise.resolve({ error: "provider down" }) };
  mockFetch(async (call) => {
    if (call.url.includes("/summary")) return jsonResponse({ error: "provider down" }, 502);
    if (call.url.includes("/api/agents/threads/thr_s1")) return jsonResponse({ thread: { id: "thr_s1" }, hasMore: false, contextUsage: null, activeWake: null, readAt: null, messages: [boundary] });
    s.calls.push({ url: call.url, method: call.init?.method ?? "GET", body: null });
    return jsonResponse({ canvases: [], commands: [] });
  });
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat()]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => page.button("Send to Jarvis") !== undefined, "its Send");
  await act(async () => { page.button("Send to Jarvis")!.click(); });
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  await settleUntil(() => dialog()?.textContent?.includes("Could not write the summary: provider down") ?? false, "why it failed");
  expect([...dialog()!.querySelectorAll("button")].some((b) => b.textContent === "Try again")).toBe(true);
  const send = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Send to Jarvis")!;
  expect(send.disabled).toBe(true);
});

test("Discard asks first and then goes", async () => {
  const s: Served = { calls: [], tasks: [backgroundTask({ kind: "command", parentThreadId: "thr_s1", childThreadId: null, title: "Long build", command: "make" })] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat({ working: true })]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => page.actions().querySelector('[aria-label="Side chat actions"]') !== null, "its menu");
  const confirm = () => document.querySelector<HTMLElement>("[data-confirm-dialog]");
  const discardItem = async () => (await openMenu(page.actions().querySelector<HTMLElement>('[aria-label="Side chat actions"]')!)).find((i) => i.textContent === "Discard side chat")!;
  await act(async () => { (await discardItem()).click(); });
  await settleUntil(() => confirm() !== null, "the question");
  expect(confirm()!.textContent!.includes("Discard this side chat?")).toBe(true);
  expect(confirm()!.textContent!.includes("It and what it found are gone, and nothing goes to Jarvis. This can't be undone.")).toBe(true);
  // A command of its still runs: said too.
  expect(confirm()!.textContent!.includes("A command still running here stops.")).toBe(true);
  const inConfirm = (name: string) => [...confirm()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name)!;
  await act(async () => { inConfirm("Cancel").click(); });
  await settleUntil(() => confirm() === null, "it closed");
  expect(s.calls.some((c) => c.method === "DELETE")).toBe(false);
  await act(async () => { (await discardItem()).click(); });
  await settleUntil(() => confirm() !== null, "the question again");
  await act(async () => { inConfirm("Discard").click(); });
  await settleUntil(() => page.where() === "/agent", "back to the agent");
  expect(s.calls.filter((c) => c.method === "DELETE").map((c) => c.url.endsWith("/side-chats/thr_s1"))).toEqual([true]);
});

// Shut while it has none (an empty half of the window said nothing), it
// opens with the first one; hidden, Canvases in the header brings it back.
test("its panel is shut while it has no canvas and opens when the first comes; hidden, Canvases in the header brings it back", async () => {
  const s: Served = { calls: [] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat()]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => page.host.querySelector('[data-slot="side-chat-title"]') !== null, "its header");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const panel = () => page.host.querySelector('[data-slot="side-chat-canvases"]');
  expect([panel() === null, page.button("Canvases") === undefined]).toEqual([true, true]);
  s.canvases = [canvasItem("cnv_1", "Pricing sketch")];
  await act(async () => { window.dispatchEvent(new window.Event("mandate:canvas-updated")); });
  await settleUntil(() => panel() !== null, "the panel opens with its first canvas");
  // Its row is the band over it: the tabs and its maximize, no hide button.
  const row = page.host.querySelector('[role="tablist"][aria-label="Canvases"]')!.closest('[data-slot="side-chat-canvas-row"]')!;
  expect([row.className.split(/\s+/).includes("h-13"), row.hasAttribute("data-tauri-drag-region")]).toEqual([true, true]);
  expect([row.querySelector("[data-pane-zoom]") !== null, row.querySelector('button[aria-label="Hide panel"]') === null]).toEqual([true, true]);
  // The header's Canvases hides the panel and shows it again, lit while it is open.
  const toggle = () => page.host.querySelector<HTMLButtonElement>('[data-slot="canvases-toggle"]')!;
  const says = () => [toggle().textContent, toggle().getAttribute("aria-label"), toggle().getAttribute("aria-pressed")];
  expect(says()).toEqual(["Canvases", "Hide panel", "true"]);
  await act(async () => { toggle().click(); });
  expect(panel() === null).toBe(true);
  expect(says()).toEqual(["Canvases", "Show panel", "false"]);
  await act(async () => { toggle().click(); });
  expect(panel() !== null).toBe(true);
  expect(says()).toEqual(["Canvases", "Hide panel", "true"]);
});

test("a maximized canvases panel brings back the window's header, with Send and the ⋯ in reach", async () => {
  const s: Served = { calls: [], canvases: [canvasItem("cnv_1", "Pricing sketch")] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat()]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => page.host.querySelector('[data-slot="side-chat-canvases"]') !== null, "its panel");
  await act(async () => { page.host.querySelector<HTMLButtonElement>('[data-slot="side-chat-canvases"] [aria-label="Maximize panel"]')!.click(); });
  expect(page.host.querySelector('[data-slot="side-chat-chat"] [data-slot="pane-header"]') === null).toBe(true);
  expect(page.actions().textContent).toContain("Send to Jarvis");
  expect(page.actions().querySelector('[aria-label="Side chat actions"]') !== null).toBe(true);
});

test("its panel shows the canvases it wrote", async () => {
  runCleanups();
  const t: Served = { calls: [], canvases: [{ id: "cnv_1", title: "Pricing sketch", kind: "report", scope: "manager", scopeId: null, threadId: "thr_s1", createdAt: CREATED, updatedAt: CREATED, projectId: null, projectName: null }] };
  serve(t);
  useSideChatsStore.getState().replaceAll([sideChat()]);
  usePersonalAgentStore.getState().setAgent(agent());
  const again = await mountAt("/agent/side-chats/thr_s1");
  const tabs = () => [...again.host.querySelectorAll('[role="tablist"][aria-label="Canvases"] [role="tab"]')].map((t) => t.textContent);
  await settleUntil(() => tabs().length > 0, "its canvas");
  expect(tabs()).toEqual(["Pricing sketch"]);
  expect(again.host.querySelector('[data-slot="side-chat-canvases-empty"]') === null).toBe(true);
});

test("seen moves forward as on a thread page", async () => {
  const s: Served = { calls: [], rows: [boundary, userRow] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat({ lastVisibleSeq: 5, seenSeq: 3 })]);
  await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => s.calls.some((c) => c.url.includes("/seen")), "marked seen");
  expect(s.calls.filter((c) => c.url.includes("/seen")).map((c) => c.body)).toEqual([{ seq: 5 }]);
});

test("a side chat that ended leads back to the agent", async () => {
  const s: Served = { calls: [] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([]);
  const page = await mountAt("/agent/side-chats/thr_gone");
  await settleUntil(() => page.where() === "/agent", "back to the agent");
});

test("a seen mark the server refused is not asked again at once", async () => {
  const s: Served = { calls: [], rows: [boundary, userRow] };
  mockFetch(async (call) => {
    const method = call.init?.method ?? "GET";
    s.calls.push({ url: call.url, method, body: null });
    if (call.url.includes("/seen")) return jsonResponse({ error: "database is locked" }, 503);
    if (call.url.includes("/canvases")) return jsonResponse({ canvases: [] });
    if (call.url.includes("/tasks")) return jsonResponse({ tasks: [], olderDone: null, seq: 0 });
    if (call.url.includes("/commands")) return jsonResponse({ commands: [] });
    if (call.url.includes("/api/agents/threads/thr_s1")) return jsonResponse({ thread: { id: "thr_s1" }, hasMore: false, contextUsage: null, activeWake: null, readAt: null, messages: [boundary, userRow] });
    return jsonResponse({});
  });
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat({ lastVisibleSeq: 5, seenSeq: 3 })]);
  await mountAt("/agent/side-chats/thr_s1");
  await settleUntil(() => s.calls.some((c) => c.url.includes("/seen")), "marked seen");
  await settle(80);
  expect(s.calls.filter((c) => c.url.includes("/seen")).length).toBe(1);
});

const canvasItem = (id: string, title: string) => ({ id, title, kind: "report", scope: "manager", scopeId: null, threadId: "thr_s1", createdAt: CREATED, updatedAt: CREATED, projectId: null, projectName: null });

test("a canvas switched away from is kept as it was; one closed leaves the panel", async () => {
  const s: Served = { calls: [], canvases: [canvasItem("cnv_1", "Pricing sketch"), canvasItem("cnv_2", "Naming list")] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([sideChat()]);
  const page = await mountAt("/agent/side-chats/thr_s1");
  const tab = (name: string) => [...page.host.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Canvases"] [role="tab"]')].find((t) => t.textContent === name);
  const views = () => page.host.querySelectorAll('[data-slot="canvas-tab-view"]').length;
  await settleUntil(() => tab("Pricing sketch") !== undefined, "its canvases");
  expect(views()).toBe(1);
  await act(async () => { tab("Naming list")!.click(); });
  // The first stays drawn, hidden: switched back, it is as it was left.
  expect(views()).toBe(2);
  // The canvas reads as not found here (no canvas is served): its Close tab is the panel's close.
  const closeShown = () => [...page.host.querySelectorAll<HTMLElement>('[data-slot="canvas-tab-view"]:not(.hidden) button')].find((b) => b.textContent === "Close tab") ?? null;
  await settleUntil(() => closeShown() !== null, "the shown canvas's close");
  await act(async () => { closeShown()!.click(); });
  await settleUntil(() => tab("Naming list") === undefined, "the closed canvas leaves");
  expect(tab("Pricing sketch") !== undefined).toBe(true);
});

test("New side chat clicked twice while one opens opens one", async () => {
  const s: Served = { calls: [] };
  serve(s);
  usePersonalAgentStore.getState().setAgent(agent());
  useSideChatsStore.getState().replaceAll([]);
  let answer = () => {};
  s.create = new Promise<void>((resolve) => { answer = resolve; });
  const page = await mountAt("/agent");
  const menu = () => page.actions().querySelector<HTMLElement>('[aria-label="Agent actions"]')!;
  // Chosen, then chosen again from the ⋯ while the first is still opening.
  for (let i = 0; i < 2; i++) {
    const items = await openMenu(menu());
    await act(async () => { items.find((item) => item.textContent === "New side chat")!.click(); });
  }
  answer();
  await settleUntil(() => page.where() === "/agent/side-chats/thr_s1", "its page opens");
  expect(s.calls.filter((c) => c.method === "POST" && c.url.endsWith("/side-chats")).length).toBe(1);
});
