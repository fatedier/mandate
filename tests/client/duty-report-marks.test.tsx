import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ChatMessageList } from "../../src/client/routes/window/chat/ChatMessageList.js";
import { newThreadState, useAgentChatStore, type AgentMessage, type ThreadState } from "../../src/client/store/agent-chat.js";
import { usePersonalAgentStore } from "../../src/client/store/personal-agent.js";
import { attachSnapshotSseListeners } from "../../src/client/lib/snapshot-sse-listeners.js";
import { SSE_EVENTS } from "../../src/shared/api-contracts.js";
import type { PersonalAgentDto } from "../../src/shared/api/personal-agent.js";
import type { DutyReportOutcome } from "../../src/shared/api/schedules.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mergeMessages } from "../../src/client/store/agent-chat-utils.js";
import { waitUntil } from "../helpers/wait.js";

afterEach(() => {
  // Unmount before the chat store is reset under the list.
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map(), dutyMarks: new Map() });
  usePersonalAgentStore.setState({ agent: null });
});

const at = "2026-11-04T09:00:00.000Z";
const reply = (seq: number, text: string, dutyReport?: DutyReportOutcome): AgentMessage =>
  ({ id: `m${seq}`, threadId: "t1", seq, role: "assistant", source: "self", sourceThreadId: null, wakeId: `w${seq}`, createdAt: at,
    content: { type: "assistant", text }, ...(dutyReport ? { dutyReport } : {}) }) as AgentMessage;
const thread = (messages: AgentMessage[]): ThreadState =>
  ({ ...newThreadState(), threadId: "t1", loaded: true, messages, oldestSeqLoaded: 1 });

async function render(messages: AgentMessage[]) {
  act(() => usePersonalAgentStore.setState({ agent: { name: "Juno", named: true } as PersonalAgentDto }));
  const view = await mountAsync(<ChatMessageList thread={thread(messages)} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  await settle();
  return view.host;
}
const marks = (host: HTMLElement) => [...host.querySelectorAll('[data-slot="duty-report-mark"]')].map((m) => m.textContent);

test("a reply sent as the report says so, and so does one kept back with NO_REPORT; the others say nothing", async () => {
  const host = await render([
    reply(1, "Bed 3 moisture fell to 12%; a worker is on it.", "sent"),
    reply(2, "NO_REPORT", "no_report"),
    reply(3, "Noted what the user asked.", "owner_note"),
    reply(4, "Done: the brief is in my notes.", "told_by_wait"),
    reply(5, "Looking at the beds.")
  ]);
  expect(marks(host)).toEqual(["Sent to Juno as the report", "NO_REPORT · not sent to Juno"]);
  // The mark says it: the bare word is not drawn again as the reply.
  const text = host.textContent ?? "";
  expect(text.split("NO_REPORT").length - 1).toBe(1);
  expect(text).toContain("Bed 3 moisture fell to 12%");
  expect(text).toContain("Noted what the user asked.");
});

test("a report recorded while the chat is open marks its reply", async () => {
  useAgentChatStore.setState({ threadsByScope: new Map([["manager:t1", thread([reply(1, "Bed 3 moisture fell to 12%."), reply(2, "Looking.")])]]) });
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  source.dispatchEvent(new MessageEvent(SSE_EVENTS.dutyReportRecorded, { data: JSON.stringify({ threadId: "t1", messageId: "m1", outcome: "sent" }) }));
  const messages = useAgentChatStore.getState().threadsByScope.get("manager:t1")!.messages;
  expect(messages.map((m) => m.dutyReport ?? null)).toEqual(["sent", null]);
  const host = await render(messages);
  expect(marks(host)).toEqual(["Sent to Juno as the report"]);
});

test("a report recorded while the stream was down is read again at the reconnect, from the thread's latest reply", async () => {
  const user = (seq: number): AgentMessage => ({ id: `m${seq}`, threadId: "t1", seq, role: "user", source: "user", sourceThreadId: null, wakeId: null, createdAt: at, content: { type: "text", text: "ok" } }) as AgentMessage;
  useAgentChatStore.setState({ threadsByScope: new Map([["manager:t1", thread([reply(1, "Looking."), reply(2, "Bed 3 moisture fell to 12%."), user(3)])]]) });
  const asked: string[] = [];
  mockFetch((call) => {
    asked.push(call.url);
    // What the server holds since the latest reply, the reply marked now.
    return jsonResponse({ thread: { id: "t1" }, messages: [reply(2, "Bed 3 moisture fell to 12%.", "sent"), user(3)], hasMore: false, contextUsage: null, activeWake: null, monitors: null, monitorsRevision: null, readAt: at });
  });
  await useAgentChatStore.getState().refetchIncrementalForOpenScopes();
  expect(asked.map((url) => new URL(url, "http://x").searchParams.get("since"))).toStrictEqual(["1"]);
  expect(useAgentChatStore.getState().threadsByScope.get("manager:t1")!.messages.map((m) => m.dutyReport ?? null)).toEqual([null, "sent", null]);
});

test("a report heard while the thread's page is still on its way is kept, and an older page does not take it back", async () => {
  // Heard before the reply is held: the page that brings it says nothing of it.
  useAgentChatStore.getState().onDutyReport("t1", "m1", "sent");
  const host = await render([reply(1, "Bed 3 moisture fell to 12%."), reply(2, "Looking.")]);
  expect(marks(host)).toEqual(["Sent to Juno as the report"]);
  // A page merged over a marked reply keeps its mark.
  expect(mergeMessages([reply(2, "NO_REPORT", "no_report")], [reply(2, "NO_REPORT")]).map((m) => m.dutyReport ?? null)).toEqual(["no_report"]);
});

test("after a duty thread's first page, the catch-up reads from its latest reply, which may have been marked meanwhile", async () => {
  const user = (seq: number): AgentMessage => ({ id: `m${seq}`, threadId: "t1", seq, role: "user", source: "user", sourceThreadId: null, wakeId: null, createdAt: at, content: { type: "text", text: "ok" } }) as AgentMessage;
  const body = (messages: AgentMessage[]) => ({ thread: { id: "t1" }, messages, hasMore: false, contextUsage: null, activeWake: null, monitors: null, monitorsRevision: null, readAt: at });
  const asked: string[] = [];
  mockFetch((call) => {
    asked.push(call.url);
    const since = new URL(call.url, "http://x").searchParams.get("since");
    // The page as read before the mark; the catch-up as the server holds it now.
    return jsonResponse(since === null ? body([reply(1, "Bed 3 moisture fell to 12%."), user(2)]) : body([reply(1, "Bed 3 moisture fell to 12%.", "sent"), user(2)]));
  });
  await useAgentChatStore.getState().ensureThreadLoaded({ type: "manager", threadId: "t1" });
  await waitUntil(() => asked.length >= 2 || null, { timeout: 2000, label: "the catch-up" });
  await waitUntil(() => useAgentChatStore.getState().threadsByScope.get("manager:t1")?.messages[0]?.dutyReport === "sent" || null, {
    timeout: 2000, label: () => `the mark (asked ${asked.join(", ")})`
  });
  expect(new URL(asked[1]!, "http://x").searchParams.get("since")).toBe("0");
});
