import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { resetBackgroundTasksStore } from "../helpers/subagent-client.js";
import { reducedMotion } from "../helpers/motion.js";
import { PersonalAgentPage } from "@/routes/personal/PersonalAgentPage";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useAgentChatStore } from "@/store/agent-chat";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { resetAgentPageStore } from "@/store/agent-page";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import type { PersonalAgentDto } from "@shared/api/personal-agent";

beforeEach(() => { reducedMotion(); });
afterEach(() => {
  runCleanups();
  usePersonalAgentStore.setState({ agent: null, handoffs: new Map() });
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map(), wholeHeld: new Map() });
  resetBackgroundTasksStore();
  resetAgentPageStore();
  useAgentPageUi.setState({ open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat", tabs: [], active: "page", history: false, historyPlace: null, recent: [] });
  localStorage.removeItem("mandate.agent-page.v1");
});

const at = "2026-11-04T09:00:00.000Z";
const messages = Array.from({ length: 8 }, (_, i) => i % 2 === 0
  ? { id: `m${i + 1}`, threadId: "thr_g", seq: i + 1, role: "user", source: "user", sourceThreadId: null, wakeId: null, createdAt: at, content: { type: "text", text: `Question ${i + 1}` } }
  : { id: `m${i + 1}`, threadId: "thr_g", seq: i + 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: `w${i + 1}`, createdAt: at, content: { type: "assistant", text: `Answer ${i + 1}` } });
const agent = (): PersonalAgentDto => ({ threadId: "thr_g", name: "Juno", named: true, unread: false, voiceConfigured: true, lastVisibleSeq: 8, seenSeq: 8, questions: [] });

async function open() {
  mockFetch((call) => {
    if (call.url.includes("/api/agents/threads/thr_g/commands")) return jsonResponse({ commands: [] });
    if (call.url.includes("/api/agents/threads/thr_g/tasks")) return jsonResponse({ tasks: [] });
    if (call.url.includes("/api/agents/personal/handoffs")) return jsonResponse({ handoffs: [] });
    if (call.url.includes("/api/agents/threads/thr_g")) return jsonResponse({ thread: { id: "thr_g" }, messages, hasMore: false, contextUsage: null, activeWake: null, readAt: null });
    return jsonResponse({});
  });
  usePersonalAgentStore.getState().setAgent(agent());
  const view = await mountAsync(
    <PaneHeaderSlotsProvider>
      <PaneHeaderActionsSlot />
      <PersonalAgentPage />
    </PaneHeaderSlotsProvider>,
    { path: "/agent" }
  );
  await settleUntil(() => useAgentChatStore.getState().threadsByScope.get("personal:thr_g")?.loaded === true, "the conversation loaded");
  await settle(20);
  return view;
}

const tabLabels = (host: HTMLElement) => [...host.querySelectorAll('[aria-label="Page tabs"] [role="tab"]')].map((t) => t.textContent?.trim() ?? "");
const historyList = (host: HTMLElement) => host.querySelector('[data-slot="history-tab"]');
const historyButton = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('[data-slot="pane-actions"] button')].find((b) => b.textContent === "History");
/** History as the agent's ⋯ offers it, at every width. */
async function historyItem(host: HTMLElement): Promise<HTMLElement | undefined> {
  const menu = host.querySelector<HTMLButtonElement>('[aria-label="Agent actions"]')!;
  await act(async () => { menu.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
  await settle(10);
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent === "History");
}

test("History opens from the agent's ⋯ beside the page, read only, and closes with ×", async () => {
  const host = (await open()).host;
  expect(tabLabels(host)).toEqual(["Page"]);
  // Not a button of the header: an item of its ⋯.
  expect(historyButton(host) === undefined).toBe(true);
  const item = (await historyItem(host))!;
  await act(async () => { item.click(); });
  await settle(20);
  expect(tabLabels(host)[1]).toContain("History");
  const list = historyList(host)!;
  expect(list.textContent).toContain("Answer 8");
  // Read only: no composer of its own, no retry.
  expect(list.querySelector("textarea") === null).toBe(true);
  expect(useAgentChatStore.getState().wholeHeld.get("personal:thr_g")).toBe(1);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Close History"]')!.click(); });
  await settle(10);
  expect(tabLabels(host)).toEqual(["Page"]);
  expect(Boolean(historyList(host))).toBe(false);
  // Let go: its conversation is trimmed as usual again.
  expect(useAgentChatStore.getState().wholeHeld.has("personal:thr_g")).toBe(false);
});

test("History is not kept across a reload: the panel shows Page", () => {
  useAgentPageUi.getState().openHistory(null);
  const saved = JSON.parse(localStorage.getItem("mandate.agent-page.v1") ?? "{}") as { state?: Record<string, unknown> };
  expect(saved.state?.history).toBeUndefined();
  const merged = useAgentPageUi.persist.getOptions().merge!(saved.state, useAgentPageUi.getState()) as { active: string };
  expect(merged.active).toBe("page");
});

test("History keeps its place while another tab shows, and Read beside moves it", async () => {
  const host = (await open()).host;
  act(() => { useAgentPageUi.getState().openHistory({ messageId: "m3", offset: 0 }); });
  await settle(20);
  expect(useAgentPageUi.getState().historyPlace).toEqual({ messageId: "m3", offset: 0 });
  act(() => { useAgentPageUi.getState().setActive("page"); });
  await settle(10);
  expect(Boolean(historyList(host))).toBe(false);
  // Shown again: at the place it kept.
  act(() => { useAgentPageUi.getState().setActive("history"); });
  await settle(10);
  expect(Boolean(historyList(host))).toBe(true);
  expect(useAgentPageUi.getState().historyPlace).toEqual({ messageId: "m3", offset: 0 });
  // Read beside again: the new place.
  act(() => { useAgentPageUi.getState().openHistory({ messageId: "m6", offset: 4 }); });
  expect(useAgentPageUi.getState().historyPlace).toEqual({ messageId: "m6", offset: 4 });
});

test("at phone width History is in the agent's menu and shows in the side view", async () => {
  onCleanup(fakePhoneWidth());
  const host = (await open()).host;
  expect(historyButton(host) === undefined).toBe(true);
  const item = (await historyItem(host))!;
  expect(Boolean(item)).toBe(true);
  await act(async () => { item.click(); });
  await settle(20);
  expect(useAgentPageUi.getState().narrowView).toBe("side");
  expect(useAgentPageUi.getState().active).toBe("history");
  expect(Boolean(historyList(host))).toBe(true);
});

test("History's rows stay loaded while its tab is open, shown or not; they are let go when it closes", async () => {
  const view = await open();
  act(() => { useAgentPageUi.getState().openHistory(null); });
  await settle(10);
  expect(useAgentChatStore.getState().wholeHeld.get("personal:thr_g")).toBe(1);
  // Another tab shown (History drawn no more): still held.
  act(() => { useAgentPageUi.getState().setActive("page"); });
  await settle(10);
  expect(useAgentChatStore.getState().wholeHeld.get("personal:thr_g")).toBe(1);
  // Another page shown (Personal agent's page left): still held, its place kept.
  act(() => { view.unmount(); });
  await settle(10);
  expect(useAgentChatStore.getState().wholeHeld.get("personal:thr_g")).toBe(1);
  act(() => { useAgentPageUi.getState().closeHistory(); });
  await settle(10);
  expect(useAgentChatStore.getState().wholeHeld.has("personal:thr_g")).toBe(false);
});

test("an open question reads as open in History, as in the chat", async () => {
  const askedAt = "2026-11-04T09:10:00.000Z";
  const questions = [{ id: "q1", question: "Keep the old install script?", options: [{ label: "Keep" }, { label: "Drop" }], askedAt }];
  messages.push({ id: "m9", threadId: "thr_g", seq: 9, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w9", createdAt: askedAt,
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c9", toolName: "ask_user", args: { question: "Keep the old install script?", options: [{ label: "Keep" }, { label: "Drop" }] } }] } } as never);
  messages.push({ id: "m10", threadId: "thr_g", seq: 10, role: "tool", source: "self", sourceThreadId: null, wakeId: "w9", createdAt: askedAt,
    content: { type: "tool_result", toolCallId: "c9", toolName: "ask_user", result: { asked: true, questionId: "q1", question: "Keep the old install script?", options: [{ label: "Keep" }, { label: "Drop" }] } } } as never);
  onCleanup(() => { messages.splice(8); });
  const host = (await open()).host;
  act(() => { usePersonalAgentStore.getState().setAgent({ ...agent(), questions }); });
  await settle(10);
  const chatLine = () => host.querySelector('[data-slot="agent-chat"] [data-slot="ask-line"]')?.getAttribute("data-state") ?? null;
  act(() => { useAgentPageUi.getState().openHistory(null); });
  await settle(20);
  const historyLine = host.querySelector('[data-slot="history-tab"] [data-slot="ask-line"]')?.getAttribute("data-state") ?? null;
  expect([chatLine(), historyLine]).toEqual(["open", "open"]);
});
