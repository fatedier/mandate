import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { freshStoresEnv, seedProject, seedWorker, type StoresEnv } from "./helpers/fixtures.js";
import { getJson } from "./helpers/test-app.js";
import { skillsModule } from "../src/server/modules/skills/module.js";
import { LearnedSkillStore } from "../src/server/modules/skills/learned-skill-store.js";
import { learnedSkillRouteDeps } from "../src/server/modules/skills/skill-routes.js";
import { revisionPatch } from "../src/server/modules/skills/learned-skill-patch.js";
import type { AppDeps } from "../src/server/app/deps.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function app() {
  env = freshStoresEnv("md-learned-routes-");
  const project = seedProject(env.projects, { name: "bakery", tmuxSessionName: "md-bk" });
  const learned = new LearnedSkillStore(env.store.db, () => new Set());
  const manager = env.agentStore.createManagerThread("Bakery");
  const workerId = seedWorker(env.workers, project, { name: "cert renewal", tmuxWindowName: "md-w1", ownerThreadId: manager.id });
  const workerThread = env.agentStore.getOrCreateThread("worker", workerId);
  const hono = new Hono();
  const learnedSkills = learnedSkillRouteDeps({ store: learned, projectsStore: env.projects, agentStore: env.agentStore, workersStore: env.workers });
  skillsModule.mountRoutes!(hono, { deps: { learnedSkills, skills: { list: () => [], refresh: async () => {} } } as unknown as AppDeps, upgradeWebSocket: (() => {}) as never });
  const global = learned.create({ name: "release-steps", description: "Cut a release.", body: "1. Tag.\n2. Build.", where: { scope: "user" }, by: "review", threadId: workerThread.id, reason: "Kept the order." });
  const local = learned.create({ name: "cert-renewal", description: "Renew certificates.", body: "1. Stop the till.", where: { scope: "project", projectId: project }, by: "agent", threadId: manager.id, reason: "The user asked." });
  if (!global.ok || !local.ok) throw new Error("seed");
  return { hono, learned, project, manager, workerThread, global: global.skill, local: local.skill };
}

test("the list filters by scope and status", async () => {
  const t = app();
  t.learned.change(t.local.id, 1, { status: "archived", archivedReason: "Not used.", change: "archive", by: "agent" });
  const all = await getJson(t.hono, "/api/skills/learned");
  expect(all.status).toBe(200);
  expect(all.body.skills.map((s: { name: string }) => s.name)).toEqual(["cert-renewal", "release-steps"]);
  expect(all.body.skills[0]).toMatchObject({ scope: "project", projectId: t.project, projectName: "bakery", status: "archived", archivedReason: "Not used.", uses30: 0, uses90: 0 });
  expect(all.body.skills[0].body).toBeUndefined();
  expect(all.body.projects).toEqual([{ id: t.project, name: "bakery" }]);
  const names = async (query: string) => (await getJson(t.hono, `/api/skills/learned?${query}`)).body.skills.map((s: { name: string }) => s.name);
  expect(await names("scope=global")).toEqual(["release-steps"]);
  expect(await names(`scope=project&projectId=${t.project}`)).toEqual(["cert-renewal"]);
  expect(await names("status=available")).toEqual(["release-steps"]);
  expect(await names("status=archived")).toEqual(["cert-renewal"]);
  expect((await getJson(t.hono, "/api/skills/learned?status=gone")).status).toBe(400);
});

test("a skill's detail has its revisions newest first with who and why", async () => {
  const t = app();
  t.learned.change(t.global.id, 1, { body: "1. Tag.\n2. Build and sign.", change: "patch", by: "agent", threadId: t.manager.id, reason: "Unsigned builds are refused." });
  t.learned.recordUse(t.global.id, t.manager.id, "manager");
  const detail = await getJson(t.hono, `/api/skills/learned/${t.global.id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.skill).toMatchObject({ name: "release-steps", body: "1. Tag.\n2. Build and sign.", revision: 2, uses30: 1 });
  expect(detail.body.skill.createdBy).toEqual({ by: "review", threadId: t.workerThread.id, threadTitle: "cert renewal", threadKind: "worker" });
  expect(detail.body.skill.lastChange).toMatchObject({ by: "agent", threadTitle: "Bakery", threadKind: "manager", reason: "Unsigned builds are refused." });
  expect(detail.body.versions.map((v: { revision: number; change: string; by: string }) => [v.revision, v.change, v.by])).toEqual([[2, "patch", "agent"], [1, "create", "review"]]);
  expect(detail.body.versions[0].body).toBeUndefined();
  expect((await getJson(t.hono, "/api/skills/learned/skl_nope")).status).toBe(404);
});

test("a revision's patch is its change against the one before", async () => {
  const t = app();
  t.learned.change(t.global.id, 1, { body: "1. Tag.\n2. Build and sign.", change: "patch", by: "agent", reason: "x" });
  const second = await getJson(t.hono, `/api/skills/learned/${t.global.id}/revisions/2`);
  expect(second.status).toBe(200);
  expect(second.body).toMatchObject({ body: "1. Tag.\n2. Build and sign.", against: 1 });
  expect(second.body.patch).toContain("-2. Build.");
  expect(second.body.patch).toContain("+2. Build and sign.");
  const first = await getJson(t.hono, `/api/skills/learned/${t.global.id}/revisions/1`);
  expect(first.body).toMatchObject({ against: null });
  expect(first.body.patch).toContain("+1. Tag.");
  expect((await getJson(t.hono, `/api/skills/learned/${t.global.id}/revisions/9`)).status).toBe(404);
  // Too far apart to diff in time: no patch, never a long block.
  expect(revisionPatch("a\n".repeat(3_000), "b\n".repeat(3_000))).toBeNull();
});

test("the reviews list newest first, each with its conversation and what it did", async () => {
  const t = app();
  const run = t.learned.requestReview({ threadId: t.workerThread.id, requestedBy: t.manager.id, focus: "x", fromSeq: 1, toSeq: 2 });
  t.learned.startReview(run.id, "mock", "mock-1");
  t.learned.finishReview(run.id, { status: "succeeded", outcome: "created", skillId: t.global.id, revision: 1, reason: "Kept the order." });
  t.learned.requestReview({ threadId: t.manager.id, requestedBy: t.manager.id, focus: "y", fromSeq: 1, toSeq: 1 });
  const reviews = await getJson(t.hono, "/api/skills/reviews");
  expect(reviews.status).toBe(200);
  expect(reviews.body.runs.map((r: { status: string; threadTitle: string }) => [r.status, r.threadTitle])).toEqual([["queued", "Bakery"], ["succeeded", "cert renewal"]]);
  expect(reviews.body.runs[1]).toMatchObject({ outcome: "created", skillName: "release-steps", reason: "Kept the order." });
});

test("the reviews read lists the tidies too, newest first, each with the revisions it wrote", async () => {
  const t = app();
  const run = t.learned.startTidy("mock", "mock-1");
  t.learned.change(t.global.id, 1, { body: "1. Tag.", change: "rewrite", by: "tidy", runId: run.id, reason: "One step." });
  t.learned.finishTidy(run.id, { status: "succeeded", changes: 1, reason: "Rewrote release-steps.", changed: [{ skillId: t.global.id, revision: 2 }] });
  const reviews = await getJson(t.hono, "/api/skills/reviews");
  expect(reviews.body.tidies).toEqual([{
    id: run.id, status: "succeeded", reason: "Rewrote release-steps.", error: null,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: expect.any(String),
    changed: [{ skillId: t.global.id, skillName: "release-steps", revision: 2 }]
  }]);
});

test("there is no route that writes", async () => {
  const t = app();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/api/skills/learned", `/api/skills/learned/${t.global.id}`, `/api/skills/learned/${t.global.id}/revisions/1`, "/api/skills/reviews"]) {
      const res = await t.hono.request(path, { method, headers: { "content-type": "application/json" }, body: "{}" });
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
  }
  expect(t.learned.get(t.global.id)?.revision).toBe(1);
});
