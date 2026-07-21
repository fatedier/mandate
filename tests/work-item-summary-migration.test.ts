import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { toWorkItemDto } from "../src/server/modules/agent/work-item-dto.js";

/** The work_items table exactly as it shipped before summary provenance
 *  existed, plus one row with a summary already in it. This is what an
 *  installed copy of Mandate has on disk when it starts the new build. */
function legacyDb(): Database {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  db.exec(`
    create table work_items (
      id               text primary key,
      feature_id       text not null unique references features(id) on delete cascade,
      project_id       text not null,
      title            text not null,
      summary          text,
      canvas_id        text,
      needs_user       text check (needs_user in ('review', 'input') or needs_user is null),
      phase            text not null default 'design',
      phase_detail     text,
      last_activity_at text not null,
      created_at       text not null,
      updated_at       text not null
    )
  `);
  db.prepare(
    `insert into features
       (id, project_id, name, mode, branch, base_ref, worktree_path,
        tmux_window_name, ownership, created_at, updated_at)
     values ('feat-old', 'proj-old', 'old', 'shared-cwd', null, null, null,
             'old', 'app', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `insert into work_items
       (id, feature_id, project_id, title, summary, canvas_id, needs_user,
        phase, phase_detail, last_activity_at, created_at, updated_at)
     values ('wi-old', 'feat-old', 'proj-old', 'Old item', 'A summary from before.',
             null, null, 'working', 'still going',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run();
  return db;
}

test("initializing over a pre-provenance database adds the columns without touching the data", () => {
  const db = legacyDb();
  initializeAgentSchema(db);

  const cols = (db.prepare("pragma table_info(work_items)").all() as Array<{ name: string }>)
    .map((c) => c.name);
  expect(cols).toContain("summary_updated_at");
  expect(cols).toContain("summary_updated_by");

  const row = db.prepare("select * from work_items where id = 'wi-old'").get() as Record<string, unknown>;
  expect(row.summary).toBe("A summary from before.");
  expect(row.summary_updated_at).toBeNull();
  expect(row.summary_updated_by).toBeNull();
});

test("a historical row with NULL provenance reads and serializes without error", () => {
  const db = legacyDb();
  initializeAgentSchema(db);
  const store = new WorkItemStore(db);

  const item = store.get("wi-old")!;
  expect(item.summary).toBe("A summary from before.");
  expect(item.summaryUpdatedAt).toBeNull();
  expect(item.summaryUpdatedBy).toBeNull();

  const dto = toWorkItemDto(item);
  expect(dto.summaryUpdatedAt).toBeNull();
  expect(dto.summaryUpdatedBy).toBeNull();
  // The whole DTO must survive JSON — a client on the other end of SSE parses
  // this, and an undefined would silently drop the key.
  expect(JSON.parse(JSON.stringify(dto)).summaryUpdatedAt).toBeNull();
});

test("no backfill: a historical summary is not credited to whoever patches the row next", () => {
  const db = legacyDb();
  initializeAgentSchema(db);
  const store = new WorkItemStore(db);

  const after = store.update("wi-old", { phase: "verifying" })!;
  expect(after.summary).toBe("A summary from before.");
  expect(after.summaryUpdatedAt).toBeNull();
  expect(after.summaryUpdatedBy).toBeNull();
});

test("a historical row gains provenance the first time its summary actually changes", () => {
  const db = legacyDb();
  initializeAgentSchema(db);
  const store = new WorkItemStore(db);

  const after = store.update("wi-old", { summary: "Rewritten today.", summaryBy: "manager" })!;
  expect(after.summaryUpdatedBy).toBe("manager");
  expect(after.summaryUpdatedAt).not.toBeNull();
});

test("re-initializing is idempotent — the columns are added once and keep their values", () => {
  const db = legacyDb();
  initializeAgentSchema(db);
  const store = new WorkItemStore(db);
  const written = store.update("wi-old", { summary: "Rewritten.", summaryBy: "worker" })!;

  initializeAgentSchema(db);
  initializeAgentSchema(db);

  const cols = (db.prepare("pragma table_info(work_items)").all() as Array<{ name: string }>)
    .filter((c) => c.name === "summary_updated_at");
  expect(cols.length).toBe(1);
  const after = store.get("wi-old")!;
  expect(after.summaryUpdatedAt).toBe(written.summaryUpdatedAt!);
  expect(after.summaryUpdatedBy).toBe("worker");
});
