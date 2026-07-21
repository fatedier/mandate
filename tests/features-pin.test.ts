import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";

function newDb(): Database {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  return db;
}

function setup(): { db: Database; features: FeaturesStore; projectId: string } {
  const db = newDb();
  const projects = new ProjectsStore(db);
  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
    ownership: "app", isGit: false, gitRemote: null
  });
  const features = new FeaturesStore(db);
  return { db, features, projectId };
}

test("store: setPinned(true) sets pinned_at to ISO string, getById returns pinnedAt", () => {
  const { features, projectId } = setup();
  const id = features.insert({
    projectId, name: "n", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w", ownership: "app"
  });
  expect(features.getById(id)!.pinnedAt).toBeNull();
  features.setPinned(id, true);
  const after = features.getById(id)!;
  expect(after.pinnedAt).toBeTruthy();
  expect(typeof after.pinnedAt).toBe("string");
});

test("store: setPinned(false) clears pinned_at", () => {
  const { features, projectId } = setup();
  const id = features.insert({
    projectId, name: "n", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w", ownership: "app"
  });
  features.setPinned(id, true);
  features.setPinned(id, false);
  expect(features.getById(id)!.pinnedAt).toBeNull();
});

test("store: archive clears pinned_at", () => {
  const { features, projectId } = setup();
  const id = features.insert({
    projectId, name: "n", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w", ownership: "app"
  });
  features.setPinned(id, true);
  features.archive(id);
  expect(features.getById(id)!.pinnedAt).toBeNull();
});

test("schema: features has pinned_at column (text, nullable)", () => {
  const db = newDb();
  const cols = db.prepare("pragma table_info(features)").all() as Array<{ name: string; type: string; notnull: number }>;
  const pin = cols.find((c) => c.name === "pinned_at");
  expect(pin).toBeDefined();
  expect(pin!.type.toLowerCase()).toBe("text");
  expect(pin!.notnull).toBe(0);
});
