import { expect, test } from "bun:test";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { workerStateFor, workerStateLine, hasStepInProgress, isAsking } from "../src/shared/worker-state.js";
import { planForPage } from "../src/shared/plan-rounds.js";

// The plan's narrow reads — what its state needs, which plans ask, what the
// page is sent — answer exactly what reading the whole plan and working it
// out did, without the finished work they do not use.

function env() {
  const e = freshStoresEnv("md-plan-reads-");
  const projectId = seedProject(e.projects);
  let clock = Date.parse("2026-09-14T10:00:00.000Z");
  const plans = new PlanStore(e.store.db, () => new Date(clock += 60_000).toISOString());
  let n = 0;
  const worker = () => { n += 1; return seedWorker(e.workers, projectId, { name: `w${n}`, tmuxWindowName: `w${n}` }); };
  const done = (title: string) => ({ title, status: "done" as const, note: `${title} shipped` });
  const ok = (workerId: string, input: Parameters<PlanStore["update"]>[1]) => {
    const r = plans.update(workerId, input);
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.plan;
  };
  // One plan of each shape a worker's plan takes.
  const f = {
    none: worker(),
    conclusionOnly: worker(),
    asking: worker(),
    now: worker(),
    blocked: worker(),
    paused: worker(),
    finished: worker(),
    rounds: worker(),
    long: worker()
  };
  ok(f.conclusionOnly, { conclusion: "Reading the code first" });
  ok(f.asking, { conclusion: "Two ways to go", openQuestions: ["Keep the old flag?", "Ship today?"], steps: [{ title: "decide" }] });
  ok(f.now, { steps: [done("read"), { title: "patch the parser", status: "in_progress", note: "running in %12" }, { title: "tests" }] });
  ok(f.blocked, { steps: [done("read"), { title: "wait for the API", status: "blocked", note: "upstream" }, { title: "wire it" }] });
  ok(f.paused, { conclusion: "Half way", steps: [done("one"), { title: "two" }, { title: "three" }] });
  ok(f.finished, { conclusion: "Shipped", steps: [done("a"), done("b"), done("c")] });
  ok(f.rounds, { goal: "Ship A", steps: [done("a1"), done("a2")] });
  ok(f.rounds, { goal: "Ship B", steps: [done("b1"), { title: "b2" }] });
  ok(f.rounds, { goal: "Ship C" });
  ok(f.rounds, { steps: [done("c1"), { title: "c2", status: "in_progress", note: "%3" }] });
  ok(f.long, { steps: Array.from({ length: 120 }, (_, i) => done(`s${i}`)) });
  ok(f.long, { steps: [{ title: "last", status: "in_progress", note: "go" }] });
  return { ...e, plans, f, worker, ok };
}

test("a plan's state reads the same from its narrow read as from the whole plan", () => {
  const { plans, f } = env();
  for (const [shape, workerId] of Object.entries(f)) {
    const whole = plans.get(workerId);
    const narrow = plans.stateOf(workerId);
    for (const running of [false, true]) {
      for (const failure of [null, { at: "2026-09-14T11:00:00.000Z", message: "boom", kind: "error" as const }]) {
        expect([shape, workerStateFor(narrow, failure?.at ?? null, failure?.kind ?? null, running)])
          .toEqual([shape, workerStateFor(whole, failure?.at ?? null, failure?.kind ?? null, running)]);
        expect([shape, workerStateLine(narrow, failure, running)]).toEqual([shape, workerStateLine(whole, failure, running)]);
      }
    }
    expect([shape, isAsking(narrow), hasStepInProgress(narrow), narrow.openQuestions[0] ?? null, narrow.conclusion])
      .toEqual([shape, isAsking(whole), hasStepInProgress(whole), whole.openQuestions[0] ?? null, whole.conclusion]);
  }
});

test("the state read leaves a plan's finished steps out: one is kept when nothing else is left", () => {
  const { plans, f } = env();
  expect(plans.stateOf(f.long).steps.map((s) => s.title)).toEqual(["last"]);
  expect(plans.stateOf(f.finished).steps).toHaveLength(1);
  expect(plans.stateOf(f.none).steps).toStrictEqual([]);
});

test("every active worker's state is read at once; an archived worker's is not", () => {
  const { plans, f, workers } = env();
  workers.archive(f.paused);
  const all = plans.statesOfActive();
  expect([...all.keys()].sort()).toEqual(Object.values(f).filter((id) => id !== f.paused && id !== f.none).sort());
  for (const [workerId, state] of all) expect(state).toEqual(plans.stateOf(workerId));
});

test("the plans that ask are the active ones with an open question", () => {
  const { plans, f, workers, worker, ok } = env();
  const archived = worker();
  ok(archived, { openQuestions: ["Still there?"] });
  workers.archive(archived);
  ok(f.blocked, { openQuestions: ["Wait or work around?"] });
  expect(plans.askingWorkerIds()).toEqual(plans.pagePlansOfActive().filter((p) => p.openQuestions.length > 0).map((p) => p.workerId));
  expect(plans.askingWorkerIds()).toEqual([f.asking, f.blocked].sort());
});

test("what the page is sent of a plan is the whole plan worked down for the page, to the byte", () => {
  const { plans, f } = env();
  for (const [shape, workerId] of Object.entries(f)) {
    expect([shape, JSON.stringify(plans.pagePlan(workerId))]).toEqual([shape, JSON.stringify(planForPage(plans.get(workerId)))]);
  }
  const active = plans.pagePlansOfActive();
  expect(JSON.stringify(active)).toBe(JSON.stringify(active.map((p) => planForPage(plans.get(p.workerId)))));
});
