import { afterEach, expect, test } from "bun:test";
import { newThreadState, useAgentChatStore, type ThreadState } from "../../src/client/store/agent-chat.js";
import { mockFetch } from "../helpers/fetch.js";

afterEach(() => {
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const SCOPE = { type: "worker" as const, featureId: "active-wake-f" };
const STARTED = "2026-09-29T10:00:00.000Z";

function answerWith(body: Record<string, unknown>) {
  mockFetch(() => Response.json({ thread: { id: "t1" }, messages: [], hasMore: false, ...body }));
}

function seedThread(patch: Partial<ThreadState>) {
  useAgentChatStore.setState({ threadsByScope: new Map([["worker:active-wake-f", { ...newThreadState(), threadId: "t1", ...patch }]]) });
}

const phase = () => useAgentChatStore.getState().threadsByScope.get("worker:active-wake-f")!.wakePhase;

// A page read's activeWake against what the store already holds: `seed` is the
// thread's wake before the read (none: the read opens the thread).
const readRows: Array<{
  name: string;
  seed?: ThreadState["wakePhase"];
  activeWake: { wakeId: string; startedAt: string } | null;
  wakePhase: ThreadState["wakePhase"];
}> = [
  {
    name: "a thread opened mid-turn shows the wake it is running, and since when",
    activeWake: { wakeId: "w9", startedAt: STARTED },
    wakePhase: { wakeId: "w9", phase: "thinking", startedAt: STARTED }
  },
  {
    name: "a thread with nothing running stays idle",
    activeWake: null,
    wakePhase: { wakeId: null, phase: "idle" }
  },
  {
    // The finish arrived over SSE while the page was on its way.
    name: "a page read before a wake finished does not bring that wake back",
    seed: { wakeId: "w9", phase: "idle" },
    activeWake: { wakeId: "w9", startedAt: STARTED },
    wakePhase: { wakeId: "w9", phase: "idle" }
  },
  {
    name: "a page read before a newer wake started does not replace it",
    seed: { wakeId: "w10", phase: "thinking", startedAt: "2026-09-29T10:05:00.000Z" },
    activeWake: { wakeId: "w9", startedAt: STARTED },
    wakePhase: { wakeId: "w10", phase: "thinking", startedAt: "2026-09-29T10:05:00.000Z" }
  },
  {
    name: "a wake the send already knew of learns when it began",
    seed: { wakeId: "w9", phase: "thinking" },
    activeWake: { wakeId: "w9", startedAt: STARTED },
    wakePhase: { wakeId: "w9", phase: "thinking", startedAt: STARTED }
  }
];

test.each(readRows)("$name", async ({ seed, activeWake, wakePhase }) => {
  if (seed) seedThread({ wakePhase: seed });
  answerWith({ activeWake });
  await useAgentChatStore.getState().ensureThreadLoaded(SCOPE);
  expect(phase()).toEqual(wakePhase);
});

test("the catch-up read of a loaded thread picks up a wake that started while it was away", async () => {
  seedThread({ loaded: true, oldestSeqLoaded: 1, wakePhase: { wakeId: "w8", phase: "idle" } });
  let read!: () => void;
  const done = new Promise<void>((resolve) => { read = resolve; });
  mockFetch(({ url }) => {
    expect(url).toContain("since=");
    queueMicrotask(read);
    return Response.json({ thread: { id: "t1" }, messages: [], activeWake: { wakeId: "w9", startedAt: STARTED } });
  });
  await useAgentChatStore.getState().ensureThreadLoaded(SCOPE);
  await done;
  await Bun.sleep(0);
  expect(phase()).toEqual({ wakeId: "w9", phase: "thinking", startedAt: STARTED });
});

test("a wake's start event records when it began", () => {
  seedThread({});
  useAgentChatStore.getState().onWakeStarted("t1", "w9", "user", null, STARTED);
  expect(phase()).toEqual({ wakeId: "w9", phase: "thinking", startedAt: STARTED });
});

test("a stale page read cannot bring back a wake older than one that has since started and finished", async () => {
  seedThread({});
  useAgentChatStore.getState().onWakeStarted("t1", "w10", "user", null, "2026-09-29T10:05:00.000Z");
  useAgentChatStore.getState().onWakeFinished("t1", "w10", "finished");
  answerWith({ activeWake: { wakeId: "w9", startedAt: STARTED } });
  await useAgentChatStore.getState().ensureThreadLoaded(SCOPE);
  expect(phase()).toMatchObject({ wakeId: "w10", phase: "idle" });
});

test("a finished wake known only from its messages still outranks an older page read", async () => {
  seedThread({
    wakePhase: { wakeId: "w10", phase: "idle" },
    messages: [{
      id: "m1", threadId: "t1", seq: 1, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w10",
      wakeStartedAt: "2026-09-29T10:05:00.000Z", createdAt: "2026-09-29T10:05:03.000Z", content: { type: "assistant", text: "done" }
    }]
  });
  answerWith({ activeWake: { wakeId: "w9", startedAt: STARTED } });
  await useAgentChatStore.getState().ensureThreadLoaded(SCOPE);
  expect(phase()).toMatchObject({ wakeId: "w10", phase: "idle" });
});

function assistantText(id: string, seq: number, extra: Record<string, unknown> = {}) {
  return {
    id, threadId: "t1", seq, role: "assistant" as const, source: "self" as const, sourceThreadId: null, wakeId: "w9",
    createdAt: "2026-09-29T10:00:05.000Z", content: { type: "assistant" as const, text: "Checking", ...extra }
  };
}

test("text the model says does not end its turn leaves the turn running; text that does, ends it", () => {
  seedThread({ wakePhase: { wakeId: "w9", phase: "thinking", startedAt: STARTED } });
  useAgentChatStore.getState().onMessageAppended("t1", assistantText("m1", 1, { endTurn: false }));
  expect(phase().phase).toBe("thinking");
  useAgentChatStore.getState().onMessageAppended("t1", assistantText("m2", 2));
  expect(phase()).toEqual({ wakeId: "w9", phase: "idle", startedAt: STARTED });
});

async function catchUpWith(body: Record<string, unknown>) {
  let read!: () => void;
  const done = new Promise<void>((resolve) => { read = resolve; });
  mockFetch(() => {
    queueMicrotask(read);
    return Response.json({ thread: { id: "t1" }, messages: [], ...body });
  });
  await useAgentChatStore.getState().ensureThreadLoaded(SCOPE);
  await done;
  await Bun.sleep(0);
}

test("a read that finds nothing running ends a wake that began before the read", async () => {
  seedThread({ loaded: true, oldestSeqLoaded: 1, wakePhase: { wakeId: "w9", phase: "thinking", startedAt: STARTED } });
  await catchUpWith({ activeWake: null, readAt: "2026-09-29T10:01:00.000Z" });
  expect(phase()).toEqual({ wakeId: "w9", phase: "idle", startedAt: STARTED });
});

test("a read that finds nothing running leaves alone a wake that began after the read", async () => {
  const later = "2026-09-29T10:05:00.000Z";
  seedThread({ loaded: true, oldestSeqLoaded: 1, wakePhase: { wakeId: "w10", phase: "thinking", startedAt: later } });
  await catchUpWith({ activeWake: null, readAt: "2026-09-29T10:01:00.000Z" });
  expect(phase()).toEqual({ wakeId: "w10", phase: "thinking", startedAt: later });
});

// A compaction leaves the store by its finished or failed event. One missed
// (the page asleep on a phone for the minute it takes, the stream down) would
// leave the thread "compacting" for good: its working line, its greyed commands.
const compaction = () => useAgentChatStore.getState().threadsByScope.get("worker:active-wake-f")!.compressionPhase;

test("a read that finds nothing holding the thread ends a compaction that began before the read", async () => {
  seedThread({ loaded: true, oldestSeqLoaded: 1, compressionPhase: { compressionId: "c1", startedAt: STARTED } });
  await catchUpWith({ activeWake: null, compacting: false, readAt: "2026-09-29T10:01:00.000Z" });
  expect(compaction()).toBe(null);
});

test("whichever read brings the news: a worker's first page, a manager thread's catch-up", async () => {
  const stale = { compressionId: "c1", startedAt: STARTED };
  const found = { activeWake: null, compacting: false, readAt: "2026-09-29T10:01:00.000Z" };
  // A worker's thread the page knows of (its events arrive) and has not read yet.
  seedThread({ compressionPhase: stale });
  await catchUpWith(found);
  expect(compaction()).toBe(null);
  // A manager thread, already read, catching up after the stream came back.
  useAgentChatStore.setState({ threadsByScope: new Map([["manager:tm", { ...newThreadState(), threadId: "tm", loaded: true, oldestSeqLoaded: 1, compressionPhase: stale }]]) });
  let read!: () => void;
  const done = new Promise<void>((resolve) => { read = resolve; });
  mockFetch(() => { queueMicrotask(read); return Response.json({ thread: { id: "tm" }, messages: [], ...found }); });
  await useAgentChatStore.getState().ensureThreadLoaded({ type: "manager", threadId: "tm" });
  await done;
  await Bun.sleep(0);
  expect(useAgentChatStore.getState().threadsByScope.get("manager:tm")!.compressionPhase).toBe(null);
});

test("a read leaves a compaction alone when it still finds one, finds a turn running, or was taken before it began", async () => {
  const phase = { compressionId: "c1", startedAt: STARTED };
  seedThread({ loaded: true, oldestSeqLoaded: 1, compressionPhase: phase });
  // Still compacting, by hand.
  await catchUpWith({ activeWake: null, compacting: true, readAt: "2026-09-29T10:01:00.000Z" });
  expect(compaction()).toEqual(phase);
  // A turn is running: the compaction at its gate is its own.
  await catchUpWith({ activeWake: { wakeId: "w9", startedAt: STARTED }, compacting: false, readAt: "2026-09-29T10:01:00.000Z" });
  expect(compaction()).toEqual(phase);
  // The read is older than the compaction.
  await catchUpWith({ activeWake: null, compacting: false, readAt: "2026-09-29T09:59:00.000Z" });
  expect(compaction()).toEqual(phase);
  // A server that does not say: nothing is concluded.
  await catchUpWith({ activeWake: null, readAt: "2026-09-29T10:01:00.000Z" });
  expect(compaction()).toEqual(phase);
});

test("a send's wake knows when it began, so an older page read cannot displace it", async () => {
  seedThread({ loaded: true, oldestSeqLoaded: 1 });
  const later = "2026-09-29T10:05:00.000Z";
  mockFetch(({ method }) => {
    if (method === "POST") return Response.json({ threadId: "t1", messageId: "m1", wakeId: "w10", wakeStartedAt: later }, { status: 202 });
    return Response.json({ thread: { id: "t1" }, messages: [], activeWake: { wakeId: "w9", startedAt: STARTED }, readAt: "2026-09-29T10:04:59.000Z" });
  });
  await useAgentChatStore.getState().sendMessage(SCOPE, "hi");
  expect(phase()).toEqual({ wakeId: "w10", phase: "thinking", startedAt: later });
  await catchUpWith({ activeWake: { wakeId: "w9", startedAt: STARTED }, readAt: "2026-09-29T10:04:59.000Z" });
  expect(phase()).toEqual({ wakeId: "w10", phase: "thinking", startedAt: later });
});
