import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import { useAgentChatStore, type AgentChatScope } from "@/store/agent-chat";
import { useManagerThreadsStore } from "@/store/manager-threads";
import type { AgentMessageDto, ManagerThreadDto } from "@shared/api/agents";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { agentMessage, stub } from "../helpers/typed.js";

afterEach(() => {
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  useManagerThreadsStore.setState({ threads: new Map() });
});

// Sharing starts at a message: its exchange is picked, the conversation shows
// only what can be shared, each a toggle, and the composer gives way to a bar
// that counts what is picked.

const at = (s: number) => new Date(Date.UTC(2026, 10, 6, 10, 0, s)).toISOString();
function thread(threadId: string, title = "Image limit"): void {
  useManagerThreadsStore.setState({
    threads: new Map([...useManagerThreadsStore.getState().threads, [threadId, stub<ManagerThreadDto>({ id: threadId, title, running: false, failed: false, stopReason: null, questions: [], archivedAt: null })]])
  });
}
const user = (threadId: string, id: string, seq: number, text: string) => agentMessage({ id, threadId, seq, createdAt: at(seq), content: { type: "text", text } });
const reply = (threadId: string, id: string, seq: number, wakeId: string, text: string, toolCalls?: { toolCallId: string; toolName: string; args: Record<string, unknown> }[]) =>
  agentMessage({ id, threadId, seq, role: "assistant", source: "self", wakeId, createdAt: at(seq), content: { type: "assistant", text, ...(toolCalls ? { toolCalls } : {}) } });
const toolResult = (threadId: string, id: string, seq: number, wakeId: string, callId: string) =>
  agentMessage({ id, threadId, seq, role: "tool", source: "self", wakeId, createdAt: at(seq), content: { type: "tool_result", toolCallId: callId, toolName: "bash", result: "stdout:\nok" } });

/** Two exchanges: a question and a turn that ran a command on the way. */
function twoExchanges(threadId: string): AgentMessageDto[] {
  return [
    user(threadId, "u1", 1, "Can the gallery make thumbnails for large photos?"),
    reply(threadId, "a1", 2, "w1", "Looking at the thumbnail code.", [{ toolCallId: "c1", toolName: "bash", args: { command: "rg resize" } }]),
    toolResult(threadId, "t1", 3, "w1", "c1"),
    reply(threadId, "a2", 4, "w1", "Partly, and at a cost."),
    user(threadId, "u2", 5, "Raise the limit to 4096 px first?"),
    reply(threadId, "b1", 6, "w2", "Yes, a safe first step.")
  ];
}

let lastHost: HTMLElement | null = null;
const host0 = () => lastHost!;
async function render(scope: AgentChatScope & { type: "manager" }, messages: AgentMessageDto[]) {
  thread(scope.threadId);
  mockFetch(() => jsonResponse({ thread: { id: scope.threadId }, messages, hasMore: false, contextUsage: null, activeWake: null, readAt: null }));
  const mounted = await mountAsync(<MemoryRouter><ChatConversation scope={scope} /></MemoryRouter>);
  await settle();
  lastHost = mounted.host;
  return mounted;
}
const shareButtons = (host: ParentNode) => [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Share as image"]')];
const shareRows = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-slot="share-row"]')];
const picked = (host: ParentNode) => shareRows(host).filter((row) => row.getAttribute("aria-checked") === "true").map((row) => row.dataset.rowKey);
const bar = (host: ParentNode) => host.querySelector<HTMLElement>('[data-slot="share-bar"]');
const click = (el: Element, init: MouseEventInit = {}) => act(() => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, ...init })); });
const rowOf = (host: ParentNode, key: string) => shareRows(host).find((row) => row.dataset.rowKey === key)!;

test("Share as image on a reply picks its exchange; only what can be shared is drawn, and the composer gives way to the bar", async () => {
  const { host } = await render({ type: "manager", threadId: "t_s1" }, twoExchanges("t_s1"));
  // Each of the user's messages and each turn's last reply offer it, as they offer Copy.
  expect(shareButtons(host).length).toBe(4);
  expect(host.querySelector('[data-slot="tool-run"]') !== null).toBe(true);
  // The first turn's: its question, what it said on the way, its answer.
  await click(shareButtons(host)[1]!);
  expect(shareRows(host).map((row) => row.dataset.rowKey)).toEqual(["u1", "a1", "a2", "u2", "b1"]);
  expect(picked(host)).toEqual(["u1", "a1", "a2"]);
  expect(host.querySelector('[data-slot="tool-run"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="composer"]') === null).toBe(true);
  expect(bar(host)!.textContent).toContain("3 selected");
  // Rows are checkboxes; nothing inside them answers a click while picking.
  expect(rowOf(host, "u2").getAttribute("role")).toBe("checkbox");
  expect(shareButtons(host).length).toBe(0);
});

test("picked rows next to each other are drawn as one run: joined where they meet, rounded only at its ends", async () => {
  const { host } = await render({ type: "manager", threadId: "t_s8" }, twoExchanges("t_s8"));
  const runs = () => shareRows(host).map((row) => `${row.dataset.rowKey}:${row.hasAttribute("data-joined-above") ? "^" : ""}${row.hasAttribute("data-joined-below") ? "v" : ""}`);
  await click(shareButtons(host)[1]!);
  expect(runs()).toEqual(["u1:v", "a1:^v", "a2:^", "u2:", "b1:"]);
  // The middle left out: two picked rows alone.
  await click(rowOf(host, "a1"));
  expect(runs()).toEqual(["u1:", "a1:", "a2:", "u2:", "b1:"]);
  await click(rowOf(host, "u2"));
  expect(runs()).toEqual(["u1:", "a1:", "a2:v", "u2:^", "b1:"]);
});

test("a click toggles a row; picking none keeps the mode and says what to do; Shift picks the run between", async () => {
  const { host } = await render({ type: "manager", threadId: "t_s2" }, twoExchanges("t_s2"));
  await click(shareButtons(host)[2]!);
  expect(picked(host)).toEqual(["u2", "b1"]);
  await click(rowOf(host, "b1"));
  await click(rowOf(host, "u2"));
  expect(picked(host)).toEqual([]);
  expect(bar(host)!.textContent).toContain("Select the messages to include");
  expect(bar(host)!.querySelector<HTMLButtonElement>('button[data-slot="share-open"]')!.disabled).toBe(true);
  // From the last row clicked to this one, both included.
  await click(rowOf(host, "a1"));
  await click(rowOf(host, "b1"), { shiftKey: true });
  expect(picked(host)).toEqual(["a1", "a2", "u2", "b1"]);
  expect(bar(host)!.textContent).toContain("4 selected");
  // Space on a focused row toggles it too.
  await act(() => { rowOf(host, "u2").dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true })); });
  expect(picked(host)).toEqual(["a1", "a2", "b1"]);
});

test("Cancel and Esc leave picking, and another conversation never starts in it", async () => {
  const scope = { type: "manager" as const, threadId: "t_s3" };
  const { host, rerender } = await render(scope, twoExchanges("t_s3"));
  await click(shareButtons(host)[0]!);
  expect(bar(host) !== null).toBe(true);
  await click([...bar(host)!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
  expect(bar(host) === null).toBe(true);
  expect(host.querySelector('[data-slot="composer"]') !== null).toBe(true);
  expect(shareRows(host).length).toBe(0);

  await click(shareButtons(host)[0]!);
  await act(() => { document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(bar(host) === null).toBe(true);

  // Picking in one conversation; the page moves to another.
  await click(shareButtons(host)[0]!);
  const other = { type: "manager" as const, threadId: "t_s4" };
  thread(other.threadId, "Other");
  mockFetch(() => jsonResponse({ thread: { id: other.threadId }, messages: twoExchanges(other.threadId), hasMore: false, contextUsage: null, activeWake: null, readAt: null }));
  await rerender(<MemoryRouter><ChatConversation scope={other} /></MemoryRouter>);
  await settle();
  expect(bar(host) === null).toBe(true);
  expect(shareRows(host).length).toBe(0);
});

test("in a worker's chat the manager's instructions are not the user's words: they offer no Share and are not picked", async () => {
  const T = "t_s6";
  mockFetch(() => jsonResponse({ thread: { id: T }, messages: [
    agentMessage({ id: "m1", threadId: T, seq: 1, source: "manager", createdAt: at(1), content: { type: "text", text: "Draft the release notes." } }),
    reply(T, "r1", 2, "w1", "Drafted them in NOTES.md."),
    user(T, "u1", 3, "Shorter, please."),
    reply(T, "r2", 4, "w2", "Cut to five lines.")
  ], hasMore: false, contextUsage: null, activeWake: null, readAt: null }));
  const { host } = await mountAsync(<MemoryRouter><ChatConversation scope={{ type: "worker", workerId: "wkr_s6" }} /></MemoryRouter>);
  await settle();
  expect(host.textContent).toContain("Draft the release notes.");
  // The worker's two replies and the user's own message.
  expect(shareButtons(host).length).toBe(3);
  await click(shareButtons(host)[0]!);
  expect(shareRows(host).map((row) => row.dataset.rowKey)).toEqual(["r1", "u1", "r2"]);
  expect(picked(host)).toEqual(["r1"]);
});

test("leaving puts the reader back where they read: at the end if they were kept there, else the top row in view stays put", async () => {
  const { host } = await render({ type: "manager", threadId: "t_s7" }, twoExchanges("t_s7"));
  const column = host.querySelector<HTMLElement>('[data-slot="transcript-column"]')!;
  const scroller = column.parentElement!;
  // The test DOM lays nothing out: each row is 100px, and 100px more for each
  // run of commands in it, stacked from the top; the view is 200px.
  const ROW = '[data-slot="transcript-row"], [data-slot="share-row"]';
  const rows = () => [...column.querySelectorAll<HTMLElement>(ROW)].filter((el) => !el.parentElement?.closest(ROW));
  const height = (el: HTMLElement) => 100 + 100 * el.querySelectorAll('[data-slot="tool-run"]').length;
  const topOf = (el: HTMLElement) => {
    let top = -scroller.scrollTop;
    for (const row of rows()) { if (row === el) return top; top += height(row); }
    return null;
  };
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => rows().reduce((sum, row) => sum + height(row), 0) });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 200 });
  const rect = spyOn(window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = topOf(this) ?? 0;
    const h = topOf(this) === null ? 200 : height(this);
    return { top, bottom: top + h, height: h, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) };
  });
  onCleanup(() => rect.mockRestore());
  const cancel = () => click([...bar(host)!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
  const topOfRow = (key: string) => topOf(column.querySelector<HTMLElement>(`[data-row-key="${key}"]`)!.closest<HTMLElement>(ROW)!);
  expect(scroller.scrollHeight).toBe(600);

  // At the end, picking from the last reply and leaving: back at the end.
  scroller.scrollTop = 400;
  await click(shareButtons(host)[3]!);
  await cancel();
  expect(scroller.scrollTop).toBe(scroller.scrollHeight);

  // Picking from there, then reading up: the row at the top stays at the top.
  scroller.scrollTop = 400;
  await click(shareButtons(host)[3]!);
  expect(topOfRow("b1")).toBe(100);
  await act(() => {
    scroller.scrollTop = 200;
    scroller.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    scroller.dispatchEvent(new window.Event("scroll", { bubbles: true }));
  });
  expect(topOfRow("a2")).toBe(0);
  await cancel();
  expect(topOfRow("a2")).toBe(0);

  // At the end with a run of commands open, which holds the view where it is:
  // leaving does not go back to the end, so the row in view stays put.
  await act(() => { host.querySelector<HTMLElement>('[data-slot="tool-run"] button[aria-expanded]')!.click(); });
  scroller.scrollTop = 400;
  await click(shareButtons(host)[3]!);
  expect(topOfRow("b1")).toBe(100);
  await cancel();
  expect(topOfRow("b1")).toBe(100);
});

test("not picking, a new message redraws its own row, not every row's action line", async () => {
  const T = "t_s9";
  const many = Array.from({ length: 6 }, (_, i) => [user(T, `u${i}`, i * 2 + 1, `Question ${i}`), reply(T, `r${i}`, i * 2 + 2, `w${i}`, `Answer ${i}`)]).flat();
  await render({ type: "manager", threadId: T }, many);
  expect(shareButtons(host0()).length).toBe(12);
  // An action line formats its time each time it draws: count the clocks made.
  let clocks = 0;
  const Real = Intl.DateTimeFormat;
  const Counting = function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    const options = args[1];
    if (options?.hour && options.minute && !options.second && !options.month) clocks += 1;
    return new Real(...args);
  } as unknown as typeof Intl.DateTimeFormat;
  Intl.DateTimeFormat = Counting;
  onCleanup(() => { Intl.DateTimeFormat = Real; });
  act(() => { useAgentChatStore.getState().onMessageAppended(T, user(T, "u6", 13, "One more")); });
  await settle();
  expect(shareButtons(host0()).length).toBe(13);
  expect(clocks).toBeLessThanOrEqual(3);
});

test("a transcript with no conversation around it (History) offers no sharing", async () => {
  const messages = twoExchanges("t_s5");
  const state = { ...useAgentChatStore.getState() };
  void state;
  mockFetch(() => jsonResponse({}));
  const { host } = await mountAsync(
    <MemoryRouter>
      <ChatMessageList
        thread={{ threadId: "t_s5", messages, loaded: true, hasMoreOlder: false, oldestSeqLoaded: 1, pendingUserMessages: new Map(), streamingAssistant: null, wakePhase: { phase: "idle" }, monitors: [], wakeReasonsById: new Map() } as never}
        view="history"
        onLoadOlder={async () => {}}
      />
    </MemoryRouter>
  );
  await settle();
  expect(host.textContent).toContain("Partly, and at a cost.");
  expect(shareButtons(host).length).toBe(0);
});
