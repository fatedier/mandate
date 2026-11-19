import { expect, test } from "bun:test";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";

// Where a plan's steps land as they are added and moved: the order readers
// see. Adding a step writes that step, not the position of every other one.

function env() {
  const e = freshStoresEnv("md-plan-positions-");
  const projectId = seedProject(e.projects);
  const workerId = seedWorker(e.workers, projectId);
  let clock = Date.parse("2026-09-14T10:00:00.000Z");
  const plans = new PlanStore(e.store.db, () => new Date(clock += 60_000).toISOString());
  const update = (input: Parameters<PlanStore["update"]>[1]) => {
    const r = plans.update(workerId, input);
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.plan.steps.map((s) => s.id);
  };
  return { ...e, workerId, plans, update };
}

test("steps land where they are placed, and moved steps where they are moved to", () => {
  const { update } = env();
  expect(update({ steps: [{ title: "a" }, { title: "b" }, { title: "c" }] })).toEqual([1, 2, 3]);
  expect(update({ steps: [{ title: "d" }] })).toEqual([1, 2, 3, 4]);
  expect(update({ steps: [{ title: "x", after: 2 }] })).toEqual([1, 2, 5, 3, 4]);
  // Several after one step in one call keep the order given.
  expect(update({ steps: [{ title: "p", after: 1 }, { title: "q", after: 1 }] })).toEqual([1, 6, 7, 2, 5, 3, 4]);
  expect(update({ steps: [{ id: 4, after: 1 }] })).toEqual([1, 4, 6, 7, 2, 5, 3]);
  expect(update({ steps: [{ id: 1, after: 3 }] })).toEqual([4, 6, 7, 2, 5, 3, 1]);
  expect(update({ steps: [{ title: "z", after: 1 }] })).toEqual([4, 6, 7, 2, 5, 3, 1, 8]);
  expect(update({ delete: [5], steps: [{ title: "y", after: 2 }, { id: 3, after: 4 }] })).toEqual([4, 3, 6, 7, 2, 9, 1, 8]);
  // A step placed where it already is does not move.
  expect(update({ steps: [{ id: 3, after: 4 }] })).toEqual([4, 3, 6, 7, 2, 9, 1, 8]);
});

test("many steps placed after the same one, call after call, each go right after it", () => {
  const { update } = env();
  update({ steps: [{ title: "first" }, { title: "last" }] });
  let order: number[] = [];
  for (let i = 0; i < 20; i++) order = update({ steps: [{ title: `n${i}`, after: 1 }] });
  expect(order).toEqual([1, ...Array.from({ length: 20 }, (_, i) => 22 - i), 2]);
  // And moved back and forth between neighbours.
  for (let i = 0; i < 12; i++) order = update({ steps: [{ id: 2, after: i % 2 === 0 ? 1 : 22 }] });
  expect(order.slice(0, 3)).toEqual([1, 22, 2]);
});

test("a plan whose steps an earlier version placed keeps its order as steps are added and moved", () => {
  const { update, store, workerId } = env();
  update({ steps: [{ title: "a" }] });
  // Positions as the earlier version wrote them: tens, a step put after
  // another at that step's + 5, and a tie broken by id.
  const db = store.db;
  db.prepare(`delete from worker_plan_steps where worker_id = ?`).run(workerId);
  const insert = db.prepare(`insert into worker_plan_steps (worker_id, id, position, title, status, created_at, updated_at) values (?, ?, ?, ?, 'pending', '2026-09-14T09:00:00.000Z', '2026-09-14T09:00:00.000Z')`);
  for (const [id, position] of [[1, 10], [2, 20], [3, 25], [4, 30], [5, 30]] as const) insert.run(workerId, id, position, `s${id}`);
  db.prepare(`update worker_plans set next_step_id = 6 where worker_id = ?`).run(workerId);
  expect(update({ steps: [{ title: "end" }] })).toEqual([1, 2, 3, 4, 5, 6]);
  expect(update({ steps: [{ title: "mid", after: 4 }] })).toEqual([1, 2, 3, 4, 7, 5, 6]);
  expect(update({ steps: [{ id: 1, after: 2 }] })).toEqual([2, 1, 3, 4, 7, 5, 6]);
});

test("adding a step at the end of a long plan writes that step and the plan, nothing else", () => {
  const { update, store } = env();
  update({ steps: Array.from({ length: 100 }, (_, i) => ({ title: `s${i}` })) });
  const changes = () => (store.db.prepare(`select total_changes() as n`).get() as { n: number }).n;
  const before = changes();
  update({ steps: [{ title: "one more" }] });
  // The new step, the plan's step counter and its time.
  expect(changes() - before).toBe(3);
});
