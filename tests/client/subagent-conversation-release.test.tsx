import { afterEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { useSubagentConversation } from "@/hooks/useSubagentThread";
import { RELEASE_AFTER_MS, scopeKey, useAgentChatStore } from "@/store/agent-chat";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { fakeClock, realClock } from "../helpers/fake-clock.js";

afterEach(() => {
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

function Steps({ threadId }: { threadId: string }) {
  const { thread } = useSubagentConversation(threadId);
  return <div data-slot="steps">{thread?.loaded ? "loaded" : "loading"}</div>;
}

// A view showing a subagent's conversation holds it while it is shown; the
// conversation is let go a while after no view shows it.
test("a subagent's conversation is let go a while after the last view showing it closes", async () => {
  mockFetch(() => jsonResponse({ thread: { id: "thr_child_v1" }, messages: [], hasMore: false, contextUsage: null, activeWake: null, readAt: null }));
  const key = scopeKey({ type: "subagent", threadId: "thr_child_v1" });
  const { host, unmount } = await mountAsync(<><Steps threadId="thr_child_v1" /><Steps threadId="thr_child_v1" /></>);
  await settle();
  expect([...host.querySelectorAll('[data-slot="steps"]')].map((node) => node.textContent)).toEqual(["loaded", "loaded"]);
  fakeClock();
  act(() => { unmount(); jest.advanceTimersByTime(RELEASE_AFTER_MS); });
  expect(useAgentChatStore.getState().threadsByScope.has(key)).toBe(false);
});

function WholeSteps({ threadId }: { threadId: string }) {
  const { thread, olderError } = useSubagentConversation(threadId, { whole: true });
  return <div data-slot="steps">{olderError ? `error: ${olderError}` : thread?.loaded ? `${thread.messages.length} rows` : "loading"}</div>;
}

// What the view asked for of a conversation is the entry's: let go and read
// again, its older pages are asked for anew, and a request from before is
// not waited on, nor its failure shown.
test("opened again after it was let go, its older pages are asked for anew; the old request's failure is not shown", async () => {
  const id = "thr_child_v2";
  const step = (seq: number) => ({
    id: `v2-${seq}`, threadId: id, seq, role: "assistant", source: "self", wakeId: "w", createdAt: `2026-10-19T09:00:${String(seq).padStart(2, "0")}.000Z`,
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: `c${seq}`, toolName: "read", args: { path: "/repo/a" } }] }
  });
  const olderAnswers: Array<(response: Response) => void> = [];
  const calls = mockFetch((call) => call.url.includes("before=")
    ? new Promise<Response>((resolve) => { olderAnswers.push(resolve); })
    : call.url.includes("since=")
      ? jsonResponse({ thread: { id }, messages: [], hasMore: false, contextUsage: null, activeWake: null, readAt: null })
      : jsonResponse({ thread: { id }, messages: [step(51)], hasMore: true, contextUsage: null, activeWake: null, readAt: null }));
  const older = () => calls.filter((c) => c.url.includes("before=51")).length;
  const first = await mountAsync(<WholeSteps threadId={id} />);
  await settle();
  expect(older()).toBe(1);
  jest.useFakeTimers();
  act(() => { first.unmount(); jest.advanceTimersByTime(RELEASE_AFTER_MS); });
  realClock();
  const { host } = await mountAsync(<WholeSteps threadId={id} />);
  await settle();
  expect(older()).toBe(2);
  // The request from before the let-go fails now: not this view's.
  await act(async () => { olderAnswers[0]!(jsonResponse({ error: "gone" }, 500)); });
  await settle();
  expect(host.textContent).not.toContain("error:");
  await act(async () => { olderAnswers[1]!(jsonResponse({ thread: { id }, messages: [step(1)], hasMore: false, contextUsage: null, activeWake: null, readAt: null })); });
  await settle();
  expect(host.textContent).toBe("2 rows");
  // Asked for once more, not again for the old request's failure.
  expect(older()).toBe(2);
});

function LoggedSteps({ threadId, log }: { threadId: string; log: string[] }) {
  const { thread, olderError } = useSubagentConversation(threadId, { whole: true });
  const text = olderError ? `error: ${olderError}` : thread?.loaded ? "loaded" : "loading";
  log.push(text);
  return <div data-slot="steps">{text}</div>;
}

test("a failure from before it was let go is never shown when it is opened again, not even for a moment", async () => {
  const id = "thr_child_v3";
  const step = (seq: number) => ({
    id: `v3-${seq}`, threadId: id, seq, role: "assistant", source: "self", wakeId: "w", createdAt: "2026-10-19T09:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: `c${seq}`, toolName: "read", args: { path: "/repo/a" } }] }
  });
  let fail = true;
  mockFetch((call) => call.url.includes("before=")
    ? (fail ? jsonResponse({ error: "gone" }, 500) : new Promise<Response>(() => {}))
    : call.url.includes("since=")
      ? jsonResponse({ thread: { id }, messages: [], hasMore: false, contextUsage: null, activeWake: null, readAt: null })
      : jsonResponse({ thread: { id }, messages: [step(51)], hasMore: true, contextUsage: null, activeWake: null, readAt: null }));
  const before: string[] = [];
  const first = await mountAsync(<LoggedSteps threadId={id} log={before} />);
  await settle();
  expect(before.at(-1)).toContain("error:");
  fail = false;
  jest.useFakeTimers();
  act(() => { first.unmount(); jest.advanceTimersByTime(RELEASE_AFTER_MS); });
  realClock();
  const after: string[] = [];
  await mountAsync(<LoggedSteps threadId={id} log={after} />);
  await settle();
  expect(after.at(-1)).toBe("loaded");
  expect(after.filter((text) => text.startsWith("error:"))).toEqual([]);
});
