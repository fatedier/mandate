import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ChatMessageList } from "../../src/client/routes/window/chat/ChatMessageList.js";
import { NoticeRunHeader } from "../../src/client/routes/window/chat/NoticeRunLine.js";
import { noticeRunKeys, noticeRunOpenKey, noticeRuns, noticesInRuns, openNoticeRunPausesFollow } from "../../src/client/routes/window/chat/notice-runs.js";
import { causeForTriggerMessage } from "../../src/client/routes/window/chat/chatProvenance.js";
import type { DatedRow } from "../../src/client/routes/window/chat/transcript-rows.js";
import { newThreadState, useAgentChatStore, type AgentMessage, type ThreadState } from "../../src/client/store/agent-chat.js";
import { threadNoticeMetadata, type ThreadNotice } from "../../src/shared/thread-notice.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mount, mountAsync, settle } from "../helpers/mount.js";

// Notices from one thread that come one after another, while the personal
// agent says nothing between them, are one line: the latest, and how many.

afterEach(() => {
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const row = (seq: number, m: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">): AgentMessage => ({
  id: `m${seq}`, threadId: "g", seq, source: "self", sourceThreadId: null, wakeId: null,
  createdAt: `2026-11-17T10:${String(seq).padStart(2, "0")}:00.000Z`, ...m
} as AgentMessage);
const base: ThreadNotice = { handoffIds: [], kind: "thread", targetThreadId: "thr_a", workerId: null, title: "Docs overhaul", stop: "stopped", reason: null, verdict: "result", after: true };
const notice = (seq: number, over: Partial<ThreadNotice> = {}) => {
  const n = { ...base, ...over };
  return row(seq, { role: "user", source: "thread-notice", sourceThreadId: n.targetThreadId, content: { type: "text", text: "[Thread notice] …", metadata: threadNoticeMetadata(n) } });
};
const reply = (seq: number, text: string) => row(seq, { role: "assistant", wakeId: `w${seq}`, content: { type: "assistant", text } });
const hidden = (seq: number) => row(seq, { role: "user", source: "runtime-context", content: { type: "text", text: "[runtime_context] …" } });
const item = (message: AgentMessage, cause?: AgentMessage): DatedRow => ({ kind: "item", item: { kind: "msg", message, ...(cause ? { cause } : {}) } as never });
const date: DatedRow = { kind: "date", key: "d", timestamp: "2026-11-17T10:30:00.000Z", label: "10:30" };

test("notices next to each other from one thread make a run; a row drawn as nothing does not part them", () => {
  expect([...noticeRuns([item(notice(1)), item(notice(2)), item(hidden(3)), item(notice(4))])]).toEqual([[0, [0, 1, 3]]]);
  // One alone is no run.
  expect(noticeRuns([item(notice(1)), item(reply(2, "Done."))]).size).toBe(0);
});

test("another thread, a reply, a date line, or a notice drawn over its reply part a run", () => {
  const other = (seq: number) => notice(seq, { targetThreadId: "thr_b", title: "Release" });
  expect([...noticeRuns([item(notice(1)), item(other(2)), item(other(3)), item(reply(4, "Noted.")), item(other(5)), item(other(6))])])
    .toEqual([[1, [1, 2]], [4, [4, 5]]]);
  expect(noticeRuns([item(notice(1)), date, item(notice(2))]).size).toBe(0);
  // A notice whose wake answered rides on the reply: that row is the reply's.
  expect(noticeRuns([item(notice(1)), item(reply(3, "Told the user."), notice(2)), item(notice(4))]).size).toBe(0);
  // A worker's notices go by the worker.
  const worker = (seq: number, workerId: string) => notice(seq, { kind: "worker", workerId, targetThreadId: "thr_w", title: "release" });
  expect([...noticeRuns([item(worker(1, "wkr_1")), item(worker(2, "wkr_1")), item(worker(3, "wkr_2"))])]).toEqual([[0, [0, 1]]]);
});

const latest = causeForTriggerMessage(notice(3, { verdict: "decision" }), () => null)!;

test("a run's line is the latest notice's with how many, and its count opens it", () => {
  const asked: boolean[] = [];
  const { host, rerender } = mount(<NoticeRunHeader latest={latest} count={3} open={false} onOpenChange={(next) => { asked.push(next); }} />, { path: "/agent" });
  const toggle = host.querySelector<HTMLButtonElement>('[data-slot="notice-run-toggle"]')!;
  expect([host.querySelector('[data-slot="provenance-label"]')!.textContent, toggle.textContent]).toEqual(["Docs overhaul · decision needed", "· 3 updates"]);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  act(() => { toggle.click(); });
  expect(asked).toEqual([true]);
  rerender(<NoticeRunHeader latest={latest} count={3} open onOpenChange={(next) => { asked.push(next); }} />);
  expect(host.querySelector('[data-slot="notice-run-toggle"]')!.getAttribute("aria-expanded")).toBe("true");
});

const labels = (host: HTMLElement) => [...host.querySelectorAll('[data-slot="provenance-label"]')].map((e) => e.textContent);
const memberRows = (host: HTMLElement) => [...host.querySelectorAll('[data-slot="notice-run-member"]')];
const count = (host: HTMLElement) => host.querySelector('[data-slot="notice-run-toggle"]')?.textContent ?? null;

test("in the personal agent's chat a run is drawn as one line, and opens in place", async () => {
  const thread: ThreadState = {
    ...newThreadState(), threadId: "g", loaded: true, oldestSeqLoaded: 1,
    messages: [reply(1, "Sent it to Docs overhaul."), notice(2), notice(3, { verdict: "decision" }), notice(4, { targetThreadId: "thr_b", title: "Release" })]
  };
  const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} />, { path: "/agent" });
  await settle();
  expect([labels(host), count(host)]).toEqual([["Docs overhaul · decision needed", "Release · result to read"], "· 2 updates"]);
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-slot="notice-run-toggle"]')!.click(); });
  expect(labels(host)).toEqual(["Docs overhaul · decision needed", "Docs overhaul · result to read", "Docs overhaul · decision needed", "Release · result to read"]);
  // Each notice of the open run is a row of the transcript, as the list
  // keeps a reader's place by its rows.
  expect(memberRows(host).map((m) => m.parentElement!.getAttribute("data-slot"))).toEqual(["transcript-row", "transcript-row"]);
});

// The New line goes above the first notice not read yet, so a run is cut
// there, as a run of tool steps is.
test("a run is cut where what was not read yet begins", () => {
  const entries = [item(notice(1)), item(notice(2)), item(notice(3)), item(notice(4))];
  expect([...noticeRuns(entries, 3)]).toEqual([[0, [0, 1]], [2, [2, 3]]]);
  expect([...noticeRuns(entries, 2)]).toEqual([[1, [1, 2, 3]]]);
  expect([...noticeRuns(entries, null)]).toEqual([[0, [0, 1, 2, 3]]]);
});

// An open run is read where it is; following the end would scroll it away
// as it grows. It is read from the runs drawn, so a run gone (its latest
// drawn over the reply its wake gave) holds no pause.
test("an open run pauses following; a notice marked open whose run is gone does not", () => {
  const marks = new Set([noticeRunOpenKey("m3")]);
  expect(openNoticeRunPausesFollow(noticesInRuns([item(notice(2)), item(notice(3))], null), new Set())).toBe(false);
  expect(openNoticeRunPausesFollow(noticesInRuns([item(notice(2)), item(notice(3))], null), marks)).toBe(true);
  expect(openNoticeRunPausesFollow(noticesInRuns([item(notice(2)), item(reply(4, "Told the user."), notice(3))], null), marks)).toBe(false);
});

// A run keeps its key as notices join it below or load above, so its row
// (a focused count, an open peek) stays the same row.
test("a run keeps the key its notices had, either way it grows; two parts of a cut run get two", () => {
  const two = [item(notice(3)), item(notice(4))];
  const first = noticeRunKeys(two, noticeRuns(two), new Map());
  expect([...first.values()]).toEqual(["m3"]);
  const known = new Map([["m3", "m3"], ["m4", "m3"]]);
  const grown = [item(notice(2)), item(notice(3)), item(notice(4)), item(notice(5))];
  expect([...noticeRunKeys(grown, noticeRuns(grown), known).values()]).toEqual(["m3"]);
  // Cut at the New line: the first part keeps it, the second its own first.
  expect([...noticeRunKeys(grown, noticeRuns(grown, 4), known)]).toEqual([[0, "m3"], [2, "m4"]]);
});

// Older notices loaded above an open run join it; it stays open.
test("a run opened stays open as older notices of it load above", async () => {
  const state = (messages: AgentMessage[]): ThreadState => ({ ...newThreadState(), threadId: "g", loaded: true, oldestSeqLoaded: messages[0]!.seq, hasMoreOlder: true, messages });
  const { host, rerender } = await mountAsync(<ChatMessageList thread={state([notice(3), notice(4, { verdict: "decision" })])} onLoadOlder={async () => {}} />, { path: "/agent" });
  await settle();
  const rows = () => memberRows(host).length;
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-slot="notice-run-toggle"]')!.click(); });
  expect(rows()).toBe(2);
  rerender(<ChatMessageList thread={state([notice(2), notice(3), notice(4, { verdict: "decision" })])} onLoadOlder={async () => {}} />);
  await settle();
  expect(rows()).toBe(3);
  // Closed, it is closed whole.
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-slot="notice-run-toggle"]')!.click(); });
  expect(rows()).toBe(0);
});

test("in the chat, the New line goes above the first notice not read yet, and that notice starts its own run", async () => {
  const thread: ThreadState = {
    ...newThreadState(), threadId: "g", loaded: true, oldestSeqLoaded: 1,
    messages: [reply(1, "Following Docs overhaul."), notice(2), notice(3, { verdict: "decision" }), notice(4), reply(5, "It needs your decision.")]
  };
  const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} newSince={2} />, { path: "/agent" });
  await settle();
  const line = host.querySelector('[data-slot="new-replies-line"]');
  expect(line === null).toBe(false);
  // Read: the notice before the line, on its own; not read: the run after it.
  const before = [...host.querySelectorAll('[data-slot="provenance-label"]')].filter((e) => line!.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING).map((e) => e.textContent);
  const after = [...host.querySelectorAll('[data-slot="provenance-label"]')].filter((e) => line!.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING).map((e) => e.textContent);
  expect([before, after, count(host)]).toEqual([["Docs overhaul · result to read"], ["Docs overhaul · result to read"], "· 2 updates"]);
});

// A notice joining a run below, or an older one loading above it, keeps the
// run's line the same element: the count the keys are on keeps the focus.
test("a run keeps its line as notices join it below or load above: the count keeps the focus", async () => {
  const state = (messages: AgentMessage[]): ThreadState => ({ ...newThreadState(), threadId: "g", loaded: true, oldestSeqLoaded: messages[0]!.seq, hasMoreOlder: true, messages });
  const list = (messages: AgentMessage[]) => <ChatMessageList thread={state(messages)} onLoadOlder={async () => {}} />;
  const { host, rerender } = await mountAsync(list([notice(3), notice(4)]), { path: "/agent" });
  await settle();
  const toggle = host.querySelector<HTMLButtonElement>('[data-slot="notice-run-toggle"]')!;
  act(() => { toggle.focus(); });
  rerender(list([notice(3), notice(4), notice(5, { verdict: "decision" })]));
  await settle();
  expect([host.querySelector('[data-slot="notice-run-toggle"]') === toggle, document.activeElement === toggle]).toEqual([true, true]);
  rerender(list([notice(2), notice(3), notice(4), notice(5, { verdict: "decision" })]));
  await settle();
  expect([host.querySelector('[data-slot="notice-run-toggle"]') === toggle, document.activeElement === toggle]).toEqual([true, true]);
  expect([labels(host), count(host)]).toEqual([["Docs overhaul · decision needed"], "· 4 updates"]);
});

// A reader's place is a message another list can find (History opens at
// it): the run's row is placed by its latest notice.
test("a run's row is placed by its latest notice, as another list of the same thread places it", async () => {
  const state = (messages: AgentMessage[]): ThreadState => ({ ...newThreadState(), threadId: "g", loaded: true, oldestSeqLoaded: messages[0]!.seq, hasMoreOlder: true, messages });
  const list = (messages: AgentMessage[]) => <ChatMessageList thread={state(messages)} onLoadOlder={async () => {}} />;
  const placeOf = (host: HTMLElement) => host.querySelector('[data-slot="notice-run"]')!.closest('[data-slot="transcript-row"]')!.getAttribute("data-row-key");
  const first = await mountAsync(list([notice(3), notice(4)]), { path: "/agent" });
  await settle();
  first.rerender(list([notice(2), notice(3), notice(4)]));
  await settle();
  const other = await mountAsync(list([notice(2), notice(3), notice(4)]), { path: "/agent" });
  await settle();
  expect([placeOf(first.host), placeOf(other.host)]).toEqual(["m4", "m4"]);
});

// The latest notice drawn as a name that opens its reply, or as a plain link,
// leaves the count the same element.
test("the count stays the same element when the latest notice's line changes kind", async () => {
  const state = (messages: AgentMessage[]): ThreadState => ({ ...newThreadState(), threadId: "g", loaded: true, oldestSeqLoaded: 1, messages });
  const list = (messages: AgentMessage[]) => <ChatMessageList thread={state(messages)} onLoadOlder={async () => {}} />;
  const { host, rerender } = await mountAsync(list([reply(1, "Following."), notice(2), notice(3)]), { path: "/agent" });
  await settle();
  const toggle = host.querySelector<HTMLButtonElement>('[data-slot="notice-run-toggle"]')!;
  act(() => { toggle.focus(); });
  // A wait of the agent's ends: its notice names the reply, which the name opens.
  rerender(list([reply(1, "Following."), notice(2), notice(3), notice(4, { handoffIds: ["hof_1"], after: undefined, verdict: undefined })]));
  await settle();
  expect(host.querySelector('[data-slot="notice-name"]') === null).toBe(false);
  expect([host.querySelector('[data-slot="notice-run-toggle"]') === toggle, document.activeElement === toggle]).toEqual([true, true]);
});

// An open run's notices stand close; a time over one would cover the notice
// above it. The run's line has the latest's time.
test("an open run's notices carry no time of their own", async () => {
  const thread: ThreadState = { ...newThreadState(), threadId: "g", loaded: true, oldestSeqLoaded: 1, messages: [reply(1, "Following."), notice(2), notice(3)] };
  const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} />, { path: "/agent" });
  await settle();
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-slot="notice-run-toggle"]')!.click(); });
  expect(memberRows(host).length).toBe(2);
  expect(memberRows(host).map((m) => m.parentElement!.querySelector('[data-slot="row-time"]') === null)).toEqual([true, true]);
  expect(host.querySelector('[data-slot="notice-run"]')!.closest('[data-slot="transcript-row"]')!.querySelector('[data-slot="row-time"]') === null).toBe(false);
});

// The run's row says which notices it holds, so a place saved on any of them
// (an open notice, a part a New line cut off) is found.
test("a run's row holds each of its notices", async () => {
  const thread: ThreadState = { ...newThreadState(), threadId: "g", loaded: true, oldestSeqLoaded: 1, messages: [reply(1, "Following."), notice(2), notice(3), notice(4)] };
  const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} />, { path: "/agent" });
  await settle();
  expect(host.querySelector('[data-slot="notice-run"]')!.closest('[data-slot="transcript-row"]')!.getAttribute("data-row-holds")).toBe("m2 m3 m4");
});
