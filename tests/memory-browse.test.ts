import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { freshStoresEnv, seedProject } from "./helpers/fixtures.js";
import { getMemoryStats, listMemoryEntries } from "../src/server/modules/memory/browse.js";

function insert(db: Database, row: { id: string; scope?: string; projectId?: string | null; type?: string; source?: string; status?: string; content?: string; createdAt: string; updatedAt?: string }) {
  db.prepare(`insert into memory_entries (id, scope, project_id, feature_id, type, source, user_quote, content, status, created_at, updated_at)
    values (?, ?, ?, null, ?, ?, null, ?, ?, ?, ?)`).run(
    row.id, row.scope ?? "user", row.projectId ?? null, row.type ?? "preference", row.source ?? "agent",
    row.content ?? `memory ${row.id}`, row.status ?? "available", row.createdAt, row.updatedAt ?? row.createdAt);
}

function seeded() {
  const env = freshStoresEnv("md-memory-browse-v2-");
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const db = env.store.db;
  insert(db, { id: "u1", source: "user", content: "back up before deploying", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z" });
  insert(db, { id: "p1", scope: "project", projectId: project1, type: "knowledge", source: "extraction", createdAt: "2026-10-02T00:00:00.000Z" });
  insert(db, { id: "p2", scope: "project", projectId: project1, type: "preference", source: "extraction", createdAt: "2026-10-03T00:00:00.000Z" });
  insert(db, { id: "a1", type: "knowledge", status: "archived", createdAt: "2026-09-01T00:00:00.000Z" });
  return { env, db, project1 };
}

const ids = (db: Database, query: Parameters<typeof listMemoryEntries>[1]) => listMemoryEntries(db, query).entries.map((e) => e.id);

test("each filter narrows the list", () => {
  const { env, db, project1 } = seeded();
  try {
    expect(ids(db, {}).sort()).toEqual(["p1", "p2", "u1"]);
    expect(ids(db, { scope: "user" })).toEqual(["u1"]);
    expect(ids(db, { projectId: project1 }).sort()).toEqual(["p1", "p2"]);
    expect(ids(db, { type: "knowledge" })).toEqual(["p1"]);
    expect(ids(db, { source: "user" })).toEqual(["u1"]);
    expect(ids(db, { status: "archived" })).toEqual(["a1"]);
    expect(ids(db, { status: "all" }).sort()).toEqual(["a1", "p1", "p2", "u1"]);
    expect(ids(db, { q: "deploying" })).toEqual(["u1"]);
    expect(listMemoryEntries(db, { source: "user" }).entries[0]).toMatchObject({ type: "preference", source: "user", userQuote: null });
  } finally {
    env.cleanup();
  }
});

test("sorts by last change, creation, or oldest first", () => {
  const { env, db } = seeded();
  try {
    expect(ids(db, { sort: "recent" })).toEqual(["u1", "p2", "p1"]);
    expect(ids(db, { sort: "created" })).toEqual(["p2", "p1", "u1"]);
    expect(ids(db, { sort: "oldest" })).toEqual(["u1", "p1", "p2"]);
  } finally {
    env.cleanup();
  }
});

test("stats count available memories by scope, type and source, and name every project", () => {
  const { env, db, project1 } = seeded();
  try {
    expect(getMemoryStats(db)).toMatchObject({
      totals: { available: 3, archived: 1, total: 4 },
      byScope: { user: 1, project: 2 },
      byType: { preference: 2, knowledge: 1 },
      bySource: { user: 1, agent: 0, extraction: 2 },
      byProject: [{ projectId: project1, name: "project-1", count: 2 }],
      projectNames: { [project1]: "project-1" }
    });
    // Task records are not memory: no type of their own in the counts.
    expect("task" in getMemoryStats(db).byType).toBe(false);
  } finally {
    env.cleanup();
  }
});
