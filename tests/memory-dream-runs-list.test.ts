import { expect, test } from "bun:test";
import { getMemoryDreamRun, listMemoryDreamRuns } from "../src/server/modules/memory/dream-runs.js";
import { freshStoresEnv, seedProject } from "./helpers/fixtures.js";

// The Memory page's run list: the newest runs (a running one by when it
// started, a finished one by when it finished), each with what it applied.

test("the run list holds the newest runs in order, each with its own applied actions and project", () => {
  const env = freshStoresEnv("md-dream-runs-list-");
  const db = env.store.db;
  const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-runs-project-1" });
  const run = db.prepare("insert into memory_dream_runs (id, trigger, status, phase, project_id, started_at, finished_at) values (?, 'test', ?, ?, ?, ?, ?)");
  const act = db.prepare("insert into memory_dream_actions (id, run_id, action_type, status, memory_id, reason, created_at) values (?, ?, ?, ?, 'mem_1', '', ?)");
  const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
  // 25 finished runs, minute i started and minute i + 30 finished, each with
  // i applied updates, one applied merge, and one rejected update.
  for (let i = 0; i < 25; i++) {
    run.run(`run_${i}`, "succeeded", i % 2 ? "project" : "user", i % 2 ? projectId : null, at(i), at(i + 30));
    for (let k = 0; k < i; k++) act.run(`act_${i}_${k}`, `run_${i}`, "update", "applied", at(i));
    act.run(`act_${i}_m`, `run_${i}`, "merge", "applied", at(i));
    act.run(`act_${i}_r`, `run_${i}`, "update", "rejected", at(i));
  }
  // Still running: placed by when it started, ahead of runs that finished earlier.
  run.run("run_live", "running", "user", null, at(56), null);
  // Finished at the same moment as run_24, started later: before it.
  run.run("run_tie", "succeeded", "user", null, at(40), at(54));
  const listed = listMemoryDreamRuns(db, 20);
  expect(listed.map((r) => r.id)).toEqual(["run_live", "run_tie", ...Array.from({ length: 18 }, (_, k) => `run_${24 - k}`)]);
  const counts = Object.fromEntries(listed.map((r) => [r.id, [r.actionCounts.update, r.actionCounts.merge, r.actionCounts.archive]]));
  expect(counts.run_live).toEqual([0, 0, 0]);
  expect(counts.run_24).toEqual([24, 1, 0]);
  expect(counts.run_7).toEqual([7, 1, 0]);
  expect(listed.find((r) => r.id === "run_23")?.projectName).toBe("project-1");
  expect(listed.find((r) => r.id === "run_24")?.projectName ?? null).toBeNull();
  expect(listMemoryDreamRuns(db, 1).map((r) => r.id)).toEqual(["run_live"]);
  expect(listMemoryDreamRuns(db, 500).length).toBe(27);
});

test("runs that started and finished at the same moments come in the order of their ids, the limit included", () => {
  const env = freshStoresEnv("md-dream-runs-ties-");
  const db = env.store.db;
  const run = db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at, finished_at) values (?, 'test', 'failed', 'user', '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.005Z')");
  for (const id of ["run_a", "run_b", "run_c"]) run.run(id);
  expect(listMemoryDreamRuns(db, 20).map((r) => r.id)).toEqual(["run_a", "run_b", "run_c"]);
  // The limit keeps the same first ones, not the last written.
  expect(listMemoryDreamRuns(db, 1).map((r) => r.id)).toEqual(["run_a"]);
  expect(listMemoryDreamRuns(db, 2).map((r) => r.id)).toEqual(["run_a", "run_b"]);
});

// One batch's actions share a millisecond: a run's page lists them in the
// order they were written, as the memory's own history does.
test("a run's actions that share a millisecond are listed in the order they were written", () => {
  const env = freshStoresEnv("md-dream-run-order-");
  const db = env.store.db;
  db.prepare("insert into memory_dream_runs (id, trigger, status, phase, project_id, started_at, finished_at) values ('run_1', 'test', 'succeeded', 'user', null, ?, ?)").run("2026-11-01T10:00:00.000Z", "2026-11-01T10:01:00.000Z");
  const act = db.prepare("insert into memory_dream_actions (id, run_id, action_type, status, memory_id, reason, created_at) values (?, 'run_1', ?, 'applied', 'mem_1', '', '2026-11-01T10:00:30.000Z')");
  // Ids by chance in the other order from how they were written.
  for (const [id, type] of [["act_z", "update"], ["act_m", "split"], ["act_a", "archive"]] as const) act.run(id, type);
  expect(getMemoryDreamRun(db, "run_1")!.actions.map((a) => a.id)).toEqual(["act_z", "act_m", "act_a"]);
});
