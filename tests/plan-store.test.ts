import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";

function env() {
  const e = freshStoresEnv("md-plan-store-");
  const projectId = seedProject(e.projects);
  const workerId = seedWorker(e.workers, projectId);
  let clock = Date.parse("2026-09-14T10:00:00.000Z");
  const plans = new PlanStore(e.store.db, () => new Date(clock += 60_000).toISOString());
  return { ...e, workerId, plans };
}

test("a worker with no plan reads as an empty plan", () => {
  const { plans, workerId } = env();
  expect(plans.get(workerId)).toEqual({ workerId, goal: null, conclusion: null, openQuestions: [], steps: [], goalHistory: [], updatedAt: null });
});

// An agent may write Mandate's database itself. An update that read the plan
// before taking the write lock failed outright when such a write landed in
// between (SQLITE_BUSY_SNAPSHOT); taking the lock first, it is the outside
// write that waits.
test("an outside write landing in the middle of a plan update does not fail the update", () => {
  const { plans, workerId, dir, store } = env();
  plans.update(workerId, { goal: "Ship A", steps: [{ title: "a" }] });
  const outside = new Database(path.join(dir, "mandate.db"));
  const realPrepare = store.db.prepare.bind(store.db);
  const prepare = spyOn(store.db, "prepare").mockImplementation(((sql: string) => {
    const statement = realPrepare(sql);
    if (!sql.includes("select next_step_id")) return statement;
    const realGet = statement.get.bind(statement);
    return Object.assign(statement, {
      get: (...args: unknown[]) => {
        const row = realGet(...(args as []));
        // Refused at once if the update holds the write lock.
        try { outside.exec("update projects set name = name || '!'"); } catch { /* waits its turn */ }
        return row;
      }
    });
  }) as typeof store.db.prepare);
  try {
    expect(plans.update(workerId, { steps: [{ title: "b" }] }).ok).toBe(true);
  } finally {
    prepare.mockRestore();
    outside.close();
  }
  expect(plans.get(workerId).steps.map((step) => step.title)).toEqual(["a", "b"]);
});

test("new steps get the next ids, at the end or after a named step", () => {
  const { plans, workerId } = env();
  const first = plans.update(workerId, { goal: "Ship A", conclusion: "Starting", steps: [{ title: "a" }, { title: "b" }] });
  expect(first.ok && first.summary).toBe("Plan updated: goal, conclusion; added #1, #2 (0 of 2 done)");
  const second = plans.update(workerId, { steps: [{ title: "a2", after: 1 }, { title: "c" }] });
  expect(second.ok).toBe(true);
  expect(plans.get(workerId).steps.map((s) => `${s.id}:${s.title}`)).toEqual(["1:a", "3:a2", "2:b", "4:c"]);
});

test("status changes stamp their times, and leaving a state clears its stamp", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "a" }] });
  plans.update(workerId, { steps: [{ id: 1, status: "in_progress" }] });
  const started = plans.get(workerId).steps[0]!.startedAt;
  expect(started).not.toBeNull();
  plans.update(workerId, { steps: [{ id: 1, status: "blocked", note: "waits on project-2#17" }] });
  expect(plans.get(workerId).steps[0]!.blockedAt).not.toBeNull();
  plans.update(workerId, { steps: [{ id: 1, status: "in_progress" }] });
  const resumed = plans.get(workerId).steps[0]!;
  expect(resumed.blockedAt).toBeNull();
  expect(resumed.startedAt).toBe(started);
  plans.update(workerId, { steps: [{ id: 1, status: "done", note: "merged in c0ffee1" }] });
  expect(plans.get(workerId).steps[0]!.completedAt).not.toBeNull();
  plans.update(workerId, { steps: [{ id: 1, status: "pending" }] });
  expect(plans.get(workerId).steps[0]!.completedAt).toBeNull();
});

test("done and blocked need a note, given now or already there", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "a" }, { title: "b", note: "result: ok" }] });
  expect(plans.update(workerId, { steps: [{ id: 1, status: "done" }] })).toEqual({ ok: false, errors: ["step #1: done needs a note with the result and evidence"] });
  expect(plans.update(workerId, { steps: [{ id: 1, status: "blocked" }] })).toEqual({ ok: false, errors: ["step #1: blocked needs a note saying what it waits on"] });
  expect(plans.update(workerId, { steps: [{ id: 2, status: "done" }] }).ok).toBe(true);
  // A step added already done or blocked needs one too.
  expect(plans.update(workerId, { steps: [{ title: "c", status: "done" }] })).toEqual({ ok: false, errors: ["a new step: done needs a note with the result and evidence"] });
  expect(plans.update(workerId, { steps: [{ title: "c", status: "blocked", note: "waits on review" }] }).ok).toBe(true);
});

test("a done or blocked step cannot lose its note, whatever the call sends", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "a", status: "done", note: "ok" }, { title: "b", status: "blocked", note: "waits" }] });
  expect(plans.update(workerId, { steps: [{ id: 1, note: "" }, { id: 2, note: "  " }] })).toEqual({ ok: false, errors: [
    "step #1: done needs a note with the result and evidence",
    "step #2: blocked needs a note saying what it waits on"
  ] });
  // Leaving the status in the same call frees the note.
  expect(plans.update(workerId, { steps: [{ id: 1, status: "pending", note: "" }] }).ok).toBe(true);
});

test("a new step missing its title still has its other problems listed", () => {
  const { plans, workerId } = env();
  expect(plans.update(workerId, { steps: [{ note: "x".repeat(2001), after: 7 }] })).toEqual({ ok: false, errors: [
    "a new step needs a title",
    "a new step: note is 2001 characters; the limit is 2000",
    "a new step: after #7, which does not exist"
  ] });
});

test("a step appears at most once in a call", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "a" }] });
  const before = plans.get(workerId);
  expect(plans.update(workerId, { steps: [{ id: 1, status: "in_progress" }, { id: 1, status: "pending" }] }))
    .toEqual({ ok: false, errors: ["step #1 appears more than once; send each step once"] });
  // A repeat is still checked for its own problems.
  expect(plans.update(workerId, { steps: [{ id: 1, status: "in_progress" }, { id: 1, title: " ", after: 9 }] })).toEqual({ ok: false, errors: [
    "step #1 appears more than once; send each step once",
    "step #1: title cannot be empty",
    "step #1: after #9, which does not exist"
  ] });
  expect(plans.get(workerId)).toEqual(before);
});

test("the summary names a step's status change and its other edits together", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "a" }, { title: "b" }] });
  const both = plans.update(workerId, { steps: [{ id: 1, title: "a, renamed", status: "done", note: "ok" }] });
  expect(both.ok && both.summary).toBe("Plan updated: #1 done, edited (1 of 2 done)");
  const moved = plans.update(workerId, { steps: [{ id: 1, after: 2 }] });
  expect(moved.ok && moved.summary).toBe("Plan updated: #1 edited (1 of 2 done)");
  const status = plans.update(workerId, { steps: [{ id: 2, status: "in_progress" }] });
  expect(status.ok && status.summary).toBe("Plan updated: #2 in progress (1 of 2 done)");
});

test("an unknown step still has its other problems listed", () => {
  const { plans, workerId } = env();
  expect(plans.update(workerId, { steps: [{ id: 9, note: "x".repeat(2001), after: 4 }] })).toEqual({ ok: false, errors: [
    "step #9 does not exist",
    "step #9: note is 2001 characters; the limit is 2000",
    "step #9: after #4, which does not exist"
  ] });
});

test("a step cannot be placed after itself", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "a" }, { title: "b" }] });
  expect(plans.update(workerId, { steps: [{ id: 2, after: 2 }] })).toEqual({ ok: false, errors: ["step #2: cannot be placed after itself"] });
  expect(plans.get(workerId).steps.map((s) => s.id)).toEqual([1, 2]);
});

test("a call that changes nothing writes nothing, even the first one", () => {
  const { plans, workerId } = env();
  expect(plans.update(workerId, {})).toMatchObject({ ok: true, summary: "Plan unchanged (0 of 0 done)" });
  expect(plans.update(workerId, { openQuestions: [] })).toMatchObject({ ok: true, summary: "Plan unchanged (0 of 0 done)" });
  expect(plans.get(workerId).updatedAt).toBeNull();
  plans.update(workerId, { steps: [{ title: "a" }, { title: "b" }] });
  const before = plans.get(workerId);
  // Resending the whole list, with each step after the one it already follows.
  const same = plans.update(workerId, { steps: [{ id: 1, title: "a" }, { id: 2, title: "b", after: 1 }] });
  expect(same.ok && same.summary).toBe("Plan unchanged (0 of 2 done)");
  expect(plans.get(workerId)).toEqual(before);
});

test("any error rejects the whole call, and nothing of it is written", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "a" }] });
  const before = plans.get(workerId);
  const refused = plans.update(workerId, { conclusion: "changed", steps: [{ id: 1, title: "renamed" }, { id: 9, status: "pending" }, { note: "no title" }], delete: [5] });
  expect(refused).toEqual({ ok: false, errors: ["step #9 does not exist", "a new step needs a title", "delete: step #5 does not exist"] });
  expect(plans.get(workerId)).toEqual(before);
});

test("limits count characters, so a CJK conclusion is measured as written", () => {
  const { plans, workerId } = env();
  expect(plans.update(workerId, { conclusion: "等".repeat(300) }).ok).toBe(true);
  // An emoji is two UTF-16 units; a limit in units would refuse this.
  expect(plans.update(workerId, { conclusion: "😀".repeat(300) }).ok).toBe(true);
  expect(plans.update(workerId, { conclusion: "等".repeat(331) })).toEqual({ ok: false, errors: ["conclusion is 331 characters; the limit is 300"] });
  expect(plans.update(workerId, { openQuestions: ["1", "2", "3", "4", "5", "6"] })).toEqual({ ok: false, errors: ["openQuestions has 6 items; the limit is 5"] });
});

// A worker told "at most 300" lands a little over now and then; sending that
// back costs a call and shows the user a failed row for a few characters.
test("a conclusion or an open question up to a tenth past its limit is kept; further past it is refused", () => {
  const { plans, workerId } = env();
  expect(plans.update(workerId, { conclusion: "c".repeat(330), openQuestions: ["q".repeat(330)] }).ok).toBe(true);
  expect(plans.get(workerId)).toMatchObject({ conclusion: "c".repeat(330), openQuestions: ["q".repeat(330)] });
  expect(plans.update(workerId, { conclusion: "c".repeat(331), openQuestions: ["ok?", "q".repeat(331)] })).toEqual({ ok: false, errors: [
    "conclusion is 331 characters; the limit is 300",
    "openQuestions[1] is 331 characters; the limit is 300"
  ] });
  expect(plans.get(workerId)).toMatchObject({ conclusion: "c".repeat(330), openQuestions: ["q".repeat(330)] });
});

test("deleted ids are never reused, and goal changes are kept", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { goal: "Ship A", steps: [{ title: "a" }, { title: "b" }] });
  const deleted = plans.update(workerId, { goal: "Ship A and B", delete: [2], steps: [{ title: "c" }] });
  expect(deleted.ok && deleted.summary).toBe("Plan updated: goal; added #3; deleted #2 (0 of 2 done)");
  const plan = plans.get(workerId);
  expect(plan.steps.map((s) => s.id)).toEqual([1, 3]);
  expect(plan.goal).toBe("Ship A and B");
  expect(plan.goalHistory.map((g) => g.goal)).toEqual(["Ship A"]);
});

test("two updates in a row each see the other's steps", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "a" }, { title: "b" }] });
  plans.update(workerId, { steps: [{ title: "c" }, { title: "d" }, { id: 1, status: "in_progress" }] });
  expect(plans.get(workerId).steps.map((s) => `${s.id}:${s.status}`)).toEqual(["1:in_progress", "2:pending", "3:pending", "4:pending"]);
});

test("active plans leave archived workers out", () => {
  const { plans, workerId, workers } = env();
  plans.update(workerId, { conclusion: "x" });
  expect(plans.pagePlansOfActive().map((p) => p.workerId)).toEqual([workerId]);
  workers.archive(workerId);
  expect(plans.pagePlansOfActive()).toStrictEqual([]);
});

test("an update says whether it changed anything, even when two land in one millisecond", () => {
  const e = freshStoresEnv("md-plan-same-ms-");
  const projectId = seedProject(e.projects);
  const workerId = seedWorker(e.workers, projectId);
  const plans = new PlanStore(e.store.db, () => "2026-09-27T00:00:00.000Z");
  const first = plans.update(workerId, { steps: [{ title: "a" }] });
  const second = plans.update(workerId, { steps: [{ id: 1, status: "done", note: "ok" }] });
  const same = plans.update(workerId, { steps: [{ id: 1, note: "ok" }] });
  expect([first, second, same].map((r) => r.ok && r.changed)).toEqual([true, true, false]);
});

test("steps added after the same step in one call keep the order they were given", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "one" }, { title: "two" }] });
  const r = plans.update(workerId, { steps: [{ title: "a", after: 1 }, { title: "b", after: 1 }, { title: "c", after: 1 }] });
  expect(r.ok && r.plan.steps.map((s) => s.title)).toEqual(["one", "a", "b", "c", "two"]);
  // A step already right after the anchor still counts as placed there.
  const s = plans.update(workerId, { steps: [{ id: 3, after: 1 }, { title: "d", after: 1 }] });
  expect(s.ok && s.plan.steps.map((x) => x.title)).toEqual(["one", "a", "d", "b", "c", "two"]);
});

test("a step placed after one that moved later in the call goes after it where it now is", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "A" }, { title: "B" }, { title: "C" }] });
  const r = plans.update(workerId, { steps: [{ title: "X", after: 1 }, { id: 1, after: 3 }, { title: "Y", after: 1 }] });
  expect(r.ok && r.plan.steps.map((s) => s.title)).toEqual(["X", "B", "C", "A", "Y"]);
});

test("open questions are kept trimmed, without blanks or repeats; limits count the trimmed text", () => {
  const { plans, workerId } = env();
  const r = plans.update(workerId, {
    conclusion: `${"c".repeat(300)}   `,
    openQuestions: ["  Ship it behind a flag?  ", "", "Ship it behind a flag?", "   ", `${"q".repeat(300)}  `],
    steps: [{ title: `${"t".repeat(200)}   `, note: `  ${"n".repeat(2000)}  ` }]
  });
  expect(r.ok).toBe(true);
  const plan = plans.get(workerId);
  expect(plan.conclusion).toBe("c".repeat(300));
  expect(plan.openQuestions).toEqual(["Ship it behind a flag?", "q".repeat(300)]);
  expect(plan.steps[0]!.title).toBe("t".repeat(200));
  // The same questions again, spaced differently, change nothing.
  const again = plans.update(workerId, { openQuestions: ["Ship it behind a flag?  ", "q".repeat(300)] });
  expect(again.ok && again.changed).toBe(false);
});

test("one call that edits and deletes the same step says so", () => {
  const { plans, workerId } = env();
  plans.update(workerId, { steps: [{ title: "a" }, { title: "b" }] });
  expect(plans.update(workerId, { steps: [{ id: 1, note: "x" }, { title: "c", after: 2 }], delete: [1, 2] })).toEqual({ ok: false, errors: [
    "step #1 is both changed and deleted in this call; send one",
    "a new step: after #2, which this call deletes"
  ] });
});
