import { afterEach, expect, test } from "bun:test";
import { newThreadState, useAgentChatStore, type ThreadState } from "../../src/client/store/agent-chat.js";
import type { AgentPendingMonitorDto } from "../../src/shared/api/agents.js";
import { mockFetch } from "../helpers/fetch.js";

// What a thread's agent is still waiting on: every read of the
// thread carries the set, and agentMonitorsChanged sends it whenever it
// changes. Both carry one revision (the server's boot, then a count of
// changes), so the later wins, across a restart too.

afterEach(() => {
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const SCOPE = { type: "worker" as const, featureId: "monitors-f" };
const KEY = "worker:monitors-f";
const WATCH: AgentPendingMonitorDto = {
  kind: "pane", id: "ww_1", windowKey: "md-project-1:pr_48", paneId: "%103", stableMs: 45_000,
  timeoutAt: "2026-10-08T13:21:00.000Z", note: "read the review", createdAt: "2026-10-08T12:51:00.000Z"
};
const MONITOR: AgentPendingMonitorDto = {
  kind: "command", id: "mon_1", command: "gh pr checks 48", description: "project-1 CI on PR 48", everyMs: 300_000,
  wakeWhen: "succeeds", timeoutAt: "2026-10-08T13:40:00.000Z", note: "report the CI result", createdAt: "2026-10-08T12:40:00.000Z",
  runCount: 0, lastRunAt: null, nextRunAt: "2026-10-08T12:45:00.000Z", recentRuns: []
};

const monitors = () => useAgentChatStore.getState().threadsByScope.get(KEY)!.monitors;

function seedThread(patch: Partial<ThreadState>) {
  useAgentChatStore.setState({ threadsByScope: new Map([[KEY, { ...newThreadState(), threadId: "t1", ...patch }]]) });
}

test("a thread opened while its agent waits on a monitor holds that monitor", async () => {
  mockFetch(() => Response.json({ thread: { id: "t1" }, messages: [], hasMore: false, monitors: [WATCH], monitorsRevision: { boot: 1, seq: 100 } }));
  await useAgentChatStore.getState().ensureThreadLoaded(SCOPE);
  expect(monitors()).toEqual([WATCH]);
});

test("a change sent over SSE replaces the thread's set; one for a thread not loaded is dropped", () => {
  seedThread({ loaded: true, monitors: [WATCH], monitorsRevision: { boot: 1, seq: 100 } });
  useAgentChatStore.getState().onMonitorsChanged("t1", [WATCH, MONITOR], { boot: 1, seq: 101 });
  expect(monitors()).toEqual([WATCH, MONITOR]);
  useAgentChatStore.getState().onMonitorsChanged("t1", [], { boot: 1, seq: 102 });
  expect(monitors()).toEqual([]);
  // After a restart the count starts again, and the new boot is still later.
  useAgentChatStore.getState().onMonitorsChanged("t1", [WATCH], { boot: 2, seq: 1 });
  expect(monitors()).toEqual([WATCH]);
  useAgentChatStore.getState().onMonitorsChanged("t1", [MONITOR], { boot: 1, seq: 500 });
  expect(monitors()).toEqual([WATCH]);
  useAgentChatStore.getState().onMonitorsChanged("t1", [], { boot: 2, seq: 2 });
  expect(monitors()).toEqual([]);
  useAgentChatStore.getState().onMonitorsChanged("t-other", [MONITOR], { boot: 2, seq: 3 });
  expect(monitors()).toEqual([]);
  expect(useAgentChatStore.getState().threadsByScope.size).toBe(1);
});

test("a read made before the last change does not bring its older set back; a later one replaces it", async () => {
  // The watch fired, over SSE, while a read from before it was on its way.
  seedThread({ loaded: true, oldestSeqLoaded: 1, monitors: [], monitorsRevision: { boot: 1, seq: 101 } });
  let answer: { monitors: AgentPendingMonitorDto[]; monitorsRevision: { boot: number; seq: number } } = { monitors: [WATCH], monitorsRevision: { boot: 1, seq: 100 } };
  let read!: () => void;
  let done = new Promise<void>((resolve) => { read = resolve; });
  mockFetch(() => {
    queueMicrotask(read);
    return Response.json({ thread: { id: "t1" }, messages: [], ...answer });
  });
  await useAgentChatStore.getState().ensureThreadLoaded(SCOPE);
  await done;
  await Bun.sleep(0);
  expect(monitors()).toEqual([]);

  answer = { monitors: [MONITOR], monitorsRevision: { boot: 1, seq: 102 } };
  done = new Promise<void>((resolve) => { read = resolve; });
  await useAgentChatStore.getState().ensureThreadLoaded(SCOPE);
  await done;
  await Bun.sleep(0);
  expect(monitors()).toEqual([MONITOR]);
  // A change sent before that read is older than what it found; one with the
  // read's own revision is the same set.
  useAgentChatStore.getState().onMonitorsChanged("t1", [WATCH], { boot: 1, seq: 101 });
  expect(monitors()).toEqual([MONITOR]);
  useAgentChatStore.getState().onMonitorsChanged("t1", [MONITOR], { boot: 1, seq: 102 });
  expect(monitors()).toEqual([MONITOR]);
});

test("an agentMonitorsChanged event reaches the thread's set", async () => {
  const { attachSnapshotSseListeners } = await import("@/lib/snapshot-sse-listeners");
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  seedThread({ loaded: true, monitors: [], monitorsRevision: null });
  source.dispatchEvent(new MessageEvent("agentMonitorsChanged", { data: JSON.stringify({ threadId: "t1", monitors: [WATCH], revision: { boot: 1, seq: 7 } }) }));
  expect(monitors()).toEqual([WATCH]);
});

// A worker whose conversation did not exist when its page read it (thread
// null), and that the manager starts later: its first wake names the thread,
// so the page binds it and reads it once, monitors included, and later
// changes reach it.
test("a worker thread started after the page read it is bound by its first wake and read, monitors and all", async () => {
  seedThread({ threadId: null, loaded: true });
  let reads = 0;
  mockFetch(() => {
    reads++;
    return Response.json({ thread: { id: "t-new" }, messages: [], hasMore: false, monitors: [WATCH], monitorsRevision: { boot: 1, seq: 3 } });
  });
  useAgentChatStore.getState().onWakeStarted("t-new", "w1", "user", null, "2026-10-08T12:50:00.000Z", "worker", "monitors-f");
  await Bun.sleep(5);
  const thread = useAgentChatStore.getState().threadsByScope.get(KEY)!;
  expect(thread.threadId).toBe("t-new");
  expect(thread.wakePhase.phase).toBe("thinking");
  expect(monitors()).toEqual([WATCH]);
  expect(reads).toBe(1);
  useAgentChatStore.getState().onMonitorsChanged("t-new", [], { boot: 1, seq: 4 });
  expect(monitors()).toEqual([]);
  // Another worker's wake, or a manager's, binds nothing here.
  useAgentChatStore.getState().onWakeStarted("t-other", "w2", "user", null, undefined, "worker", "other-f");
  await Bun.sleep(5);
  expect(reads).toBe(1);
  expect(useAgentChatStore.getState().threadsByScope.size).toBe(1);
});

// The same worker's first wake can arrive while the page's first read is on
// its way, made before the thread existed (thread null): the wake still
// binds it, and the page reads it once that read lands.
test("a worker's first wake during the page's first read binds its thread, and the thread is read after", async () => {
  let answerFirst!: () => void;
  const held = new Promise<void>((resolve) => { answerFirst = resolve; });
  const calls = mockFetch(async (_call, index) => {
    if (index === 0) {
      await held;
      return Response.json({ thread: null, messages: [], hasMore: false, monitors: [], monitorsRevision: { boot: 1, seq: 2 } });
    }
    return Response.json({ thread: { id: "t-new" }, messages: [], hasMore: false, monitors: [WATCH], monitorsRevision: { boot: 1, seq: 3 } });
  });
  const load = useAgentChatStore.getState().ensureThreadLoaded(SCOPE);
  useAgentChatStore.getState().onWakeStarted("t-new", "w1", "user", null, "2026-10-08T12:50:00.000Z", "worker", "monitors-f");
  answerFirst();
  await load;
  await Bun.sleep(5);
  const thread = useAgentChatStore.getState().threadsByScope.get(KEY)!;
  expect(thread.threadId).toBe("t-new");
  expect(thread.loaded).toBe(true);
  expect(thread.wakePhase.phase).toBe("thinking");
  expect(monitors()).toEqual([WATCH]);
  // The read that found nothing, its first page, then the read on from that
  // page's top.
  expect(calls.map((call) => new URL(call.url, "http://x").search)).toStrictEqual(["?limit=50", "?limit=50", "?since=0"]);
  useAgentChatStore.getState().onMonitorsChanged("t-new", [], { boot: 1, seq: 4 });
  expect(monitors()).toEqual([]);
});

// A worker whose first wake came while the page's event stream was down:
// nothing replays it, so a reconnect reads the worker's conversation again.
test("a reconnect reads a worker that had no thread again, binding the thread its first wake started while the stream was down", async () => {
  seedThread({ threadId: null, loaded: true });
  const calls = mockFetch(() => Response.json({ thread: { id: "t-new" }, messages: [], hasMore: false, monitors: [WATCH], monitorsRevision: { boot: 1, seq: 3 } }));
  await useAgentChatStore.getState().refetchIncrementalForOpenScopes();
  await Bun.sleep(5);
  expect(useAgentChatStore.getState().threadsByScope.get(KEY)!.threadId).toBe("t-new");
  expect(monitors()).toEqual([WATCH]);
  // Its first page, then the read on from that page's top.
  expect(calls.map((call) => new URL(call.url, "http://x").search)).toStrictEqual(["?limit=50", "?since=0"]);
  useAgentChatStore.getState().onMonitorsChanged("t-new", [], { boot: 1, seq: 4 });
  expect(monitors()).toEqual([]);
});
