import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes.js";
import { emptyPlan } from "../src/shared/api/plans.js";
import type { ProjectStateDto } from "../src/shared/api-contracts.js";
import { readSse, type SseFrame } from "./helpers/sse.js";

const streams: Array<ReturnType<typeof readSse>> = [];
afterEach(async () => { await Promise.all(streams.splice(0).map((stream) => stream.close())); });

test("a connection gets every active plan before the projects, so no worker is drawn without its plan", async () => {
  // As the page receives it (PlanStore.pagePlansOfActive).
  const plan = { ...emptyPlan("wkr_1"), conclusion: "Waiting on upstream", updatedAt: "2026-09-27T00:00:00.000Z", earlierWork: null };
  const app = new Hono();
  mountSseRoutes(app, {
    sse: new AgentSseEmitter(), getSnapshot: () => null, heartbeatMs: 60000,
    getProjectsState: async () => [{ id: "proj_1" } as ProjectStateDto],
    getWorkerPlans: () => [plan]
  });
  const stream = readSse(await app.request("/api/events"));
  streams.push(stream);
  const events: SseFrame[] = [];
  while (!events.some((e) => e.event === "projectsState")) events.push(await stream.next());
  const names = events.map((e) => e.event);
  expect(names.indexOf("workerPlans")).toBeGreaterThanOrEqual(0);
  expect(names.indexOf("workerPlans")).toBeLessThan(names.indexOf("projectsState"));
  expect(events.find((e) => e.event === "workerPlans")!.data).toEqual({ plans: [plan] });
});

test("a connection whose projects could not be read ends before it sends anything else, so the browser reconnects and gets them", async () => {
  // Live updates send the projects again only when they change, and the
  // client has no other way to get them: a burst without them left a page
  // waiting for them forever.
  let reads = 0;
  const app = new Hono();
  mountSseRoutes(app, {
    sse: new AgentSseEmitter(), heartbeatMs: 60000,
    getSnapshot: () => ({ sessions: [] }),
    getManagerThreads: () => [],
    getProjectsState: async () => {
      reads++;
      if (reads === 1) throw new Error("database is locked");
      return [{ id: "proj_1" } as ProjectStateDto];
    }
  });
  const stream = readSse(await app.request("/api/events"));
  streams.push(stream);
  const seen: string[] = [];
  let ended = false;
  try {
    for (;;) seen.push((await stream.next()).event);
  } catch (error) {
    ended = (error as Error).message.includes("ended");
  }
  expect(ended).toBe(true);
  // The projects are read first, so nothing waits between the opening reads and the live updates.
  expect(seen).toStrictEqual([]);

  const second = readSse(await app.request("/api/events"));
  streams.push(second);
  const projects = await second.until((frame) => frame.event === "projectsState");
  expect(projects.found.data).toEqual([{ id: "proj_1" }]);
});

test("the connect burst carries the personal agent after the threads", async () => {
  const app = new Hono();
  mountSseRoutes(app, {
    sse: new AgentSseEmitter(), heartbeatMs: 60000,
    getSnapshot: () => null,
    getManagerThreads: () => [],
    getPersonalAgent: () => ({ threadId: "thr_g", name: "Jarvis", named: true, unread: false, voiceConfigured: false, lastVisibleSeq: 0, seenSeq: 0, questions: [] }),
    getProjectsState: async () => []
  });
  const stream = readSse(await app.request("/api/events"));
  streams.push(stream);
  const seen: SseFrame[] = [];
  while (seen.at(-1)?.event !== "projectsState") seen.push(await stream.next());
  expect(seen.map((frame) => frame.event)).toStrictEqual(["managerThreads", "personalAgent", "projectsState"]);
  expect(seen[1]!.data).toMatchObject({ agent: { threadId: "thr_g", name: "Jarvis" } });
});

test("the projects as tmux last answered go out with the other opening reads: nothing waits between them and the live updates", async () => {
  let fresh = 0;
  const app = new Hono();
  mountSseRoutes(app, {
    sse: new AgentSseEmitter(), getSnapshot: () => null, heartbeatMs: 60000,
    getProjectsStateNow: () => [{ id: "proj_1" } as ProjectStateDto],
    getProjectsState: async () => { fresh++; return []; }
  });
  const stream = readSse(await app.request("/api/events"));
  streams.push(stream);
  const events: SseFrame[] = [];
  while (!events.some((e) => e.event === "projectsState")) events.push(await stream.next());
  expect(events.find((e) => e.event === "projectsState")!.data).toEqual([{ id: "proj_1" }]);
  expect(fresh).toBe(0);
});

test("a first connection whose own tmux read is overtaken by a broadcast opens with the broadcast's projects", async () => {
  // Live updates are sent only when they differ from what was last broadcast:
  // a connection that opened with an older answer would keep it.
  let lastAnswer: ProjectStateDto[] | null = null;
  const app = new Hono();
  mountSseRoutes(app, {
    sse: new AgentSseEmitter(), getSnapshot: () => null, heartbeatMs: 60000,
    getProjectsStateNow: () => lastAnswer,
    getProjectsState: async () => {
      lastAnswer = [{ id: "proj_1", name: "newer" } as ProjectStateDto];
      return [{ id: "proj_1", name: "older" } as ProjectStateDto];
    }
  });
  const stream = readSse(await app.request("/api/events"));
  streams.push(stream);
  const events: SseFrame[] = [];
  while (!events.some((e) => e.event === "projectsState")) events.push(await stream.next());
  expect(events.find((e) => e.event === "projectsState")!.data).toEqual([{ id: "proj_1", name: "newer" }]);
});

test("a connection that goes away while its first projects wait on tmux keeps nothing behind", async () => {
  const sse = new AgentSseEmitter();
  let answer!: (projects: ProjectStateDto[]) => void;
  let asked = false;
  const app = new Hono();
  mountSseRoutes(app, {
    sse, getSnapshot: () => null, heartbeatMs: 60000,
    getProjectsStateNow: () => null,
    getProjectsState: () => { asked = true; return new Promise<ProjectStateDto[]>((resolve) => { answer = resolve; }); }
  });
  const stream = readSse(await app.request("/api/events"));
  while (!asked) await new Promise((resolve) => setTimeout(resolve, 0));
  await stream.close();
  answer([{ id: "proj_1" } as ProjectStateDto]);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sse.sinkCount).toBe(0);
});
