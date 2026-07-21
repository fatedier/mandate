import { expect, test } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { registerWorkItemsRoutes } from "../src/server/modules/agent/work-items-routes.js";
import type { WorkItem, WorkItemNeedsUser } from "../src/server/modules/agent/work-item-store.js";
import type { WorkItemResponse, WorkItemsListResponse } from "../src/shared/api/work-items.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const agentStore = new AgentStore(db);
  const workStore = new WorkItemStore(db);

  const projectId = projects.insert({
    name: "P", workingDir: "/tmp", isGit: false, gitRemote: null,
    tmuxSessionName: "md-p", ownership: "app"
  });

  const app = new Hono();
  let wokeWith: { threadId: string; reason: string } | null = null;
  const emitted: Array<{ event: string; data: unknown }> = [];
  const sse = { emit: (event: string, data: unknown) => emitted.push({ event, data }) } as any;
  registerWorkItemsRoutes(app, {
    agentStore,
    workStore,
    sse,
    wake: (threadId, reason) => { wokeWith = { threadId, reason }; return "wake-1"; }
  });

  /**
   * Seed a work item: creates a new feature (which auto-creates a bound work_item),
   * then patches state/title as needed. Returns the work item.
   */
  function seedItem(opts: {
    title: string;
    needsUser?: WorkItemNeedsUser;
    lastActivityAt?: string;
    projectId?: string;
  }): WorkItem {
    const fid = features.insert({
      projectId: opts.projectId ?? projectId,
      name: opts.title,
      mode: "shared-cwd",
      branch: null,
      worktreePath: null,
      tmuxWindowName: opts.title,
      ownership: "app"
    });
    // features.insert auto-creates a work_item bound to this feature
    let item = workStore.getByFeature(fid)!;
    const patch: Parameters<typeof workStore.update>[1] = {};
    if (opts.needsUser !== undefined) patch.needsUser = opts.needsUser;
    if (opts.title) patch.title = opts.title;
    if (Object.keys(patch).length > 0) item = workStore.update(item.id, patch)!;
    if (opts.lastActivityAt) {
      db.prepare("update work_items set last_activity_at = ? where id = ?")
        .run(opts.lastActivityAt, item.id);
      item = workStore.get(item.id)!;
    }
    return item;
  }

  return { app, agentStore, workStore, features, projects, db, projectId, emitted, getWokeWith: () => wokeWith, seedItem };
}

// ---------------------------------------------------------------------------
// Existing tests — updated to new DTO shape and schema
// ---------------------------------------------------------------------------

test("GET /api/work-items with no filter returns unarchived items in every status", async () => {
  const { app, seedItem } = setup();
  seedItem({ title: "active-1", needsUser: "input" });
  seedItem({ title: "idle-1", needsUser: null });

  const res = await app.request("/api/work-items");
  expect(res.status).toBe(200);
  const body = await res.json() as WorkItemsListResponse;
  expect(body.items.map((i) => i.title)).toContain("active-1");
  expect(body.items.map((i) => i.title)).toContain("idle-1");
});

test("GET /api/work-items?needsUser=any lists unarchived items in every status", async () => {
  const { app, seedItem } = setup();
  seedItem({ title: "A", needsUser: "input" });
  seedItem({ title: "B", needsUser: null });
  const res = await app.request("/api/work-items?needsUser=any");
  expect(res.status).toBe(200);
  const body = await res.json() as WorkItemsListResponse;
  expect(body.items.map((i) => i.title).sort()).toEqual(["A", "B"]);
});

test("work item lists exclude archived workers, archived projects and missing scopes", async () => {
  const { app, db, seedItem, projects, features, workStore } = setup();
  try {
    const idle = seedItem({ title: "Idle" });
    const input = seedItem({ title: "Input", needsUser: "input" });
    const review = seedItem({ title: "Review", needsUser: "review" });
    const done = seedItem({ title: "Done" });
    workStore.update(done.id, { phase: "done" });
    const archivedWorker = seedItem({ title: "Archived worker", needsUser: "input" });
    features.archive(archivedWorker.featureId);
    // A stale writer can leave an attention flag on archived work.
    workStore.update(archivedWorker.id, { needsUser: "input" });
    const archivedProjectId = projects.insert({
      name: "Archived project", workingDir: "/tmp/archived", isGit: false, gitRemote: null,
      tmuxSessionName: "archived-project", ownership: "app"
    });
    const archivedProjectItem = seedItem({ title: "Archived project item", projectId: archivedProjectId, needsUser: "input" });
    // Deliberately leave the child unarchived: checking only the worker is insufficient.
    db.prepare("update projects set archived_at = ? where id = ?").run("2026-01-01T00:00:00.000Z", archivedProjectId);
    expect(features.getById(archivedProjectItem.featureId)?.archivedAt).toBeNull();
    const orphan = seedItem({ title: "Missing project", needsUser: "input" });
    db.prepare("update work_items set project_id = ? where id = ?").run("missing-project", orphan.id);

    for (const [query, expected] of [
      ["", [idle.id, input.id, review.id, done.id]],
      ["?needsUser=any", [idle.id, input.id, review.id, done.id]],
      ["?needsUser=none", [idle.id, done.id]],
      ["?needsUser=input", [input.id]],
      ["?needsUser=review", [review.id]],
      ["?attention=1&limit=2", [input.id, review.id]]
    ] as const) {
      const res = await app.request(`/api/work-items${query}`);
      expect(res.status).toBe(200);
      const body = await res.json() as WorkItemsListResponse;
      expect(body.items.map(item => item.id).sort()).toEqual([...expected].sort());
    }
    // Internal readers retain their existing historical scope.
    expect(workStore.list({ limit: 20 })).toHaveLength(7);
    for (const item of [archivedWorker, archivedProjectItem, orphan]) {
      const res = await app.request(`/api/work-items/${item.id}`);
      expect(res.status).toBe(200);
      expect((await res.json()).item.id).toBe(item.id);
    }
  } finally { db.close(); }
});

test("work item feature lookup hides archived scope while direct history reads remain available", async () => {
  const { app, db, seedItem, features, workStore, projectId } = setup();
  try {
    const item = seedItem({ title: "Retained history" });
    workStore.update(item.id, { summary: "Historical summary" });
    for (const archive of [
      () => features.archive(item.featureId),
      () => db.prepare("update projects set archived_at = ? where id = ?").run("2026-01-01T00:00:00.000Z", projectId)
    ]) {
      archive();
      for (const suffix of ["", "&attention=1&needsUser=any&limit=200"]) {
        const list = await app.request(`/api/work-items?featureId=${item.featureId}${suffix}`);
        expect(list.status).toBe(200);
        expect(await list.json()).toEqual({ items: [], nextCursor: null });
      }
      const detail = await app.request(`/api/work-items/${item.id}`);
      expect(detail.status).toBe(200);
      expect((await detail.json()).item).toMatchObject({ id: item.id, summary: "Historical summary" });
      // Separate the project-only archive case from the worker archive case.
      db.prepare("update features set archived_at = null where id = ?").run(item.featureId);
    }
  } finally { db.close(); }
});

test("work item pagination filters archived rows before selecting the page and cursor", async () => {
  const { app, db, seedItem, features } = setup();
  try {
    const oldest = seedItem({ title: "Oldest", needsUser: "review", lastActivityAt: "2026-01-01T00:00:00.000Z" });
    const middle = seedItem({ title: "Middle", needsUser: "review", lastActivityAt: "2026-01-02T00:00:00.000Z" });
    const newest = seedItem({ title: "Newest", needsUser: "review", lastActivityAt: "2026-01-03T00:00:00.000Z" });
    for (let i = 0; i < 5; i++) {
      features.archive(seedItem({ title: `Archived ${i}` }).featureId);
    }
    for (const query of ["needsUser=any", "needsUser=review"]) {
      const first = await (await app.request(`/api/work-items?${query}&limit=2`)).json();
      expect(first.items.map((item: WorkItem) => item.id)).toEqual([newest.id, middle.id]);
      expect(first.nextCursor).toBe(middle.lastActivityAt);
      const second = await (await app.request(`/api/work-items?${query}&limit=2&before=${encodeURIComponent(first.nextCursor)}`)).json();
      expect(second.items.map((item: WorkItem) => item.id)).toEqual([oldest.id]);
      expect(second.nextCursor).toBeNull();
    }
  } finally { db.close(); }
});

test("GET /api/work-items/:id returns item", async () => {
  const { app, seedItem } = setup();
  const item = seedItem({ title: "T", needsUser: "input" });
  const res = await app.request(`/api/work-items/${item.id}`);
  expect(res.status).toBe(200);
  const body = await res.json() as WorkItemResponse;
  expect(body.item.title).toBe("T");
});

test("POST /api/work-items/:id/promote-to-chat wakes manager", async () => {
  const { app, agentStore, getWokeWith, seedItem } = setup();
  const manager = agentStore.getOrCreateThread("manager", null);
  const item = seedItem({ title: "T", needsUser: "input" });
  const res = await app.request(`/api/work-items/${item.id}/promote-to-chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  expect(res.status).toBe(200);
  expect(getWokeWith()?.threadId).toBe(manager.id);
});

test("PATCH /api/work-items/:id needsUser=null clears flag + emits SSE", async () => {
  const { app, workStore, emitted, seedItem } = setup();
  const item = seedItem({ title: "T", needsUser: "review" });
  const res = await app.request(`/api/work-items/${item.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ needsUser: null })
  });
  expect(res.status).toBe(200);
  const body = await res.json() as WorkItemResponse;
  expect(body.item.needsUser).toBeNull();
  // SSE emitted
  expect(emitted.some((e) => e.event === "workItemUpdated")).toBe(true);
  // DB updated
  expect(workStore.get(item.id)?.needsUser).toBeNull();
});

// ---------------------------------------------------------------------------
// Pagination tests
// ---------------------------------------------------------------------------

test("GET /api/work-items?attention=1 returns only items with needsUser set", async () => {
  const { app, seedItem } = setup();
  seedItem({ title: "idle-item", needsUser: null });
  seedItem({ title: "review-item", needsUser: "review" });
  seedItem({ title: "input-item", needsUser: "input" });

  const res = await app.request("/api/work-items?attention=1");
  expect(res.status).toBe(200);
  const body = await res.json() as WorkItemsListResponse;
  expect(body.items.length).toBe(2);
  // idle excluded
  expect(body.items.some((i) => i.title === "idle-item")).toBe(false);
  // input first, then review
  expect(body.items[0].needsUser).toBe("input");
  expect(body.items[1].needsUser).toBe("review");
});

test("GET /api/work-items nextCursor uses lastActivityAt not createdAt", async () => {
  const { app, seedItem } = setup();
  const limit = 3;
  // seed 4 items with distinct lastActivityAt
  seedItem({ title: "item-1", lastActivityAt: "2026-01-01T00:00:00.000Z" });
  seedItem({ title: "item-2", lastActivityAt: "2026-01-02T00:00:00.000Z" });
  seedItem({ title: "item-3", lastActivityAt: "2026-01-03T00:00:00.000Z" });
  seedItem({ title: "item-4", lastActivityAt: "2026-01-04T00:00:00.000Z" });

  const res = await app.request(`/api/work-items?limit=${limit}`);
  expect(res.status).toBe(200);
  const body = await res.json() as WorkItemsListResponse;
  expect(body.items.length).toBe(limit);
  // nextCursor should be the lastActivityAt of the last returned item
  const lastItem = body.items[body.items.length - 1];
  expect(body.nextCursor).toBe(lastItem.lastActivityAt);
});

test("GET /api/work-items nextCursor is null when fewer items than limit", async () => {
  const { app, seedItem } = setup();
  seedItem({ title: "only-item" });
  const res = await app.request("/api/work-items?limit=10");
  expect(res.status).toBe(200);
  const body = await res.json() as WorkItemsListResponse;
  expect(body.nextCursor).toBeNull();
});

test("DTO shape: featureId, projectId, phase, phaseDetail, lastActivityAt present; no payload/uiHint/featureRefs/unreadCommentCount", async () => {
  const { app, seedItem } = setup();
  const item = seedItem({ title: "shape-test", needsUser: "input" });
  const res = await app.request(`/api/work-items/${item.id}`);
  expect(res.status).toBe(200);
  const body = await res.json() as WorkItemResponse;
  const dto = body.item;

  // Required new fields present
  expect(dto).toHaveProperty("featureId");
  expect(dto).toHaveProperty("projectId");
  expect(dto).toHaveProperty("phase");
  expect(dto).toHaveProperty("phaseDetail");
  expect(dto).toHaveProperty("lastActivityAt");

  // Old removed fields absent
  expect(dto).not.toHaveProperty("payload");
  expect(dto).not.toHaveProperty("uiHint");
  expect(dto).not.toHaveProperty("featureRefs");
  expect(dto).not.toHaveProperty("projectRefs");
  expect(dto).not.toHaveProperty("unreadCommentCount");
  expect(dto).not.toHaveProperty("latestUserCommentTeaser");
});
