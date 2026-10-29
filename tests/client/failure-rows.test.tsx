import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ChatMessageList } from "../../src/client/routes/window/chat/ChatMessageList.js";
import { actionableFailureId } from "../../src/client/routes/window/chat/failure-action.js";
import { newThreadState, useAgentChatStore, type AgentMessage, type ThreadState } from "../../src/client/store/agent-chat.js";
import type { WakeFailureContent } from "../../src/shared/agent-message-types.js";
import { runCleanups } from "../helpers/cleanup.js";
import { withFetch } from "../helpers/fetch.js";
import { mountAsync, settle, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;
afterEach(() => {
  // Unmount before the chat store is reset under the list.
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const at = "2026-09-30T09:00:00.000Z";
const row = (seq: number, m: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">): AgentMessage =>
  ({ id: `m${seq}`, threadId: "t1", seq, source: "user", sourceThreadId: null, wakeId: null, createdAt: at, ...m }) as AgentMessage;
const ask = row(1, { role: "user", content: { type: "text", text: "Draft the release notes" } });
const reading = row(2, { role: "assistant", source: "self", wakeId: "w1", content: { type: "assistant", text: "Reading the log first." } });
const failed = (seq: number, wakeId: string, patch: Partial<WakeFailureContent> = {}) => row(seq, {
  role: "system", source: "wake-failure", wakeId,
  content: { type: "wake_failure", status: "error", message: "Model request timed out. Please retry.", stepCount: 1, ...patch }
});
const idle = { wakeId: null, phase: "idle" as const };

async function render(state: ThreadState, props: { onRetryWake?: (wakeId: string) => void; onContinue?: () => void } = {}) {
  view = await mountAsync(<ChatMessageList thread={state} onLoadOlder={async () => {}} onRetryFailed={() => {}} {...props} />);
  await settle();
  return view.host;
}
const thread = (messages: AgentMessage[], patch: Partial<ThreadState> = {}): ThreadState =>
  ({ ...newThreadState(), threadId: "t1", loaded: true, messages, oldestSeqLoaded: 1, ...patch });
const buttons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('[data-slot="wake-failure"] button')].map((b) => b.textContent);

test("the rule: the thread's last message, a failure, nothing pending, idle", () => {
  expect(actionableFailureId([ask, reading, failed(3, "w1")], false, true)).toBe("m3");
  expect(actionableFailureId([ask, failed(2, "w1"), { ...reading, id: "m3", seq: 3 }], false, true)).toBe(null);
  expect(actionableFailureId([ask, failed(2, "w1")], true, true)).toBe(null);
  expect(actionableFailureId([ask, failed(2, "w1")], false, false)).toBe(null);
  expect(actionableFailureId([], false, true)).toBe(null);
});

test("a failure row is drawn where it sits, with its reason and time, and Retry reruns its wake", async () => {
  const retried: string[] = [];
  const host = await render(thread([ask, reading, failed(3, "w1")]), { onRetryWake: (id) => retried.push(id) });
  const line = host.querySelector('[data-slot="wake-failure"]')!;
  expect(line.textContent).toContain("Failed");
  expect(line.textContent).toContain("Model request timed out. Please retry.");
  const text = host.textContent ?? "";
  expect(text.indexOf("Reading the log first.")).toBeLessThan(text.indexOf("Model request timed out"));
  expect(buttons(host)).toEqual(["Retry"]);
  act(() => host.querySelector<HTMLButtonElement>('[data-slot="wake-failure"] button')!.click());
  expect(retried).toStrictEqual(["w1"]);
});

const stopRows: Array<{ name: string; before: AgentMessage[]; status: WakeFailureContent["status"]; message: string; stepCount: number }> = [
  {
    name: "a stuck turn says Stopped and why, and offers Continue",
    before: [ask], status: "stuck", message: "spawn_pane failed 5 times in a row: can't find window", stepCount: 5
  },
  {
    name: "a turn whose replies kept being cut off says Stopped and why, and offers Continue",
    before: [ask, reading], status: "cut_off", message: "Cut off at the output token limit.", stepCount: 3
  }
];

test.each(stopRows)("$name", async ({ before, status, message, stepCount }) => {
  let continued = 0;
  const stop = failed(before.length + 1, "w1", { status, message, stepCount });
  const host = await render(thread([...before, stop], { wakePhase: idle }), { onRetryWake: () => {}, onContinue: () => { continued++; } });
  const line = host.querySelector('[data-slot="wake-failure"]')!;
  expect(line.textContent).toContain("Stopped");
  expect(line.textContent).not.toContain("Failed");
  expect(line.textContent).toContain(message);
  expect(buttons(host)).toEqual(["Continue"]);
  act(() => host.querySelector<HTMLButtonElement>('[data-slot="wake-failure"] button')!.click());
  expect(continued).toBe(1);
});

test("a later wake that said nothing still takes the button away", async () => {
  const silent = row(4, { role: "assistant", source: "self", wakeId: "w2", content: { type: "assistant", text: "" } });
  const host = await render(thread([ask, reading, failed(3, "w1"), silent]), { onRetryWake: () => {} });
  expect(host.querySelectorAll('[data-slot="wake-failure"]')).toHaveLength(1);
  expect(buttons(host)).toEqual([]);
});

test("no button while a turn runs, while compressing, while a send is pending, or without the actions", async () => {
  const base = thread([ask, failed(2, "w1")]);
  let host = await render({ ...base, wakePhase: { wakeId: "w2", phase: "thinking" } }, { onRetryWake: () => {} });
  expect(buttons(host)).toEqual([]);
  view!.unmount();
  host = await render({ ...base, compressionPhase: { compressionId: "c1", startedAt: at } }, { onRetryWake: () => {} });
  expect(buttons(host)).toEqual([]);
  view!.unmount();
  host = await render({ ...base, pendingUserMessages: new Map([["l1", { localId: "l1", content: "and this", status: "sending", createdAt: at }]]) }, { onRetryWake: () => {} });
  expect(buttons(host)).toEqual([]);
  view!.unmount();
  host = await render(base);
  expect(host.querySelectorAll('[data-slot="wake-failure"]')).toHaveLength(1);
  expect(buttons(host)).toEqual([]);
  view!.unmount();
  // The fixture holds: idle, nothing pending, with the action.
  host = await render({ ...base, wakePhase: idle }, { onRetryWake: () => {} });
  expect(buttons(host)).toEqual(["Retry"]);
});

test("a failure between an alarm and a retry's reply sits between them", async () => {
  const alarm = row(1, { role: "user", source: "alarm", wakeId: "wA", wakeReason: "alarm", content: { type: "text", text: ["[Mandate alarm fired]", "alarmId: alm-1", "note: Check the build result."].join("\n") } });
  const reply = row(3, { role: "assistant", source: "self", wakeId: "wR", wakeReason: "alarm", content: { type: "assistant", text: "The build is green." } });
  const host = await render(thread([alarm, failed(2, "wA"), reply]));
  const text = host.textContent ?? "";
  const [note, failure, answer] = ["Check the build result.", "Model request timed out", "The build is green."].map((s) => text.indexOf(s));
  expect(note).toBeGreaterThanOrEqual(0);
  expect(failure).toBeGreaterThan(note!);
  expect(answer).toBeGreaterThan(failure!);
});

test("a retry rereads the thread afterwards, refused or not", async () => {
  const SCOPE = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.setState({ threadsByScope: new Map([["worker:f1", thread([ask, failed(2, "w1")])]]) });
  for (const status of [200, 409]) {
    await withFetch(({ method }) => {
      if (method === "POST") return Response.json(status === 200 ? { ok: true, wakeId: "wR" } : { error: "the conversation has moved on since this turn failed" }, { status });
      return Response.json({ thread: { id: "t1" }, messages: [] });
    }, async (fetched) => {
      await useAgentChatStore.getState().retryWake(SCOPE, "w1");
      const calls = fetched.map((c) => `${c.method} ${c.url}`);
      expect({ status, calls: calls.map((c) => (c.startsWith("POST") ? "POST" : c.includes("since=") ? "GET since" : c)) }).toEqual({ status, calls: ["POST", "GET since"] });
    });
  }
});
