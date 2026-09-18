import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";
import { initializeFeaturesSchema } from "../src/server/modules/features/schema.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../src/server/modules/features/features-store.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";

/**
 * Stalled means: not finished, nobody waiting on it, and nothing that will make
 * it move. The four "nothing will move it" clauses are the complete set of wake
 * sources other than the user, so each one gets a test that it alone is enough
 * to keep an item out.
 */

function setup() {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  initializeFeaturesSchema(db);
  initializeAgentSchema(db);
  const projects = new ProjectsStore(db);
  const features = new FeaturesStore(db);
  const workItems = new WorkItemStore(db);
  const agentStore = new AgentStore(db);
  const projectId = projects.insert({
    name: "p",
    workingDir: "/tmp/p",
    tmuxSessionName: "p",
    isGit: false,
    gitRemote: null,
    ownership: "app"
  });
  return { db, projects, features, workItems, agentStore, projectId };
}

/** A feature with a live thread and an unfinished work item — stalled unless
 *  the caller gives it something that will wake it. */
function makeFeature(
  s: ReturnType<typeof setup>,
  name: string
): { featureId: string; threadId: string; itemId: string } {
  const featureId = s.features.insert({
    projectId: s.projectId,
    name,
    mode: "shared-cwd",
    branch: null,
    baseRef: null,
    worktreePath: null,
    tmuxWindowName: name,
    ownership: "app"
  });
  const threadId = s.agentStore.getOrCreateThread("worker", featureId).id;
  return { featureId, threadId, itemId: s.workItems.getByFeature(featureId)!.id };
}

describe("listStalled", () => {
  test("returns a feature that is unfinished with nothing scheduled", () => {
    const s = setup();
    const f = makeFeature(s, "stuck");
    expect(s.workItems.listStalled().map((i) => i.featureId)).toEqual([f.featureId]);
  });

  test("a running wake keeps it out", () => {
    const s = setup();
    const f = makeFeature(s, "stuck");
    s.agentStore.createWake({ threadId: f.threadId, reason: "user", triggerMessageId: null });
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("a finished wake does not keep it out", () => {
    // The distinction the `finished_at is null` clause exists to draw: having
    // run is not the same as being about to run.
    const s = setup();
    const f = makeFeature(s, "stuck");
    const wake = s.agentStore.createWake({
      threadId: f.threadId,
      reason: "user",
      triggerMessageId: null
    });
    s.agentStore.finishWake(wake.id, "finished");
    expect(s.workItems.listStalled().map((i) => i.featureId)).toEqual([f.featureId]);
  });

  test("a pending alarm keeps it out", () => {
    const s = setup();
    const f = makeFeature(s, "stuck");
    s.db
      .prepare(
        `insert into agent_alarms (id, thread_id, fire_at, note, status, created_at)
         values ('al1', ?, '2099-01-01T00:00:00.000Z', 'later', 'pending', '2026-08-06T00:00:00.000Z')`
      )
      .run(f.threadId);
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("a fired alarm does not keep it out", () => {
    const s = setup();
    const f = makeFeature(s, "stuck");
    s.db
      .prepare(
        `insert into agent_alarms (id, thread_id, fire_at, note, status, created_at, fired_at)
         values ('al1', ?, '2026-01-01T00:00:00.000Z', 'done', 'fired',
                 '2026-08-06T00:00:00.000Z', '2026-08-06T00:01:00.000Z')`
      )
      .run(f.threadId);
    expect(s.workItems.listStalled().map((i) => i.featureId)).toEqual([f.featureId]);
  });

  test("an undelivered mailbox event keeps it out", () => {
    const s = setup();
    const f = makeFeature(s, "stuck");
    s.agentStore.enqueueMailboxEvent({
      threadId: f.threadId,
      role: "user",
      source: "feature-event",
      sourceThreadId: null,
      content: {
        type: "feature_event", kind: "completion", taskId: "task-1",
        featureId: f.featureId, workItemId: null, label: "stuck", summary: "keep going"
      }
    });
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("a window watch keeps it out", () => {
    const s = setup();
    const f = makeFeature(s, "stuck");
    s.db
      .prepare(
        `insert into agent_window_watches
           (id, thread_id, window_key, pane_id, stable_ms, note, created_at, timeout_at)
         values ('ww1', ?, 'k', 'p', 1000, '', '2026-08-06T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`
      )
      .run(f.threadId);
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("needs_user keeps it out — already escalated is not stalled", () => {
    // Without this clause the sweep re-raises what the agent already handed to
    // the user, every 30 minutes, and the list stops being read.
    const s = setup();
    const f = makeFeature(s, "stuck");
    s.workItems.update(f.itemId, { needsUser: "review" });
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("a done work item is not stalled", () => {
    const s = setup();
    const f = makeFeature(s, "stuck");
    s.workItems.update(f.itemId, { phase: "done" });
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("an archived feature is not stalled", () => {
    const s = setup();
    const f = makeFeature(s, "stuck");
    s.features.archive(f.featureId);
    expect(s.workItems.listStalled()).toEqual([]);
  });

  test("orders oldest activity first, and not in insertion order", () => {
    // Fed newest-first on purpose. A fixture inserted in the order the query
    // returns lets the `order by` be deleted with the suite still green.
    const s = setup();
    const recent = makeFeature(s, "recent");
    const older = makeFeature(s, "older");
    const oldest = makeFeature(s, "oldest");
    const stamp = (id: string, at: string) =>
      s.db.prepare("update work_items set last_activity_at = ? where id = ?").run(at, id);
    stamp(recent.itemId, "2026-08-06T00:00:00.000Z");
    stamp(older.itemId, "2026-08-04T00:00:00.000Z");
    stamp(oldest.itemId, "2026-08-01T00:00:00.000Z");

    expect(s.workItems.listStalled().map((i) => i.featureId)).toEqual([
      oldest.featureId,
      older.featureId,
      recent.featureId
    ]);
  });

  test("honours the limit", () => {
    const s = setup();
    makeFeature(s, "a");
    makeFeature(s, "b");
    makeFeature(s, "c");
    expect(s.workItems.listStalled({ limit: 2 })).toHaveLength(2);
  });
});
