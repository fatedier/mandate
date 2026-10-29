import { beforeEach, expect, test } from "bun:test";
import { SSE_EVENTS } from "@shared/api-contracts";
import { attachSnapshotSseListeners } from "@/lib/snapshot-sse-listeners";
import { newThreadState, scopeKey, useAgentChatStore } from "@/store/agent-chat";
import { useInterruptedWakesStore } from "@/store/interrupted-wakes";
import { onCleanup } from "../helpers/cleanup";

// A turn a person stopped did not finish, and its last line says so. The page
// hears of a stop as it happens: Stop marks the turn, and the turn's end event
// decides, since a turn Stop was pressed on can have ended by itself first.

const ids = () => [...useInterruptedWakesStore.getState().ids].sort();

beforeEach(() => {
  useInterruptedWakesStore.setState({ ids: new Set() });
  onCleanup(() => useInterruptedWakesStore.setState({ ids: new Set() }));
});

test("a turn's end decides whether a person stopped it: canceled marks it, any other ending clears it", () => {
  const { stopping, ended } = useInterruptedWakesStore.getState();
  // Stopped from elsewhere: the end event alone marks it.
  ended("w1", "canceled");
  expect(ids()).toEqual(["w1"]);
  // Stop was pressed here, and the turn then ended stopped.
  stopping("w2");
  expect(ids()).toEqual(["w1", "w2"]);
  ended("w2", "canceled");
  expect(ids()).toEqual(["w1", "w2"]);
  // Stop was pressed on a turn that had ended by itself: its end says so.
  for (const status of ["finished", "error", "stuck", "limit_reached"]) {
    stopping(`late-${status}`);
    expect(useInterruptedWakesStore.getState().ids.has(`late-${status}`)).toBe(true);
    ended(`late-${status}`, status);
  }
  expect(ids()).toEqual(["w1", "w2"]);
  // A turn nobody stopped is never among them.
  ended("w3", "finished");
  expect(ids()).toEqual(["w1", "w2"]);
});

test("the set is the same one while nothing changes, so nothing reading it is drawn again", () => {
  const { stopping, ended } = useInterruptedWakesStore.getState();
  stopping("w1");
  const before = useInterruptedWakesStore.getState().ids;
  stopping("w1");
  ended("w1", "canceled");
  ended("w2", "finished");
  expect(useInterruptedWakesStore.getState().ids).toBe(before);
  // And a change makes a new one: the old set is not written into.
  ended("w2", "canceled");
  expect(useInterruptedWakesStore.getState().ids).not.toBe(before);
  expect([...before]).toEqual(["w1"]);
});

test("the end event of a stopped turn is kept though its conversation is not loaded yet, and before the chat shows the turn idle", () => {
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  const send = (data: Record<string, unknown>) => source.dispatchEvent(new MessageEvent(SSE_EVENTS.agentWakeFinished, { data: JSON.stringify(data) }));
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  onCleanup(() => useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() }));

  // No conversation on this page holds thread t9: its first read is still under way.
  send({ threadId: "t9", wakeId: "w9", status: "canceled" });
  expect(ids()).toEqual(["w9"]);

  // A loaded conversation: when the chat turns idle the turn is already marked.
  const scope = { type: "worker" as const, featureId: "f1" };
  useAgentChatStore.setState({ threadsByScope: new Map([[scopeKey(scope), { ...newThreadState(), threadId: "t1", loaded: true }]]) });
  useAgentChatStore.getState().onWakeStarted("t1", "w1", "user");
  const seen: Array<[string, boolean]> = [];
  onCleanup(useAgentChatStore.subscribe((state) => {
    seen.push([state.threadsByScope.get(scopeKey(scope))!.wakePhase.phase, useInterruptedWakesStore.getState().ids.has("w1")]);
  }));
  send({ threadId: "t1", wakeId: "w1", status: "canceled" });
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter(([phase]) => phase === "idle")).toStrictEqual(seen.filter(([phase, marked]) => phase === "idle" && marked));
  expect(seen.at(-1)).toEqual(["idle", true]);

  // A turn that ended by itself after Stop was pressed on it: unmarked by the same event.
  useInterruptedWakesStore.getState().stopping("w5");
  send({ threadId: "t1", wakeId: "w5", status: "finished" });
  expect(ids()).toEqual(["w1", "w9"]);
});
