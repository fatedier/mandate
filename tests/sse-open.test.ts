import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes.js";
import { emptyPlan } from "../src/shared/api/plans.js";
import type { ProjectStateDto } from "../src/shared/api-contracts.js";
import { readSse, type SseFrame } from "./helpers/sse.js";

const streams: Array<ReturnType<typeof readSse>> = [];
afterEach(async () => { await Promise.all(streams.splice(0).map((stream) => stream.close())); });

test("a connection gets every active plan before the projects, so no feature is drawn without its plan", async () => {
  const plan = { ...emptyPlan("feat_1"), conclusion: "Waiting on upstream", updatedAt: "2026-09-27T00:00:00.000Z" };
  const app = new Hono();
  mountSseRoutes(app, {
    sse: new AgentSseEmitter(), getSnapshot: () => null, heartbeatMs: 60000,
    getProjectsState: () => [{ id: "proj_1" } as ProjectStateDto],
    getFeaturePlans: () => [plan]
  });
  const stream = readSse(await app.request("/api/events"));
  streams.push(stream);
  const events: SseFrame[] = [];
  while (!events.some((e) => e.event === "projectsState")) events.push(await stream.next());
  const names = events.map((e) => e.event);
  expect(names.indexOf("featurePlans")).toBeGreaterThanOrEqual(0);
  expect(names.indexOf("featurePlans")).toBeLessThan(names.indexOf("projectsState"));
  expect(events.find((e) => e.event === "featurePlans")!.data).toEqual({ plans: [{ ...plan, earlierWork: null }] });
});

test("a connection whose projects could not be read ends, so the browser reconnects and gets them", async () => {
  // Live updates send the projects again only when they change, and the
  // client has no other way to get them: a burst without them left a page
  // waiting for them forever.
  let reads = 0;
  const app = new Hono();
  mountSseRoutes(app, {
    sse: new AgentSseEmitter(), getSnapshot: () => null, heartbeatMs: 60000,
    getProjectsState: () => {
      reads++;
      if (reads === 1) throw new Error("database is locked");
      return [{ id: "proj_1" } as ProjectStateDto];
    }
  });

  const first = readSse(await app.request("/api/events"));
  streams.push(first);
  const seen: SseFrame[] = [];
  let ended = false;
  try {
    for (;;) seen.push(await first.next());
  } catch (error) {
    ended = (error as Error).message.includes("ended");
  }
  expect(ended).toBe(true);
  // It ends before the heartbeat that would mark a healthy stream.
  expect(seen.map((frame) => frame.event)).not.toContain("_hb");
  expect(seen.map((frame) => frame.event)).not.toContain("projectsState");

  const second = readSse(await app.request("/api/events"));
  streams.push(second);
  const projects = await second.until((frame) => frame.event === "projectsState");
  expect(projects.found.data).toEqual([{ id: "proj_1" }]);
});

test("what was read before the projects failed still reaches the browser before the stream ends", async () => {
  const app = new Hono();
  mountSseRoutes(app, {
    sse: new AgentSseEmitter(), heartbeatMs: 60000,
    getSnapshot: () => ({ sessions: [], counts: {} }),
    getManagerThreads: () => [],
    getProjectsState: () => { throw new Error("database is locked"); }
  });
  const stream = readSse(await app.request("/api/events"));
  streams.push(stream);
  const seen: string[] = [];
  try {
    for (;;) seen.push((await stream.next()).event);
  } catch { /* ended */ }
  expect(seen).toStrictEqual(["snapshotFull", "managerThreads"]);
});

test("the connect burst carries the global agent after the threads", async () => {
  const app = new Hono();
  mountSseRoutes(app, {
    sse: new AgentSseEmitter(), heartbeatMs: 60000,
    getSnapshot: () => null,
    getManagerThreads: () => [],
    getGlobalAgent: () => ({ threadId: "thr_g", name: "Jarvis", named: true, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [] }),
    getProjectsState: () => []
  });
  const stream = readSse(await app.request("/api/events"));
  streams.push(stream);
  const seen: SseFrame[] = [];
  while (seen.at(-1)?.event !== "projectsState") seen.push(await stream.next());
  expect(seen.map((frame) => frame.event)).toStrictEqual(["managerThreads", "globalAgent", "projectsState"]);
  expect(seen[1]!.data).toMatchObject({ agent: { threadId: "thr_g", name: "Jarvis" } });
});
