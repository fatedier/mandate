import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes.js";
import { startThreadStatusBroadcast } from "../src/server/modules/global/thread-status-broadcast.js";
import { SSE_EVENTS, type SseEvent } from "../src/shared/api-contracts.js";
import type { ThreadStatusSnapshotDto } from "../src/shared/api/thread-status.js";
import { readSse, type SseFrame } from "./helpers/sse.js";
import { createStatusHolder } from "../src/server/modules/global/thread-status-broadcast.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import type { GlobalAgentDto } from "../src/shared/api/global-agent.js";
import { stub } from "./helpers/typed.js";

const stops: Array<() => void> = [];
const streams: Array<ReturnType<typeof readSse>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await Promise.all(streams.splice(0).map((stream) => stream.close()));
});

const quiet: ThreadStatusSnapshotDto = { threads: [{ threadId: "t1", state: "idle" }], waiting: [] };
const working: ThreadStatusSnapshotDto = { threads: [{ threadId: "t1", state: "working" }], waiting: [] };
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function start(compute: () => ThreadStatusSnapshotDto, over: { minIntervalMs?: number; scopeOf?: (threadId: string) => string | null } = {}) {
  const sse = new AgentSseEmitter();
  const sent: ThreadStatusSnapshotDto[] = [];
  stops.push(sse.addSink((e: SseEvent) => { if (e.event === SSE_EVENTS.threadStatus) sent.push(e.data as ThreadStatusSnapshotDto); }));
  const broadcast = startThreadStatusBroadcast({ sse, compute, minIntervalMs: 0, ...over });
  stops.push(broadcast.stop);
  return { sse, sent, broadcast };
}

const wakeStarted = { threadId: "t1", wakeId: "w1", scope: "manager", reason: "user", startedAt: "2026-09-27T12:00:00.000Z" };

test("a burst of events recomputes once and deltas never do", async () => {
  let computes = 0;
  const { sse } = start(() => { computes++; return quiet; });
  expect(computes).toBe(1);
  for (let i = 0; i < 5; i++) sse.emit(SSE_EVENTS.agentWakeStarted, wakeStarted as never);
  await settle();
  expect(computes).toBe(2);
  sse.emit(SSE_EVENTS.agentMessageDelta, { threadId: "t1", wakeId: "w1", text: "par" } as never);
  sse.emit(SSE_EVENTS.snapshot, {} as never);
  await settle();
  expect(computes).toBe(2);
});

test("a changed snapshot is sent once; an unchanged one is not sent again", async () => {
  let next = quiet;
  const { sse, sent, broadcast } = start(() => next);
  next = working;
  sse.emit(SSE_EVENTS.agentWakeStarted, wakeStarted as never);
  await settle();
  sse.emit(SSE_EVENTS.agentWakeStarted, wakeStarted as never);
  await settle();
  expect(sent).toStrictEqual([working]);
  expect(broadcast.current()).toEqual(working);
});

test("a computation that throws keeps the last snapshot", async () => {
  let fail = false;
  const { sse, broadcast } = start(() => { if (fail) throw new Error("database is locked"); return quiet; });
  fail = true;
  sse.emit(SSE_EVENTS.agentWakeStarted, wakeStarted as never);
  await settle();
  expect(broadcast.current()).toEqual(quiet);
});

// Its rows name threads, workers and Your agent: what they name comes first,
// so no row is drawn without the title or the place it opens.
test("a connection is sent the status snapshot as it opens, after the threads, Your agent and the projects", async () => {
  const app = new Hono();
  mountSseRoutes(app, {
    sse: new AgentSseEmitter(), getSnapshot: () => null, heartbeatMs: 60000,
    getProjectsState: () => [],
    getManagerThreads: () => [],
    getGlobalAgent: () => stub<GlobalAgentDto>({ threadId: "thr_g", name: "Juno", named: true }),
    getThreadStatus: () => working
  });
  const stream = readSse(await app.request("/api/events"));
  streams.push(stream);
  const events: SseFrame[] = [];
  while (!events.some((e) => e.event === "threadStatus")) events.push(await stream.next());
  expect(events.find((e) => e.event === "threadStatus")?.data).toEqual(working);
  const order = events.map((e) => e.event).filter((e) => ["managerThreads", "globalAgent", "projectsState", "threadStatus"].includes(e));
  expect(order).toStrictEqual(["managerThreads", "globalAgent", "projectsState", "threadStatus"]);
});

test("a holder is quiet until a broadcast is attached, then pokes it", async () => {
  const holder = createStatusHolder();
  holder.poke();
  let next = quiet;
  const { sent, broadcast } = start(() => next);
  holder.attach(broadcast);
  next = working;
  holder.poke();
  await settle();
  expect(sent).toStrictEqual([working]);
});

// A turn's end is announced while its thread is still held; nothing is
// announced when it is let go. Without this a thread read working after its
// turn until something else happened.
test("the runtime pokes the status once a thread is let go after its turn", async () => {
  const env = freshStoresEnv("md-status-release-");
  let pokes = 0;
  const runtime = testAgentRuntime(env, { status: { poke: () => { pokes++; } } });
  try {
    const thread = env.agentStore.createManagerThread("Release notes");
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    await deps.afterWakeReleasedHook!(thread.id);
    expect(pokes).toBe(1);
  } finally {
    runtime.dispose();
    env.cleanup();
  }
});

// A subagent's turn writes many rows a second into its own hidden thread;
// none of them is a thread's state or something waiting on the user (its
// parent hears of it through its task's own events).
test("a subagent's own messages and turns do not recompute", async () => {
  let computes = 0;
  const { sse } = start(() => { computes++; return quiet; }, { scopeOf: (id) => (id === "sub_1" ? "subagent" : "manager") });
  sse.emit(SSE_EVENTS.agentMessageAppended, { threadId: "sub_1", message: {} } as never);
  sse.emit(SSE_EVENTS.agentWakeStarted, { ...wakeStarted, threadId: "sub_1", scope: "subagent" } as never);
  await settle();
  expect(computes).toBe(1);
  sse.emit(SSE_EVENTS.agentMessageAppended, { threadId: "t1", message: {} } as never);
  await settle();
  expect(computes).toBe(2);
});

test("after a recompute the next one waits out the interval, then runs once", async () => {
  let computes = 0;
  const { sse } = start(() => { computes++; return quiet; }, { minIntervalMs: 60 });
  sse.emit(SSE_EVENTS.agentWakeStarted, wakeStarted as never);
  await settle();
  expect(computes).toBe(2);
  for (let i = 0; i < 3; i++) sse.emit(SSE_EVENTS.agentWakeStarted, wakeStarted as never);
  await settle();
  expect(computes).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(computes).toBe(3);
});

test("stopping cancels a recompute that was due, and schedules no more", async () => {
  let computes = 0;
  const { sse, broadcast } = start(() => { computes++; return quiet; });
  sse.emit(SSE_EVENTS.agentWakeStarted, wakeStarted as never);
  broadcast.stop();
  broadcast.poke();
  await settle();
  expect(computes).toBe(1);
});

// Every try to start what a message queued failed: nothing will run, and
// nothing else says so.
test("the runtime pokes the status when it gives up starting a thread's next turn", async () => {
  const env = freshStoresEnv("md-status-abandoned-");
  let pokes = 0;
  const runtime = testAgentRuntime(env, { status: { poke: () => { pokes++; } } });
  try {
    const thread = env.agentStore.createManagerThread("Release notes");
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    deps.onFollowUpAbandoned!(thread.id);
    expect(pokes).toBe(1);
  } finally {
    runtime.dispose();
    env.cleanup();
  }
});
