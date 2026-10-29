import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ChatMessageList } from "../../src/client/routes/window/chat/ChatMessageList.js";
import { newThreadState, useAgentChatStore, type AgentMessage, type ThreadState } from "../../src/client/store/agent-chat.js";
import { useReasoningHeadingStore } from "../../src/client/store/reasoning-heading.js";
import { useReplyActivityStore } from "../../src/client/store/reply-activity.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle } from "../helpers/mount.js";

afterEach(() => {
  // Unmount before the stores the list reads are reset under it.
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  useReasoningHeadingStore.setState({ byWake: new Map() });
  useReplyActivityStore.setState({ byWake: new Map() });
});

const at = "2026-10-01T09:00:00.000Z";
const ask = { id: "m1", threadId: "t1", seq: 1, role: "user", source: "user", sourceThreadId: null, wakeId: null, createdAt: at, content: { type: "text", text: "Draft the notes" } } as AgentMessage;
const thinking = (wakeId: string): ThreadState =>
  ({ ...newThreadState(), threadId: "t1", loaded: true, messages: [ask], oldestSeqLoaded: 1, wakePhase: { wakeId, phase: "thinking", startedAt: at } });

async function render(state: ThreadState) {
  const { host } = await mountAsync(<ChatMessageList thread={state} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  await settle();
  return host;
}
const verb = (host: HTMLElement) => host.querySelector('[data-slot="working-verb"]')?.textContent;

test("the working line names the heading its own wake's reasoning has reached, live", async () => {
  const host = await render(thinking("w1"));
  expect(verb(host)).toBe("Working…");
  act(() => useReasoningHeadingStore.getState().set("w1", "Gathering merged changes"));
  expect(verb(host)).toBe("Gathering merged changes…");
  act(() => useReasoningHeadingStore.getState().set("w1", "Checking the changelog format"));
  expect(verb(host)).toBe("Checking the changelog format…");
});

test("another wake's heading is not this one's", async () => {
  const host = await render(thinking("w2"));
  act(() => useReasoningHeadingStore.getState().set("w1", "Gathering merged changes"));
  expect(verb(host)).toBe("Working…");
});
