import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { mount } from "../helpers/mount.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { clientWorker, clientProject } from "../helpers/client-builders.js";
import { HandoffCard } from "@/routes/personal/HandoffCard";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useProjectsStore } from "@/store/projects";
import type { PersonalHandoffDto } from "@shared/api/personal-agent";
import { AssistantMessage } from "@/routes/window/chat/AssistantMessage";
import type { AgentMessage } from "@/store/agent-chat";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useThreadTabsStore } from "@/store/thread-tabs";
import { mockFetch } from "../helpers/fetch.js";
import { useTaskBoardStore } from "@/store/task-board";
import { taskDto } from "../helpers/client-builders.js";

afterEach(() => {
  runCleanups();
  usePersonalAgentStore.setState({ agent: null, handoffs: new Map() });
  act(() => useProjectsStore.getState().setProjectsState([]));
  useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
  useAgentPageUi.setState({ open: true, narrowView: "chat", active: "page" });
});

const worker = clientWorker("wkr_1", {
  name: "release", tmuxWindowName: "release-win", createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", ownerThreadId: "thr_m"
});
const project = clientProject("p1", {
  name: "mandate", workingDir: "/m", tmuxSessionName: "md-project-1", createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", workers: [worker]
});

const handoff = (over: Partial<PersonalHandoffDto>): PersonalHandoffDto => ({
  id: "hof_1", kind: "worker", state: "delivered", text: "Keep the old install script", spoken: false,
  workerId: "wkr_1", workerName: "release", ownerThreadTitle: "Docs overhaul",
  threadId: "thr_w", threadTitle: null, newThreadTitle: null, reply: null, reason: null, stop: null,
  createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", repliedAt: null, ...over
});

const card = (host: HTMLElement) => host.querySelector('[data-slot="handoff-card"]')!;
const box = () => document.querySelector<HTMLElement>('[data-slot="handoff-peek"]');
const inBox = (slot: string) => box()?.querySelector<HTMLElement>(`[data-slot="${slot}"]`) ?? null;
const openBox = (host: HTMLElement) => act(() => { card(host).querySelector<HTMLButtonElement>('button[data-slot="handoff-target"]')!.click(); });

const toThread = { kind: "thread" as const, workerId: null, workerName: null, ownerThreadTitle: null, threadId: "thr_t", threadTitle: "PR reviews" };

test("the line reads 'Sent to <target>': a worker with its thread, a new thread marked so; what comes back is not drawn on it", () => {
  const { host, rerender } = mount(<HandoffCard handoffId="hof_1" fallback={handoff({})} />, { path: "/agent" });
  expect(card(host).textContent).toContain("Sent to release · in Docs overhaul");
  act(() => { usePersonalAgentStore.getState().upsertHandoff(handoff({ state: "replied", stop: "stopped", reply: "OK, it stays.", repliedAt: "2026-10-05T10:05:00.000Z" })); });
  rerender(<HandoffCard handoffId="hof_1" fallback={handoff({})} />);
  // The notice that woke the agent says what came back, where it arrived.
  expect(card(host).textContent).not.toContain("OK, it stays.");
  const thread = mount(<HandoffCard handoffId="hof_2" fallback={handoff({ id: "hof_2", ...toThread, state: "delivered" })} />, { path: "/agent" });
  expect(card(thread.host).textContent).toContain("Sent to PR reviews");
  expect(card(thread.host).textContent).not.toContain("new thread");
  const made = mount(<HandoffCard handoffId="hof_3" fallback={handoff({ id: "hof_3", ...toThread, state: "delivered", newThreadTitle: "PR reviews" })} />, { path: "/agent" });
  expect(card(made.host).textContent).toContain("Sent to PR reviews · new thread");
});

test("only Queued and Failed are labelled, with why in grey after it: who is busy, what went wrong", () => {
  const state = (over: Partial<PersonalHandoffDto>) => {
    const { host, unmount } = mount(<HandoffCard handoffId="hof_1" fallback={handoff(over)} />, { path: "/agent" });
    const label = card(host).querySelector('[data-slot="handoff-state"]')?.textContent ?? null;
    const why = card(host).querySelector('[data-slot="handoff-reason"]')?.textContent ?? null;
    unmount();
    return label === null && why === null ? null : [label, why];
  };
  expect(state({ state: "delivered" })).toBeNull();
  expect(state({ state: "replied", stop: "stopped", repliedAt: "2026-10-05T10:05:00.000Z" })).toBeNull();
  expect(state({ ...toThread, state: "delivered", newThreadTitle: "PR reviews" })).toBeNull();
  expect(state({ state: "queued" })).toEqual(["Queued", "worker busy"]);
  expect(state({ ...toThread, state: "queued" })).toEqual(["Queued", "manager busy"]);
  // Its target was archived: nothing came back, so no other line will say why.
  expect(state({ state: "failed", stop: "archived", reason: "the worker was archived" })).toEqual(["Failed", "the worker was archived"]);
  // One that came back at a moment is told where it arrived.
  expect(state({ state: "failed", reason: "It was stopped after it answered.", reply: "Unit tests passed.", repliedAt: "2026-10-05T10:05:00.000Z" })).toEqual(["Failed", null]);
});

test("after the target, the first line of what it sent, as plain text; on a narrow transcript it gives way; nothing opens in place", () => {
  const long = "Fix the search page so that a slow query no longer ends in a **timeout**.\n\nDone means: the page shows a retry hint; one test is added; the e2e suite has run.";
  const { host, unmount } = mount(<HandoffCard handoffId="hof_long" fallback={handoff({ ...toThread, id: "hof_long", state: "delivered", text: long })} />, { path: "/agent" });
  const first = card(host).querySelector('[data-slot="handoff-first"]')!;
  expect(first.textContent).toBe("Fix the search page so that a slow query no longer ends in a timeout.");
  expect(first.className.split(/\s+/)).toEqual(expect.arrayContaining(["truncate", "@max-[34rem]:hidden"]));
  expect(card(host).textContent).not.toContain("Done means");
  expect(card(host).querySelector('[data-slot="sent-fold"]') === null).toBe(true);
  expect(card(host).textContent).not.toContain("Show more");
  unmount();
  const nothing = mount(<HandoffCard handoffId="hof_1" fallback={handoff({ ...toThread, state: "waiting", text: "" })} />, { path: "/agent" });
  expect(card(nothing.host).querySelector('[data-slot="handoff-first"]') === null).toBe(true);
});

test("a click on the target opens the whole message in a box, drawn as the chat draws it, with the ways to the thread", () => {
  const long = "Fix the search page so that a slow query no longer ends in a **timeout**.\n\nDone means: the page shows a retry hint.";
  const { host } = mount(<HandoffCard handoffId="hof_1" fallback={handoff({ ...toThread, state: "delivered", text: long })} />, { path: "/agent" });
  expect(box() === null).toBe(true);
  openBox(host);
  expect(inBox("handoff-peek-title")!.textContent).toBe("PR reviews");
  const body = inBox("handoff-peek-body")!;
  expect([body.querySelectorAll("p").length, body.querySelector("strong")?.textContent, body.textContent!.replace(/\s+/g, " ").trim()])
    .toEqual([2, "timeout", "Fix the search page so that a slow query no longer ends in a timeout. Done means: the page shows a retry hint."]);
  const panel = inBox("handoff-panel")!;
  const go = inBox("handoff-open")!;
  expect([panel.tagName, panel.textContent, go.tagName, go.textContent, go.getAttribute("href")]).toEqual(["BUTTON", "Open in panel", "A", "Open thread", "/threads/thr_t"]);
  expect(panel.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // With a mouse it is a box at the name, not the sheet.
  expect(box()!.querySelector('[data-slot="bottom-sheet-body"]') === null).toBe(true);
  // Followed, its link leaves no box over where it leads.
  act(() => { go.click(); });
  expect(box() === null).toBe(true);
});

test("a worker's box opens its chat in its thread's panel; one not among the projects, or a new thread not made yet, has the message alone", () => {
  const ways = (over: Partial<PersonalHandoffDto>) => {
    const { host, unmount } = mount(<HandoffCard handoffId="hof_1" fallback={handoff(over)} />, { path: "/agent" });
    openBox(host);
    const go = inBox("handoff-open");
    const seen = { body: inBox("handoff-peek-body")?.textContent ?? null, panel: inBox("handoff-panel") !== null, go: go ? [go.textContent, go.getAttribute("href")] : null };
    unmount();
    return seen;
  };
  // A worker not among the projects (none are loaded here) has nowhere to open.
  expect(ways({ state: "delivered" })).toEqual({ body: "Keep the old install script", panel: false, go: null });
  act(() => useProjectsStore.getState().setProjectsState([project]));
  expect(ways({ state: "delivered" })).toEqual({ body: "Keep the old install script", panel: false, go: ["Open worker", "/threads/thr_m?worker=wkr_1&tab=chat"] });
  expect(ways({ ...toThread, state: "queued" })).toEqual({ body: "Keep the old install script", panel: true, go: ["Open thread", "/threads/thr_t"] });
  expect(ways({ ...toThread, threadId: null, threadTitle: null, newThreadTitle: "Billing", state: "failed" })).toEqual({ body: "Keep the old install script", panel: false, go: null });
});

// A thread's box opens it beside the personal agent too.
test("Open in panel opens the thread beside the personal agent and closes the box; opened again, it says Show in panel and only shows it", async () => {
  const posted: unknown[] = [];
  mockFetch(({ method, init }) => {
    if (method === "POST") posted.push(JSON.parse(String(init!.body)));
    return Response.json({ tabs: posted.length > 0 ? [{ threadId: "thr_t", createdAt: "2026-10-05T10:06:00.000Z" }] : [] });
  });
  const { host } = mount(<HandoffCard handoffId="hof_1" fallback={handoff({ ...toThread, state: "delivered" })} />, { path: "/agent" });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  openBox(host);
  await act(async () => { inBox("handoff-panel")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect([posted, useAgentPageUi.getState().active, box() === null]).toStrictEqual([[{ threadId: "thr_t" }], "thread:thr_t", true]);
  // Shown again from elsewhere, the button only shows it: nothing is sent.
  act(() => useAgentPageUi.setState({ active: "page" }));
  openBox(host);
  expect(inBox("handoff-panel")!.textContent).toBe("Show in panel");
  await act(async () => { inBox("handoff-panel")!.click(); await new Promise((r) => setTimeout(r, 0)); });
  expect([posted.length, useAgentPageUi.getState().active]).toStrictEqual([1, "thread:thr_t"]);
});

test("on a phone the message rises in the sheet, the ways to the thread in its header", () => {
  onCleanup(fakePhoneWidth());
  const { host } = mount(<HandoffCard handoffId="hof_1" fallback={handoff({ ...toThread, state: "delivered" })} />, { path: "/agent" });
  openBox(host);
  const sheet = box()!;
  const body = sheet.querySelector('[data-slot="bottom-sheet-body"]')!;
  expect(body.querySelector('[data-slot="handoff-peek-body"]')!.textContent).toBe("Keep the old install script");
  // Above the body, which does not scroll until the sheet is pulled up.
  expect([inBox("handoff-open")!.textContent, body.contains(inBox("handoff-open")), body.contains(inBox("handoff-panel"))]).toEqual(["Open thread", false, false]);
});

test("a send_to_thread call reads as its card; a wait with nothing sent is a line of the run and draws no card", () => {
  const sent = handoff({ kind: "thread", state: "delivered", workerName: null, workerId: null, threadId: "thr_t", threadTitle: "PR reviews" });
  const message = {
    id: "m1", threadId: "thr_g", seq: 3, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1",
    wakeReason: null, wakeMetadata: null, wakeStartedAt: null, createdAt: "2026-10-05T10:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [
      { toolCallId: "c1", toolName: "send_to_thread", args: { threadId: "thr_t", text: "x" } },
      { toolCallId: "c2", toolName: "await_stop", args: { threadId: "thr_u" } }
    ] }
  } as unknown as AgentMessage;
  const results = new Map([
    ["c1", { result: { handoff: sent }, createdAt: "2026-10-05T10:00:01.000Z" }],
    ["c2", { result: { waiting: true, handoff: handoff({ id: "hof_w", kind: "thread", state: "waiting", text: "", workerName: null, workerId: null, threadId: "thr_u", threadTitle: "Docs" }) }, createdAt: "2026-10-05T10:00:02.000Z" }]
  ]);
  const { host } = mount(<AssistantMessage message={message} toolResultsByCallId={results} activeToolCallId={null} />, { path: "/agent" });
  expect(host.querySelectorAll('[data-slot="handoff-card"]').length).toBe(1);
  expect(host.querySelector('[data-slot="handoff-card"]')!.textContent).toContain("PR reviews");
  expect(host.querySelectorAll('[data-slot="tool-run-line"]').length).toBe(1);
  expect(host.querySelector('[data-slot="tool-run-line"]')!.textContent).toContain("Waiting for it to stop");
});

test("a message_worker call reads as its card, not as a tool line; a refused one stays a line", () => {
  const sent = handoff({});
  const message = {
    id: "m1", threadId: "thr_g", seq: 3, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1",
    wakeReason: null, wakeMetadata: null, wakeStartedAt: null, createdAt: "2026-10-05T10:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [
      { toolCallId: "c1", toolName: "message_worker", args: { workerId: "wkr_1", text: "x" } },
      { toolCallId: "c2", toolName: "message_worker", args: { workerId: "wkr_9", text: "y" } }
    ] }
  } as unknown as AgentMessage;
  const results = new Map([
    ["c1", { result: { handoff: sent }, createdAt: "2026-10-05T10:00:01.000Z" }],
    ["c2", { result: { error: "worker is archived: old" }, createdAt: "2026-10-05T10:00:02.000Z" }]
  ]);
  const { host } = mount(<AssistantMessage message={message} toolResultsByCallId={results} activeToolCallId={null} />, { path: "/agent" });
  expect(host.querySelectorAll('[data-slot="handoff-card"]').length).toBe(1);
  expect(host.querySelectorAll('[data-slot="tool-run-line"]').length).toBe(1);
  // Opened, the run is the refused call alone (one call opens straight to its
  // details, two would list them): the sent one is its card.
  act(() => { host.querySelector<HTMLButtonElement>('[data-slot="tool-run-line"]')!.click(); });
  expect(host.querySelectorAll('[data-slot="tool-details"]').length).toBe(1);
  expect(host.querySelectorAll('[data-slot="tool-call"]').length).toBe(0);
});


test("a Sent-to line with a task shows the task's chip", () => {
  act(() => { useTaskBoardStore.getState().replaceAll([taskDto("tsk_aaaaaaaaaaa", { title: "Prices from one source", status: "progress" })]); });
  onCleanup(() => { useTaskBoardStore.setState({ tasks: null }); });
  const sent = handoff({ kind: "thread", state: "delivered", workerName: null, workerId: null, threadId: "thr_t", threadTitle: "PR reviews" });
  const message = {
    id: "m1", threadId: "thr_g", seq: 3, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1",
    wakeReason: null, wakeMetadata: null, wakeStartedAt: null, createdAt: "2026-10-05T10:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [
      { toolCallId: "c1", toolName: "send_to_thread", args: { threadId: "thr_t", text: "x", taskId: "tsk_aaaaaaaaaaa" } },
      { toolCallId: "c2", toolName: "send_to_thread", args: { threadId: "thr_u", text: "y" } }
    ] }
  } as unknown as AgentMessage;
  const results = new Map([
    ["c1", { result: { handoff: sent }, createdAt: "2026-10-05T10:00:01.000Z" }],
    ["c2", { result: { handoff: handoff({ id: "hof_2", kind: "thread", state: "delivered", workerName: null, workerId: null, threadId: "thr_u", threadTitle: "Docs" }) }, createdAt: "2026-10-05T10:00:02.000Z" }]
  ]);
  const { host } = mount(<AssistantMessage message={message} toolResultsByCallId={results} activeToolCallId={null} />, { path: "/agent" });
  const cards = [...host.querySelectorAll<HTMLElement>('[data-slot="handoff-card"]')];
  expect(cards.map((c) => c.querySelector('[data-slot="task-chip"]')?.getAttribute("data-task-id") ?? null)).toEqual(["tsk_aaaaaaaaaaa", null]);
  expect(cards[0]!.querySelector('[data-slot="task-chip-title"]')?.textContent).toBe("Prices from one source");
});
