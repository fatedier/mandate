import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearnedSkillStore, type LearnedSkillWhere } from "../src/server/modules/skills/learned-skill-store.js";
import { testStore } from "./helpers/test-store.js";

const opened: Array<() => void> = [];
afterEach(() => { while (opened.length) opened.pop()!(); });

const GLOBAL: LearnedSkillWhere = { scope: "user" };
const P1: LearnedSkillWhere = { scope: "project", projectId: "proj_one" };
const P2: LearnedSkillWhere = { scope: "project", projectId: "proj_two" };

function fresh(fileSkills: string[] = [], at = "2026-11-16T08:00:00.000Z") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-learned-skills-"));
  const store = testStore(dir);
  let clock = Date.parse(at);
  const skills = new LearnedSkillStore(store.db, () => new Set(fileSkills), () => new Date(clock));
  opened.push(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { skills, db: store.db, tick: (ms = 1000) => { clock += ms; } };
}

const make = (s: LearnedSkillStore, name = "release-steps", where: LearnedSkillWhere = GLOBAL, body = "1. Tag.\n2. Build.") => {
  const made = s.create({ name, description: "Cut a release.", body, where, by: "review", reason: "Created." });
  if (!made.ok) throw new Error(made.message);
  return made.skill;
};

test("a skill is created at revision 1 with its version row, and a change moves it to 2", () => {
  const { skills } = fresh();
  const skill = make(skills);
  expect([skill.revision, skill.status, skill.where]).toEqual([1, "available", GLOBAL]);
  const changed = skills.change(skill.id, 1, { body: "1. Tag.\n2. Build.\n3. Verify.", change: "patch", by: "agent", threadId: "thr_m", reason: "Verify was missing." });
  expect(changed.ok && changed.skill.revision).toBe(2);
  expect(skills.versions(skill.id).map((v) => [v.revision, v.change, v.by])).toEqual([[2, "patch", "agent"], [1, "create", "review"]]);
  expect(skills.version(skill.id, 1)?.body).toBe("1. Tag.\n2. Build.");
});

test("a change from a stale revision is refused and nothing is written", () => {
  const { skills } = fresh();
  const skill = make(skills);
  expect(skills.change(skill.id, 1, { body: "A", change: "patch", by: "agent" }).ok).toBe(true);
  const late = skills.change(skill.id, 1, { body: "B", change: "patch", by: "review" });
  expect(late.ok ? null : late.error).toBe("stale");
  expect([skills.get(skill.id)?.body, skills.versions(skill.id).length]).toEqual(["A", 2]);
});

test("names are lowercase-hyphen, unique, and never a file skill's", () => {
  const { skills } = fresh(["canvas-design"]);
  const bad = skills.create({ name: "Bad Name", description: "x", body: "x", where: GLOBAL, by: "review" });
  expect(bad.ok ? null : [bad.error, bad.message]).toEqual(["invalid", "A name is lowercase letters, digits and hyphens, at most 64 characters."]);
  make(skills, "release-steps");
  const twice = skills.create({ name: "release-steps", description: "x", body: "x", where: P1, by: "review" });
  expect(twice.ok ? null : [twice.error, twice.message]).toEqual(["name_taken", "A skill with this name already exists."]);
  const file = skills.create({ name: "canvas-design", description: "x", body: "x", where: GLOBAL, by: "review" });
  expect(file.ok ? null : [file.error, file.message]).toEqual(["name_taken", "A skill file has this name."]);
  expect(skills.create({ name: "a".repeat(65), description: "x", body: "x", where: GLOBAL, by: "review" }).ok).toBe(false);
});

test("500 lines and 40,000 characters are allowed, one more is not", () => {
  const { skills } = fresh();
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i}`).join("\n");
  expect(skills.create({ name: "five-hundred", description: "x", body: lines(500), where: GLOBAL, by: "review" }).ok).toBe(true);
  const over = skills.create({ name: "five-hundred-one", description: "x", body: lines(501), where: GLOBAL, by: "review" });
  expect(over.ok ? null : over.message).toBe("The skill would be longer than 500 lines or 40,000 characters.");
  expect(skills.create({ name: "forty-k", description: "x", body: "a".repeat(40_000), where: GLOBAL, by: "review" }).ok).toBe(true);
  expect(skills.create({ name: "forty-k-one", description: "x", body: "a".repeat(40_001), where: GLOBAL, by: "review" }).ok).toBe(false);
  expect(skills.create({ name: "long-description", description: "d".repeat(301), body: "x", where: GLOBAL, by: "review" }).ok).toBe(false);
});

test("revert without a revision undoes the newest change; of a create it archives the skill", () => {
  const { skills } = fresh();
  const skill = make(skills);
  skills.change(skill.id, 1, { body: "changed", change: "patch", by: "agent" });
  const back = skills.revert(skill.id, { by: "agent", threadId: "thr_n", reason: "The user asked." });
  expect(back.ok && [back.skill.revision, back.skill.body]).toEqual([3, "1. Tag.\n2. Build."]);
  expect(skills.versions(skill.id)[0]!.change).toBe("revert");
  const other = make(skills, "only-created");
  const gone = skills.revert(other.id, { by: "agent", reason: "The user asked." });
  expect(gone.ok && [gone.skill.status, gone.skill.revision]).toEqual(["archived", 2]);
});

test("revert of an action over two skills puts both back, and is blocked by a later change", () => {
  const { skills } = fresh();
  const a = make(skills, "skill-a");
  const b = make(skills, "skill-b");
  // One action (as a tidy's merge): the survivor rewritten, the other archived.
  const changeId = "chg_merge";
  skills.change(a.id, 1, { body: "merged", change: "merge", by: "tidy", changeId });
  skills.change(b.id, 1, { status: "archived", archivedReason: "Merged into skill-a.", change: "merge", by: "tidy", changeId });
  const undone = skills.revert(a.id, { by: "agent", reason: "The user asked." });
  expect(undone.ok).toBe(true);
  expect([skills.get(a.id)?.body, skills.get(b.id)?.status]).toEqual(["1. Tag.\n2. Build.", "available"]);
  // Again, with a later change to one of them in the way.
  const c = make(skills, "skill-c");
  const d = make(skills, "skill-d");
  skills.change(c.id, 1, { body: "merged", change: "merge", by: "tidy", changeId: "chg_two" });
  skills.change(d.id, 1, { status: "archived", change: "merge", by: "tidy", changeId: "chg_two" });
  skills.change(d.id, 2, { status: "available", change: "restore", by: "agent" });
  const blocked = skills.revert(c.id, { by: "agent", reason: "The user asked." });
  expect(blocked.ok ? null : [blocked.error, blocked.message]).toEqual(["blocked", "A later change to skill-d came after it; revert that first."]);
  expect(skills.get(c.id)?.body).toBe("merged");
});

test("revert to a revision puts that revision's text back as a new one", () => {
  const { skills } = fresh();
  const skill = make(skills);
  skills.change(skill.id, 1, { body: "two", change: "patch", by: "agent" });
  skills.change(skill.id, 2, { body: "three", change: "patch", by: "agent" });
  const back = skills.revert(skill.id, { toRevision: 1, by: "agent", reason: "The user asked." });
  expect(back.ok && [back.skill.revision, back.skill.body]).toEqual([4, "1. Tag.\n2. Build."]);
  const none = skills.revert(skill.id, { toRevision: 9, by: "agent", reason: "x" });
  expect(none.ok ? null : none.message).toBe("The skill has no revision 9.");
});

test("only the latest 30 revisions are kept, and the first", () => {
  const { skills } = fresh();
  const skill = make(skills);
  for (let i = 1; i <= 35; i++) skills.change(skill.id, i, { body: `body ${i}`, change: "patch", by: "agent" });
  const kept = skills.versions(skill.id).map((v) => v.revision);
  expect([kept.length, kept[0], kept.includes(1), kept.includes(6), kept.includes(7)]).toEqual([31, 36, true, false, true]);
});

test("visible gives available global skills and those of the given projects", () => {
  const { skills } = fresh();
  make(skills, "global-one", GLOBAL);
  make(skills, "first-project", P1);
  make(skills, "second-project", P2);
  const archived = make(skills, "global-archived", GLOBAL);
  skills.change(archived.id, 1, { status: "archived", archivedReason: "x", change: "archive", by: "agent" });
  expect(skills.visible({ projectIds: ["proj_one"] }).map((s) => s.name).sort()).toEqual(["first-project", "global-one"]);
  expect(skills.visible({ projectIds: "all" }).map((s) => s.name).sort()).toEqual(["first-project", "global-one", "second-project"]);
  expect(skills.list({ status: "archived" }).map((s) => s.name)).toEqual(["global-archived"]);
  expect(skills.list({ where: P2 }).map((s) => s.name)).toEqual(["second-project"]);
});

test("a use moves last used and counts in usesSince", () => {
  const { skills, tick } = fresh();
  const skill = make(skills);
  expect(skills.get(skill.id)?.lastUsedAt).toBeNull();
  tick(60_000);
  skills.recordUse(skill.id, "thr_w", "worker");
  skills.recordUse(skill.id, "thr_m", "manager");
  expect(skills.get(skill.id)?.lastUsedAt).toBe("2026-11-16T08:01:00.000Z");
  expect([skills.usesSince(skill.id, "2026-11-16T08:00:30.000Z"), skills.usesSince(skill.id, "2026-11-16T08:02:00.000Z")]).toEqual([2, 0]);
});

test("a review requested twice for one thread joins into one queued run", () => {
  const { skills } = fresh();
  const first = skills.requestReview({ threadId: "thr_w", requestedBy: "thr_m", focus: "the renewal order", fromSeq: 1, toSeq: 40 });
  const second = skills.requestReview({ threadId: "thr_w", requestedBy: "thr_n", focus: "the oven pitfall", fromSeq: 1, toSeq: 55 });
  expect([first.joined, second.joined, second.id === first.id]).toEqual([false, true, true]);
  const queued = skills.nextQueuedReview();
  expect(queued && [queued.threadId, queued.toSeq, queued.focus]).toEqual(["thr_w", 55, "the renewal order; the oven pitfall"]);
  skills.startReview(first.id, "mock", "mock-model");
  expect(skills.nextQueuedReview()).toBeNull();
  // A request while one is running queues a new one.
  expect(skills.requestReview({ threadId: "thr_w", requestedBy: "thr_m", focus: "more", fromSeq: 56, toSeq: 60 }).joined).toBe(false);
});

// A thread is reviewed at most once a day: what it finishes in the day after
// a review joins one queued run, reviewed a day after that review began.
test("a thread reviewed in the last day waits: requests meanwhile join one run, due a day after that review began; another thread's goes first; a failed review holds nothing", () => {
  const { skills, tick } = fresh();
  const first = skills.requestReview({ threadId: "thr_w", requestedBy: "thr_m", focus: "the renewal order", fromSeq: 1, toSeq: 40 });
  skills.startReview(first.id, "mock", "mock-model");
  skills.finishReview(first.id, { status: "succeeded", outcome: "created" });
  tick(3_600_000);
  const later = skills.requestReview({ threadId: "thr_w", requestedBy: "thr_m", focus: "the oven pitfall", fromSeq: 41, toSeq: 60 });
  tick(1000);
  const other = skills.requestReview({ threadId: "thr_x", requestedBy: "thr_m", focus: "the audit", fromSeq: 1, toSeq: 9 });
  expect(skills.nextQueuedReview()?.id).toBe(other.id);
  skills.startReview(other.id, "mock", "mock-model");
  skills.finishReview(other.id, { status: "succeeded", outcome: "none" });
  expect(skills.requestReview({ threadId: "thr_w", requestedBy: "thr_n", focus: "the rollback", fromSeq: 41, toSeq: 75 }).joined).toBe(true);
  expect(skills.nextQueuedReview()).toBeNull();
  // A day after the first review began, less a second; then due.
  tick(24 * 3_600_000 - 3_600_000 - 1000 - 1000);
  expect(skills.nextQueuedReview()).toBeNull();
  tick(2000);
  const due = skills.nextQueuedReview();
  expect(due && [due.id, due.fromSeq, due.toSeq, due.focus]).toEqual([later.id, 41, 75, "the oven pitfall; the rollback"]);
  // A review that failed saved nothing: the thread's next request is not held.
  const failed = skills.requestReview({ threadId: "thr_f", requestedBy: "thr_m", focus: "x", fromSeq: 1, toSeq: 5 });
  skills.startReview(failed.id, "mock", "mock-model");
  skills.finishReview(failed.id, { status: "failed", error: "provider down" });
  tick(1000);
  skills.startReview(later.id, "mock", "mock-model");
  const again = skills.requestReview({ threadId: "thr_f", requestedBy: "thr_m", focus: "x", fromSeq: 1, toSeq: 6 });
  expect(skills.nextQueuedReview()?.id).toBe(again.id);
});

test("interrupted reviews are closed at start", () => {
  const { skills } = fresh();
  const run = skills.requestReview({ threadId: "thr_w", requestedBy: "thr_m", focus: "x", fromSeq: 1, toSeq: 2 });
  skills.startReview(run.id, "mock", "mock-model");
  expect(skills.closeInterruptedReviews()).toBe(1);
  expect(skills.review(run.id)?.status).toBe("failed");
});

test("review marks remember how far a thread was reviewed", () => {
  const { skills } = fresh();
  expect(skills.reviewMark("thr_w")).toBeNull();
  skills.setReviewMark("thr_w", 40);
  skills.setReviewMark("thr_w", 55);
  expect(skills.reviewMark("thr_w")).toBe(55);
});

test("pruning keeps which skills an action touched: a revert stays blocked by a later change past the kept revisions", () => {
  const { skills } = fresh();
  const a = make(skills, "skill-a");
  const b = make(skills, "skill-b");
  skills.change(a.id, 1, { body: "merged", change: "merge", by: "tidy", changeId: "chg_long" });
  skills.change(b.id, 1, { status: "archived", change: "merge", by: "tidy", changeId: "chg_long" });
  // b moves on far enough that the merge's own revision of b is no longer kept.
  skills.change(b.id, 2, { status: "available", change: "restore", by: "agent" });
  for (let r = 3; r < 33; r++) skills.change(b.id, r, { body: `b ${r}`, change: "patch", by: "agent" });
  expect(skills.versions(b.id).some((v) => v.revision === 2)).toBe(false);
  const blocked = skills.revert(a.id, { by: "agent", reason: "The user asked." });
  expect(blocked.ok ? null : blocked.error).toBe("blocked");
});

test("reverting a restore brings back what a merge archived it into", () => {
  const { skills } = fresh();
  const a = make(skills, "skill-a");
  const b = make(skills, "skill-b");
  skills.change(b.id, 1, { status: "archived", archivedReason: "Merged into skill-a.", absorbedInto: a.id, change: "merge", by: "tidy" });
  skills.change(b.id, 2, { status: "available", change: "restore", by: "agent" });
  expect(skills.get(b.id)?.absorbedInto).toBeNull();
  skills.revert(b.id, { by: "agent", reason: "The user asked." });
  expect([skills.get(b.id)?.status, skills.get(b.id)?.absorbedInto, skills.get(b.id)?.archivedReason]).toEqual(["archived", a.id, "Merged into skill-a."]);
});

const DAY = 86_400_000;

test("the 60-day rule archives a skill with neither a use nor a change in more than 60 days, as the rule, with its reason; one used or changed since stays", () => {
  const { skills, tick } = fresh();
  const idle = make(skills, "idle-steps");
  const used = make(skills, "used-steps");
  const changed = make(skills, "changed-steps");
  tick(30 * DAY);
  skills.recordUse(used.id, "thr_m", "manager");
  tick(10 * DAY);
  expect(skills.change(changed.id, 1, { body: "1. Tag.", change: "patch", by: "agent", reason: "Shorter." }).ok).toBe(true);
  tick(21 * DAY);
  const young = make(skills, "young-steps");
  const archived = skills.archiveUnused();
  expect(archived.map((s) => s.name)).toEqual(["idle-steps"]);
  const now = skills.get(idle.id)!;
  expect([now.status, now.archivedReason]).toEqual(["archived", "No use in 60 days"]);
  expect(skills.versions(idle.id).map((v) => [v.change, v.by, v.reason])[0]).toEqual(["archive", "rule", "No use in 60 days"]);
  expect([used, changed, young].map((s) => skills.get(s.id)!.status)).toEqual(["available", "available", "available"]);
  // Already archived: left as it is.
  tick(DAY);
  expect(skills.archiveUnused()).toEqual([]);
});

test("a skill the 60-day rule archived comes back with a restore, and its clock starts again", () => {
  const { skills, tick } = fresh();
  const idle = make(skills, "idle-steps");
  tick(61 * DAY);
  expect(skills.archiveUnused().map((s) => s.id)).toEqual([idle.id]);
  const archived = skills.get(idle.id)!;
  expect(skills.change(idle.id, archived.revision, { status: "available", archivedReason: null, change: "restore", by: "agent", reason: "Asked." }).ok).toBe(true);
  tick(59 * DAY);
  expect(skills.archiveUnused()).toEqual([]);
});

// The weekly tidy of all learned skills: due when none has run and a skill
// exists; a day after one that changed anything (more may be left), or
// failed; after one that changed nothing, seven days after it began once a
// skill changed since.

test("a tidy is due when none has run and a skill exists; after one that changed nothing, seven days and a change since", () => {
  const { skills, tick } = fresh();
  expect(skills.tidyDue()).toBe(false);
  const skill = make(skills);
  expect(skills.tidyDue()).toBe(true);
  tick();
  const run = skills.startTidy("mock", "mock-model");
  expect(skills.tidyDue()).toBe(false);
  skills.finishTidy(run.id, { status: "succeeded", changes: 0, reason: "Nothing." });
  tick(7 * DAY);
  // No change since: nothing to tidy.
  expect(skills.tidyDue()).toBe(false);
  skills.change(skill.id, 1, { body: "1. Tag.", change: "patch", by: "review", reason: "Shorter." });
  expect(skills.tidyDue()).toBe(true);
  const next = skills.startTidy("mock", "mock-model");
  expect(skills.tidyDue()).toBe(false);
  skills.finishTidy(next.id, { status: "succeeded", changes: 0, reason: "Nothing." });
  tick();
  skills.change(skill.id, 2, { body: "1. Tag.\n2. Push.", change: "patch", by: "agent", reason: "A step." });
  tick(7 * DAY - 2000);
  expect(skills.tidyDue()).toBe(false);
  tick(1000);
  expect(skills.tidyDue()).toBe(true);
});

test("a tidy that changed anything, or failed, is due again a day after it began, until one changes nothing", () => {
  const { skills, tick } = fresh();
  const skill = make(skills);
  const one = skills.startTidy("mock", "mock-model");
  skills.change(skill.id, 1, { body: "1. Tag.\n2. Build.", change: "rewrite", by: "tidy", runId: one.id, reason: "Steps in order." });
  skills.finishTidy(one.id, { status: "succeeded", changes: 1, reason: "Rewrote one." });
  tick(DAY - 1000);
  expect(skills.tidyDue()).toBe(false);
  tick(1000);
  // Its own change is all that changed since, and more may be left.
  expect(skills.tidyDue()).toBe(true);
  const failed = skills.startTidy("mock", "mock-model");
  skills.finishTidy(failed.id, { status: "failed", error: "provider down" });
  tick(DAY - 1000);
  expect(skills.tidyDue()).toBe(false);
  tick(1000);
  // The last that succeeded changed something: still more to tidy.
  expect(skills.tidyDue()).toBe(true);
  const done = skills.startTidy("mock", "mock-model");
  skills.finishTidy(done.id, { status: "succeeded", changes: 0, reason: "Nothing." });
  tick(DAY);
  expect(skills.tidyDue()).toBe(false);
  // None ever succeeded: a failed one is tried again a day later.
  const other = fresh();
  make(other.skills);
  const first = other.skills.startTidy("mock", "mock-model");
  other.skills.finishTidy(first.id, { status: "failed", error: "provider down" });
  expect(other.skills.tidyDue()).toBe(false);
  other.tick(DAY);
  expect(other.skills.tidyDue()).toBe(true);
});

test("a tidy's changes are stored and read back as the tidy's, and listed with its run", () => {
  const { skills } = fresh();
  const skill = make(skills);
  const run = skills.startTidy("mock", "mock-model");
  skills.change(skill.id, 1, { body: "1. Tag.", change: "rewrite", by: "tidy", runId: run.id, reason: "One step." });
  skills.finishTidy(run.id, { status: "succeeded", changes: 1, reason: "Rewrote release-steps.", changed: [{ skillId: skill.id, revision: 2 }] });
  expect(skills.history(skill.id).find((v) => v.revision === 2)?.by).toBe("tidy");
  const [listed] = skills.recentTidies(5);
  expect(listed && [listed.id, listed.status, listed.changes, listed.reason, listed.changed]).toEqual([run.id, "succeeded", 1, "Rewrote release-steps.", [{ skillId: skill.id, revision: 2 }]]);
});

test("a tidy's changes stay listed with it after its revisions are pruned", () => {
  const { skills } = fresh();
  const skill = make(skills);
  const run = skills.startTidy("mock", "mock-model");
  skills.change(skill.id, 1, { body: "1. Tag.", change: "rewrite", by: "tidy", runId: run.id, reason: "One step." });
  skills.finishTidy(run.id, { status: "succeeded", changes: 1, reason: "Rewrote release-steps.", changed: [{ skillId: skill.id, revision: 2 }] });
  for (let revision = 2; revision < 40; revision++) skills.change(skill.id, revision, { body: `1. Tag ${revision}.`, change: "patch", by: "agent", reason: "A step." });
  expect(skills.history(skill.id).some((v) => v.revision === 2)).toBe(false);
  expect(skills.recentTidies(1)[0]?.changed).toEqual([{ skillId: skill.id, revision: 2 }]);
});

test("a tidy left running by a stopped server is closed failed", () => {
  const { skills } = fresh();
  make(skills);
  const run = skills.startTidy("mock", "mock-model");
  expect(skills.closeInterruptedTidies()).toBe(1);
  expect(skills.recentTidies(1)[0]).toMatchObject({ id: run.id, status: "failed" });
});
