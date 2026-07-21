import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import {
  WorkItemStore,
  WORK_ITEM_SUMMARY_MAX_CHARS
} from "../src/server/modules/agent/work-item-store.js";
import { toWorkItemDto } from "../src/server/modules/agent/work-item-dto.js";

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);
  const projectId = projects.insert({
    name: "p", workingDir: "/tmp/p", tmuxSessionName: "p",
    ownership: "app", gitRemote: null, isGit: false
  });
  const featureId = features.insert({
    projectId, name: "n", mode: "shared-cwd", branch: null, baseRef: null,
    worktreePath: null, tmuxWindowName: "w", ownership: "app"
  });
  const item = workItems.getByFeature(featureId)!;
  return { db, workItems, featureId, itemId: item.id };
}

// ── schema ───────────────────────────────────────────────────────────────

test("schema: work_items carries summary_updated_at / summary_updated_by, both nullable text", () => {
  const { db } = setup();
  const cols = db.prepare("pragma table_info(work_items)").all() as Array<{
    name: string; type: string; notnull: number;
  }>;
  for (const name of ["summary_updated_at", "summary_updated_by"]) {
    const col = cols.find((c) => c.name === name);
    expect(col).toBeDefined();
    expect(col!.type.toLowerCase()).toBe("text");
    expect(col!.notnull).toBe(0);
  }
});

test("a work item starts with no summary and therefore no summary provenance", () => {
  const { workItems, itemId } = setup();
  const item = workItems.get(itemId)!;
  expect(item.summary).toBeNull();
  expect(item.summaryUpdatedAt).toBeNull();
  expect(item.summaryUpdatedBy).toBeNull();
});

// ── changed vs unchanged ─────────────────────────────────────────────────

test("writing a summary records when it was written and who wrote it", () => {
  const { workItems, itemId } = setup();
  const before = new Date().toISOString();
  const updated = workItems.update(itemId, {
    summary: "Chose the additive migration.",
    summaryBy: "worker"
  })!;
  expect(updated.summaryUpdatedBy).toBe("worker");
  expect(updated.summaryUpdatedAt).not.toBeNull();
  expect(updated.summaryUpdatedAt! >= before).toBe(true);
});

test("rewriting the identical summary leaves the provenance untouched", async () => {
  const { workItems, itemId } = setup();
  const first = workItems.update(itemId, {
    summary: "Chose the additive migration.",
    summaryBy: "worker"
  })!;
  await Bun.sleep(5);
  const again = workItems.update(itemId, {
    summary: "Chose the additive migration.",
    summaryBy: "manager"
  })!;

  expect(again.summaryUpdatedAt).toBe(first.summaryUpdatedAt!);
  // Not even the author moves: nobody wrote anything, so nobody gets credit.
  expect(again.summaryUpdatedBy).toBe("worker");
  // The work item itself did register activity — that is a different fact.
  expect(again.lastActivityAt > first.lastActivityAt).toBe(true);
});

test("changing the summary text moves the provenance to the new writer", async () => {
  const { workItems, itemId } = setup();
  const first = workItems.update(itemId, {
    summary: "Chose the additive migration.",
    summaryBy: "worker"
  })!;
  await Bun.sleep(5);
  const second = workItems.update(itemId, {
    summary: "Reworded for the user: schema change is backwards compatible.",
    summaryBy: "manager"
  })!;

  expect(second.summaryUpdatedBy).toBe("manager");
  expect(second.summaryUpdatedAt! > first.summaryUpdatedAt!).toBe(true);
});

test("title / canvas / phase / phaseDetail / needsUser patches never touch the summary provenance", async () => {
  const { workItems, itemId } = setup();
  const written = workItems.update(itemId, {
    summary: "Three lines, no more.",
    summaryBy: "worker"
  })!;
  await Bun.sleep(5);

  // Each patch on its own: a single combined call could pass while any one
  // field was quietly refreshing the timestamp.
  for (const patch of [
    { title: "A clearer title" },
    { canvasId: "cnv_1" },
    { phase: "verifying" as const },
    { phaseDetail: "running the suite" },
    { needsUser: "review" as const }
  ]) {
    const after = workItems.update(itemId, patch)!;
    expect(after.summaryUpdatedAt).toBe(written.summaryUpdatedAt!);
    expect(after.summaryUpdatedBy).toBe("worker");
    // lastActivityAt is the field that is supposed to move on any patch.
    expect(after.lastActivityAt > written.lastActivityAt).toBe(true);
  }
  expect(workItems.get(itemId)!.summary).toBe("Three lines, no more.");
});

test("clearing the summary clears its provenance — metadata never outlives its text", () => {
  const { workItems, itemId } = setup();
  workItems.update(itemId, { summary: "Something", summaryBy: "worker" });
  const cleared = workItems.update(itemId, { summary: null })!;
  expect(cleared.summary).toBeNull();
  expect(cleared.summaryUpdatedAt).toBeNull();
  expect(cleared.summaryUpdatedBy).toBeNull();
});

test("a writer that does not identify itself is recorded as unknown, not guessed", () => {
  const { workItems, itemId } = setup();
  const updated = workItems.update(itemId, { summary: "Written by a legacy caller." })!;
  expect(updated.summary).toBe("Written by a legacy caller.");
  expect(updated.summaryUpdatedAt).not.toBeNull();
  expect(updated.summaryUpdatedBy).toBeNull();
});

test("truncation decides the comparison: a rewrite that only differs past the cap is unchanged", async () => {
  const { workItems, itemId } = setup();
  const long = "x".repeat(WORK_ITEM_SUMMARY_MAX_CHARS);
  const first = workItems.update(itemId, { summary: long + "AAA", summaryBy: "worker" })!;
  await Bun.sleep(5);
  const second = workItems.update(itemId, { summary: long + "BBB", summaryBy: "manager" })!;

  expect(second.summary).toBe(long);
  expect(second.summaryUpdatedAt).toBe(first.summaryUpdatedAt!);
  expect(second.summaryUpdatedBy).toBe("worker");
});

test("an unrecognised author value in the database reads as no author, not as itself", () => {
  const { db, workItems, itemId } = setup();
  workItems.update(itemId, { summary: "Text", summaryBy: "worker" });
  db.prepare("update work_items set summary_updated_by = ? where id = ?")
    .run("some-future-writer", itemId);
  expect(workItems.get(itemId)!.summaryUpdatedBy).toBeNull();
});

// ── DTO ──────────────────────────────────────────────────────────────────

test("the DTO carries both provenance fields to the client", () => {
  const { workItems, itemId } = setup();
  const item = workItems.update(itemId, { summary: "S", summaryBy: "manager" })!;
  const dto = toWorkItemDto(item);
  expect(dto.summaryUpdatedBy).toBe("manager");
  expect(dto.summaryUpdatedAt).toBe(item.summaryUpdatedAt!);
});
