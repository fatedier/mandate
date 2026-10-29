import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { useAgentChatStore, type AgentChatScope } from "@/store/agent-chat";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useVoiceStore } from "@/store/voice";
import type { GlobalAgentDto } from "@shared/api/global-agent";
import { stub } from "../helpers/typed.js";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";
import { backgroundTask, resetBackgroundTasksStore, subagentPage } from "../helpers/subagent-client.js";

// The strip above the composer shows the conversation's subagents in every
// conversation that can start one: a manager thread, a worker's, Your agent's.

beforeEach(() => { setSystemTime(new Date("2026-10-18T09:01:13.000Z")); });
afterEach(() => {
  runCleanups();
  setSystemTime();
  document.body.innerHTML = "";
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  resetBackgroundTasksStore();
});

const page = (threadId: string) => ({ thread: { id: threadId }, messages: [], hasMore: false, contextUsage: null, activeWake: null, readAt: null });

/** One conversation's server: its tasks, its commands, its subagent's page, and its own page. */
function serve(threadId: string, tasks: BackgroundTaskDto[], childThreadId: string): FetchCall[] {
  return mockFetch(({ url }) => {
    if (url.endsWith(`/api/agents/threads/${threadId}/tasks`)) return jsonResponse({ tasks });
    if (url.endsWith("/commands")) return jsonResponse({ commands: [] });
    if (url.includes(`/api/agents/threads/${childThreadId}`)) return jsonResponse(subagentPage(childThreadId, "on"));
    return jsonResponse(page(threadId));
  });
}
async function render(scope: AgentChatScope, readOnlyNote?: string) {
  const { host } = await mountAsync(<MemoryRouter><ChatConversation scope={scope} readOnlyNote={readOnlyNote} /></MemoryRouter>);
  return host;
}
const row = (host: ParentNode) => host.querySelector('[data-slot="task-strip-open"] [data-slot="worker-strip-text"]')?.textContent ?? null;

test("a worker's conversation shows its subagent above the composer", async () => {
  serve("thr_w_s1", [backgroundTask({ parentThreadId: "thr_w_s1", childThreadId: "thr_child_s1" })], "thr_child_s1");
  const host = await render({ type: "worker", featureId: "feat_s1" });
  await settleUntil(() => (row(host) ?? "").includes("Reading"), "the worker's subagent on the strip");
  expect(row(host)).toBe("Subagent · 0.72 release notes · Reading release-0.72.md…");
});

test("Your agent's conversation does too", async () => {
  serve("thr_g_s2", [backgroundTask({ parentThreadId: "thr_g_s2", childThreadId: "thr_child_s2", status: "queued", startedAt: null })], "thr_child_s2");
  const host = await render({ type: "global", threadId: "thr_g_s2" });
  await settleUntil(() => row(host) !== null, "the agent's subagent on the strip");
  expect(row(host)).toBe("Subagent · 0.72 release notes · Queued");
});

test("when voice takes the composer's place, the strip stays above what stands there: a running task's progress is shown nowhere else", async () => {
  useGlobalAgentStore.setState({ agent: stub<GlobalAgentDto>({ threadId: "thr_g_s9", name: "", voiceConfigured: true, questions: [] }) });
  onCleanup(() => {
    useVoiceStore.setState({ voiceMode: false, connectionState: "idle" });
    useGlobalAgentStore.setState({ agent: null });
  });
  serve("thr_g_s9", [backgroundTask({ parentThreadId: "thr_g_s9", childThreadId: "thr_child_s9" })], "thr_child_s9");
  const host = await render({ type: "global", threadId: "thr_g_s9" });
  await settleUntil(() => (row(host) ?? "").includes("Reading"), "the agent's subagent on the strip");
  await act(async () => { useVoiceStore.setState({ voiceMode: true, connectionState: "moved" }); });
  expect(host.querySelector("textarea") === null).toBe(true);
  const moved = host.querySelector('[data-slot="voice-moved"]')!;
  const strip = host.querySelector('[data-slot="worker-strip"]');
  expect(strip).not.toBeNull();
  expect(row(host)).toBe("Subagent · 0.72 release notes · Reading release-0.72.md…");
  expect(strip!.compareDocumentPosition(moved) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("an archived conversation reads no tasks: they were stopped with it, and nothing more happens there", async () => {
  const calls = serve("thr_m_s3", [backgroundTask({ parentThreadId: "thr_m_s3", childThreadId: "thr_child_s3" })], "thr_child_s3");
  const host = await render({ type: "manager", threadId: "thr_m_s3" }, "Archived on Oct 13. You can read it here; nothing more can be sent.");
  await settleUntil(() => host.querySelector('[data-slot="archived-note"]') !== null, "the archived note");
  await settle();
  expect(calls.some((c) => c.url.endsWith("/tasks"))).toBe(false);
  expect(host.querySelector('[data-slot="worker-strip"]') === null).toBe(true);
});

test("a subagent whose steps are open stays on the strip when it ends, saying how; closing them lets it go", async () => {
  const running = backgroundTask({ parentThreadId: "thr_m_s4", childThreadId: "thr_child_s4" });
  serve("thr_m_s4", [running], "thr_child_s4");
  const host = await render({ type: "manager", threadId: "thr_m_s4" });
  await settleUntil(() => row(host) !== null, "the strip row");
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-open"]')!.click(); });
  act(() => { useBackgroundTasksStore.getState().apply({ ...running, status: "finished", seq: 9, finishedAt: "2026-10-18T09:01:10.000Z" }); });
  expect(row(host)).toBe("Subagent · 0.72 release notes · Finished");
  expect(host.querySelector('[data-slot="task-stop"]') === null).toBe(true);
  act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(host.querySelector('[data-slot="worker-strip"]') === null).toBe(true);
});

const escape = () => act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

// The strip does not change its shape under what is open on it.
test("a subagent whose steps are open keeps its own row when another starts; closed, the two fold into one", async () => {
  const first = backgroundTask({ id: "task_a", parentThreadId: "thr_m_s6", childThreadId: "thr_child_s6", title: "0.72 release notes" });
  serve("thr_m_s6", [first], "thr_child_s6");
  const host = await render({ type: "manager", threadId: "thr_m_s6" });
  await settleUntil(() => row(host) !== null, "the strip row");
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-open"]')!.click(); });
  await settleUntil(() => document.querySelector('[data-slot="task-steps-popover"]') !== null, "its steps open");
  act(() => { useBackgroundTasksStore.getState().apply(backgroundTask({ id: "task_b", parentThreadId: "thr_m_s6", childThreadId: "thr_child_s6b", title: "API changes", createdAt: "2026-10-18T09:01:00.000Z", startedAt: "2026-10-18T09:01:01.000Z" })); });
  expect(host.querySelector('[data-slot="task-strip-group"]') === null).toBe(true);
  expect((row(host) ?? "").startsWith("Subagent · 0.72 release notes")).toBe(true);
  expect(document.querySelector('[data-slot="task-steps-popover"]') !== null).toBe(true);
  escape();
  await settleUntil(() => host.querySelector('[data-slot="task-strip-group"]') !== null, "the two folded");
  expect(host.querySelector('[data-slot="task-strip-group"] [data-slot="worker-strip-text"]')!.textContent).toBe("2 subagents · 0.72 release notes, API changes");
});

test("the folded row's list stays open, with the task opened in it, when one of its tasks ends; closed, the strip goes on without it", async () => {
  const a = backgroundTask({ id: "task_a", parentThreadId: "thr_m_s7", childThreadId: "thr_child_s7", title: "0.72 release notes" });
  const b = backgroundTask({ id: "task_b", parentThreadId: "thr_m_s7", childThreadId: "thr_child_s7b", title: "API changes", createdAt: "2026-10-18T09:01:00.000Z", startedAt: "2026-10-18T09:01:01.000Z" });
  serve("thr_m_s7", [b, a], "thr_child_s7");
  const host = await render({ type: "manager", threadId: "thr_m_s7" });
  await settleUntil(() => host.querySelector('[data-slot="task-strip-group"]') !== null, "the folded row");
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-group"]')!.click(); });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"] [data-slot="background-task-row"][data-status="running"] button') !== null, "the list open");
  await act(async () => { document.querySelector<HTMLElement>('[data-slot="background-tasks-popover"] [data-slot="background-task-row"][data-status="running"] button')!.click(); });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"] [data-slot="task-steps"]') !== null, "a task opened in it");
  act(() => { useBackgroundTasksStore.getState().apply({ ...a, status: "finished", seq: 9, finishedAt: "2026-10-18T09:01:10.000Z" }); });
  act(() => { useBackgroundTasksStore.getState().apply({ ...b, status: "finished", seq: 9, finishedAt: "2026-10-18T09:01:11.000Z" }); });
  // Its row and its list are still there, and the task opened in it.
  expect(host.querySelector('[data-slot="task-strip-group"]') !== null).toBe(true);
  expect(document.querySelector('[data-slot="background-tasks-popover"] [data-slot="task-steps"]') !== null).toBe(true);
  escape();
  await settleUntil(() => host.querySelector('[data-slot="worker-strip"]') === null, "the strip gone, nothing at work");
});

// Closed by Esc as the strip changes its shape, focus goes on: to the row
// that replaced the one it opened from, or to the composer once none is left.
test("Esc closing what is open as the strip changes its shape gives focus to the row that replaced its own, or to the composer", async () => {
  const a = backgroundTask({ id: "task_a", parentThreadId: "thr_m_s8", childThreadId: "thr_child_s8", title: "0.72 release notes" });
  const b = backgroundTask({ id: "task_b", parentThreadId: "thr_m_s8", childThreadId: "thr_child_s8b", title: "API changes", createdAt: "2026-10-18T09:01:00.000Z", startedAt: "2026-10-18T09:01:01.000Z" });
  serve("thr_m_s8", [a], "thr_child_s8");
  const host = await render({ type: "manager", threadId: "thr_m_s8" });
  await settleUntil(() => row(host) !== null, "the strip row");
  // A's steps open on its row; B starts; Esc in A's steps: the two fold.
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-open"]')!.click(); });
  await settleUntil(() => document.querySelector('[data-slot="task-steps-popover"]') !== null, "its steps open");
  act(() => { useBackgroundTasksStore.getState().apply(b); });
  const inSteps = document.querySelector<HTMLElement>('[data-slot="task-steps-popover"] [data-slot="task-stop"]')!;
  act(() => inSteps.focus());
  await act(async () => {
    inSteps.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settleUntil(() => document.activeElement?.getAttribute("data-slot") === "task-strip-group", "focus on the folded row");
  // The folded row's list; both end while it is open; Esc: nothing is left on the strip.
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-group"]')!.click(); });
  await settleUntil(() => document.querySelector('[data-slot="background-tasks-popover"] [data-slot="background-task-row"]') !== null, "the list open");
  act(() => { useBackgroundTasksStore.getState().apply({ ...a, status: "finished", seq: 9, finishedAt: "2026-10-18T09:01:10.000Z" }); });
  act(() => { useBackgroundTasksStore.getState().apply({ ...b, status: "finished", seq: 9, finishedAt: "2026-10-18T09:01:11.000Z" }); });
  const inList = document.querySelector<HTMLElement>('[data-slot="background-tasks-popover"] [data-slot="background-task-row"]')!;
  act(() => inList.focus());
  await act(async () => {
    inList.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settleUntil(() => host.querySelector('[data-slot="worker-strip"]') === null, "the strip gone");
  await settleUntil(() => document.activeElement?.tagName === "TEXTAREA", "focus on the composer");
});

test("on a phone, a sheet closed by Esc as the strip changes its shape gives focus to the row that replaced its own", async () => {
  onCleanup(fakePhoneWidth(390));
  const a = backgroundTask({ id: "task_a", parentThreadId: "thr_m_s9", childThreadId: "thr_child_s9", title: "0.72 release notes" });
  const b = backgroundTask({ id: "task_b", parentThreadId: "thr_m_s9", childThreadId: "thr_child_s9b", title: "API changes", createdAt: "2026-10-18T09:01:00.000Z", startedAt: "2026-10-18T09:01:01.000Z" });
  serve("thr_m_s9", [a], "thr_child_s9");
  const host = await render({ type: "manager", threadId: "thr_m_s9" });
  await settleUntil(() => host.querySelector('[data-slot="task-strip-open"]') !== null, "the strip row");
  const openSheet = (slot: string) => document.querySelector(`[data-slot="${slot}"]:not([data-state="closed"])`) !== null;
  // A's steps in the sheet; B starts; Esc: the two fold.
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-open"]')!.click(); });
  await settleUntil(() => openSheet("task-steps-sheet"), "its steps in the sheet");
  act(() => { useBackgroundTasksStore.getState().apply(b); });
  escape();
  await settleUntil(() => document.activeElement?.getAttribute("data-slot") === "task-strip-group", "focus on the folded row");
  // The list in the sheet; one ends; Esc: the one left is its own row.
  await act(async () => { host.querySelector<HTMLElement>('[data-slot="task-strip-group"]')!.click(); });
  await settleUntil(() => openSheet("background-tasks-sheet"), "the list in the sheet");
  act(() => { useBackgroundTasksStore.getState().apply({ ...a, status: "finished", seq: 9, finishedAt: "2026-10-18T09:01:10.000Z" }); });
  escape();
  await settleUntil(() => document.activeElement?.getAttribute("data-slot") === "task-strip-open", "focus on the row left");
});

test("a command and a subagent at work fold into one row of background tasks", async () => {
  const a = backgroundTask({ id: "task_a", parentThreadId: "thr_m_s9", childThreadId: "thr_child_s9", title: "0.72 release notes" });
  const b = backgroundTask({ id: "task_b", kind: "command", parentThreadId: "thr_m_s9", childThreadId: null, title: "Run the e2e suite", command: "make e2e", outputPath: "/out/x.log", createdAt: "2026-10-18T09:01:00.000Z", startedAt: "2026-10-18T09:01:01.000Z" });
  serve("thr_m_s9", [a, b], "thr_child_s9");
  const host = await render({ type: "manager", threadId: "thr_m_s9" });
  await settleUntil(() => host.querySelector('[data-slot="task-strip-group"]') !== null, "the folded row");
  expect(host.querySelector('[data-slot="task-strip-group"] [data-slot="worker-strip-text"]')!.textContent).toBe("2 background tasks · 0.72 release notes, Run the e2e suite");
});
