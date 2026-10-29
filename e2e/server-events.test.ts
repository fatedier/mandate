import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedProject, startServer, type RunningServer } from "./helpers/server";
import { MandateStore } from "../src/server/app/store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { API_PATHS, API_ROUTES, SSE_EVENTS } from "../src/shared/api-contracts";
import type { ManagerThreadDto } from "../src/shared/api/agents";
import type { FeaturePlanDto } from "../src/shared/api/plans";
import { seedProject as seedProjectRow } from "../tests/helpers/fixtures.js";
import { readSse } from "../tests/helpers/sse.js";
import { waitUntil } from "../tests/helpers/wait.js";

// The real binary on a seeded data dir: what a connection opens with, and
// what reaches it later, come from the server's own wiring, not a fixture.
let server: RunningServer;
let ids: { live: string; archived: string };

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      const store = new MandateStore(dataDir);
      const projects = new ProjectsStore(store.db);
      const features = new FeaturesStore(store.db);
      const plans = new PlanStore(store.db);
      const projectId = seedProjectRow(projects, { name: "Plans project", tmuxSessionName: "md-plans-project" });
      const insert = (name: string) => features.insert({
        projectId, name, mode: "shared-cwd", branch: null, worktreePath: null, tmuxWindowName: name, ownership: "app"
      });
      ids = { live: insert("live"), archived: insert("archived") };
      plans.update(ids.live, { conclusion: "Waiting on upstream", steps: [{ title: "wait", status: "blocked", note: "project-2#17" }] });
      plans.update(ids.archived, { conclusion: "Parked for the release", steps: [{ title: "park", status: "done", note: "ok" }] });
      features.archive(ids.archived);
      store.db.close();
    }
  });
}, 60_000);

afterAll(() => server?.cleanup());

/** Reads the event stream frame by frame. */
async function openEvents() {
  const controller = new AbortController();
  const response = await fetch(`${server.baseUrl}${API_ROUTES.events}`, { signal: controller.signal });
  const { until } = readSse(response);
  return { until, close: () => controller.abort() };
}

test("a connection gets the active plans before the projects", async () => {
  const events = await openEvents();
  try {
    const { seen } = await events.until((e) => e.event === "projectsState");
    expect(seen).toContain("featurePlans");
    expect(seen.indexOf("featurePlans")).toBeLessThan(seen.indexOf("projectsState"));
  } finally { events.close(); }
  const again = await openEvents();
  try {
    const { found } = await again.until((e) => e.event === "featurePlans");
    const plans = (found.data as { plans: FeaturePlanDto[] }).plans;
    expect(plans.map((p) => [p.featureId, p.conclusion])).toEqual([[ids.live, "Waiting on upstream"]]);
  } finally { again.close(); }
}, 20_000);

test("restoring a feature pushes its plan", async () => {
  const events = await openEvents();
  try {
    await events.until((e) => e.event === "projectsState");
    const response = await fetch(`${server.baseUrl}${API_ROUTES.featureRestore.replace(":id", ids.archived)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    expect(response.status).toBe(200);
    const { found } = await events.until((e) => e.event === "featurePlanUpdated"
      && (e.data as { plan: FeaturePlanDto }).plan.featureId === ids.archived);
    expect((found.data as { plan: FeaturePlanDto }).plan.conclusion).toBe("Parked for the release");
  } finally { events.close(); }
}, 20_000);

// A thread the server opens on its own — here for a worker created with no
// thread — reaches a connected client, which otherwise shows "Thread not
// found" behind the worker's link until it reconnects.
test("a thread opened for a worker created without one is published to connected clients", async () => {
  const project = await seedProject(server, "project-1");
  const controller = new AbortController();
  const response = await fetch(`${server.baseUrl}${API_ROUTES.events}`, { signal: controller.signal });
  const events = readSse(response);
  const published: ManagerThreadDto[] = [];
  const reading = (async () => {
    for (;;) {
      const frame = await events.next();
      if (frame.event === SSE_EVENTS.managerThreadUpdated) published.push((frame.data as { thread: ManagerThreadDto }).thread);
    }
  })().catch(() => {});
  try {
    const created = await fetch(`${server.baseUrl}${API_PATHS.projectFeatures(project.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "EvictHook", mode: "shared-cwd" })
    });
    expect(created.status).toBe(200);
    const feature = await created.json() as { ownerThreadId: string | null };
    expect(feature.ownerThreadId === null).toBe(false);
    await waitUntil(() => published.some((t) => t.id === feature.ownerThreadId), { timeout: 5000, label: () => `the worker's new thread to be published (published: ${published.map((t) => t.title).join(", ") || "none"})` });
    expect(published.filter((t) => t.id === feature.ownerThreadId).map((t) => t.title)).toContain("EvictHook");
  } finally {
    controller.abort();
    await reading;
  }
}, 30_000);
