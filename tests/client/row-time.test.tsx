import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { ChatMessageList } from "../../src/client/routes/window/chat/ChatMessageList.js";
import { newThreadState, useAgentChatStore, type AgentMessage, type ThreadState } from "../../src/client/store/agent-chat.js";
import { featureMessageReplyMetadata } from "../../src/shared/feature-message.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle } from "../helpers/mount.js";

// A row's own time: it was a title on the whole row, which the
// browser popped over whatever was being read. Now the row shows its clock on
// hover in the gap above it, and only that small time names the full date;
// the dividers' times do too.

beforeEach(() => { setSystemTime(new Date("2026-10-09T11:10:00.000Z")); });
afterEach(() => {
  runCleanups();
  setSystemTime();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const row = (seq: number, at: string, m: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">): AgentMessage => ({
  id: `m${seq}`, threadId: "t1", seq, source: "self", sourceThreadId: null, wakeId: "w1", createdAt: at, ...m
} as AgentMessage);

const messages: AgentMessage[] = [
  row(1, "2026-10-09T10:58:07.000Z", { role: "user", source: "user", wakeId: null, content: { type: "text", text: "Is the gap real?" } }),
  row(2, "2026-10-09T11:04:52.000Z", { role: "assistant", content: { type: "assistant", text: "Yes, reproduced with a fresh index." } }),
  row(3, "2026-10-09T11:05:30.000Z", { role: "user", source: "feature-message", wakeId: null, content: { type: "text", text: "Harness saved; patch passes.", metadata: featureMessageReplyMetadata({ featureId: "f1", featureName: "Issue 72" }) } }),
  row(4, "2026-10-09T11:06:00.000Z", { role: "system", source: "self", wakeId: "w2", content: { type: "wake_failure", status: "error", message: "Model request timed out. Please retry.", stepCount: 3 } })
];

async function render(state: Partial<ThreadState> = {}) {
  const thread: ThreadState = { ...newThreadState(), threadId: "t1", loaded: true, messages, oldestSeqLoaded: 1, ...state };
  const { host } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  await settle();
  return host;
}

const FULL = /\b[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}:\d{2}\b/;

test("a row with no action line carries its clock in a hover time; the user's bubble and a reply carry theirs on their line", async () => {
  const host = await render();
  // The worker's reply keeps the hover time in the gap above it.
  const times = [...host.querySelectorAll<HTMLElement>('[data-slot="row-time"]')];
  expect(times.map((t) => [t.textContent, t.getAttribute("title"), t.getAttribute("datetime")])).toEqual([
    ["11:05", "Oct 9, 2026, 11:05:30", "2026-10-09T11:05:30.000Z"]
  ]);
  // The user's message and the reply: on the line under them.
  const stamps = [...host.querySelectorAll<HTMLElement>('[data-slot="row-actions"] time')];
  expect(stamps.map((t) => [t.textContent, t.getAttribute("title"), t.getAttribute("datetime")])).toEqual([
    ["10:58", "Oct 9, 2026, 10:58:07", "2026-10-09T10:58:07.000Z"],
    ["11:04", "Oct 9, 2026, 11:04:52", "2026-10-09T11:04:52.000Z"]
  ]);
  // Every full-date title left is on a small time: a row's, a divider's, or
  // a time the row shows itself (a failed turn's).
  const titled = [...host.querySelectorAll<HTMLElement>("[title]")].filter((el) => FULL.test(el.getAttribute("title") ?? ""));
  expect(titled.every((el) => el.tagName === "TIME")).toBe(true);
  expect(host.querySelector('[data-slot="user-bubble"]')!.hasAttribute("title")).toBe(false);
});

test("a reply under the line of the event that woke it shows that event's time in the gap, and its own on its line", async () => {
  const event = row(1, "2026-10-09T11:00:00.000Z", { role: "user", source: "alarm", wakeId: null, content: { type: "text", text: "[Mandate alarm]\nnote: check the build" } });
  const answer = row(2, "2026-10-09T11:00:40.000Z", { role: "assistant", wakeId: "w5", wakeReason: "alarm", content: { type: "assistant", text: "The build is green." } } as Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">);
  const host = await render({ messages: [event, answer] });
  expect([...host.querySelectorAll('[data-slot="row-time"]')].map((t) => t.textContent)).toEqual(["11:00"]);
  expect([...host.querySelectorAll('[data-slot="row-actions"] time')].map((t) => t.getAttribute("title"))).toEqual(["Oct 9, 2026, 11:00:40"]);
});

test("a divider's time names the full date", async () => {
  const host = await render();
  const divider = host.querySelector<HTMLElement>('[role="separator"] time')!;
  expect(divider.getAttribute("title")).toBe("Oct 9, 2026, 10:58:07");
});

test("a failed turn, which shows its own time, gets no hover time", async () => {
  const host = await render({ messages: [messages[3]!] });
  expect(host.querySelector('[data-slot="wake-failure"]')).not.toBeNull();
  expect(host.querySelectorAll('[data-slot="row-time"]')).toHaveLength(0);
});

// A reply streams in deltas, each redrawing the list: a row or a divider whose
// time did not change must not format it again (40 rows formatted 120 Intl
// formatters per delta, about 100ms at 300 rows). Six minutes apart, every
// row opens with a pause divider.
test("a streaming delta formats no row's or divider's time again", async () => {
  const many = Array.from({ length: 40 }, (_, i) => {
    const at = new Date(Date.parse("2026-10-09T06:00:00.000Z") + i * 6 * 60_000).toISOString();
    return row(i + 1, at, { role: "user", source: "user", wakeId: null, content: { type: "text", text: `Message ${i + 1}` } });
  });
  const thread: ThreadState = { ...newThreadState(), threadId: "t1", loaded: true, messages: many, oldestSeqLoaded: 1 };
  const { rerender } = await mountAsync(<ChatMessageList thread={thread} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  await settle(250);
  const Original = Intl.DateTimeFormat;
  let made = 0;
  Intl.DateTimeFormat = new Proxy(Original, {
    construct(target, args) { made++; return Reflect.construct(target, args); },
    apply(target, self, args) { made++; return Reflect.apply(target, self, args); }
  });
  try {
    rerender(<ChatMessageList thread={{ ...thread, streamingAssistant: { wakeId: "w9", totalText: "Partial" } }} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  } finally {
    Intl.DateTimeFormat = Original;
  }
  expect(document.querySelectorAll('[role="separator"]').length).toBeGreaterThan(30);
  expect(made).toBeLessThan(10);
});
