import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearnedSkillStore, type LearnedSkillWhere } from "../src/server/modules/skills/learned-skill-store.js";
import { buildTidyTools, TIDY_TOOL_ERRORS, type TidyState } from "../src/server/modules/skills/skill-tidy-tools.js";
import { REVIEW_TOOL_ERRORS } from "../src/server/modules/skills/skill-review-tools.js";
import { testStore } from "./helpers/test-store.js";

// The tidy's tools: read a skill, then merge, rewrite, move or archive it
// with manage_skill — each change staged, written only when the tidy ends
// well; a skill once (another call on it replaces its change), five changes
// at most, only available ones.

const opened: Array<() => void> = [];
afterEach(() => { while (opened.length) opened.pop()!(); });

const PROJECT = { id: "proj_one", name: "project-1" };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-skill-tidy-tools-"));
  const store = testStore(dir);
  const skills = new LearnedSkillStore(store.db, () => new Set());
  opened.push(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const state: TidyState = { readRevisions: new Map(), staged: [], finished: null };
  const tools = buildTidyTools({ store: skills, projects: () => [PROJECT], projectName: (id) => (id === PROJECT.id ? PROJECT.name : null), lookupTools: [] }, state);
  const call = (name: string, args: unknown) => tools.find((t) => t.name === name)!.handler(args as never, {} as never) as Promise<Record<string, unknown>>;
  const make = (name: string, where: LearnedSkillWhere = { scope: "user" }) => {
    const made = skills.create({ name, description: `The ${name} work.`, body: `1. Do ${name}.`, where, by: "review", reason: "Created." });
    if (!made.ok) throw new Error(made.message);
    return made.skill;
  };
  return { skills, state, tools, call, make };
}

test("a merge stages the survivor's new text and the others archived into it; each must have been read at its revision", async () => {
  const { skills, state, call, make } = setup();
  const a = make("release-steps");
  const b = make("release-notes");
  const merge = { action: "merge", name: "release-steps", revision: 1, absorbed: [{ name: "release-notes", revision: 1 }], body: "1. Notes.\n2. Tag.", reason: "Both cover a release." };
  expect(await call("manage_skill", merge)).toEqual({ error: REVIEW_TOOL_ERRORS.notRead });
  await call("read_skill", { name: "release-steps" });
  await call("read_skill", { name: "release-notes" });
  expect((await call("manage_skill", merge)).error).toBeUndefined();
  expect(state.staged).toEqual([{ kind: "merge", survivor: { skillId: a.id, baseRevision: 1 }, absorbed: [{ skillId: b.id, baseRevision: 1 }], body: "1. Notes.\n2. Tag.", reason: "Both cover a release." }]);
  // A skill changed since it was read is read again first.
  const c = make("nightly-check");
  await call("read_skill", { name: "nightly-check" });
  skills.change(c.id, 1, { body: "1. Check.", change: "patch", by: "agent", reason: "Shorter." });
  expect(await call("manage_skill", { action: "rewrite", name: "nightly-check", revision: 1, body: "1. Look.", reason: "Plainer." })).toEqual({ error: REVIEW_TOOL_ERRORS.stale });
});

test("a skill is changed at most once in a tidy, at most five changes, and only available skills", async () => {
  const { skills, state, call, make } = setup();
  const names = ["s-one", "s-two", "s-three", "s-four", "s-five", "s-six", "s-seven"];
  const made = names.map((n) => make(n));
  skills.change(made[6]!.id, 1, { status: "archived", archivedReason: "Old.", change: "archive", by: "agent", reason: "Old." });
  for (const n of names) await call("read_skill", { name: n });
  expect((await call("manage_skill", { action: "rewrite", name: "s-one", revision: 1, body: "1. One.", reason: "Plainer." })).error).toBeUndefined();
  // Another call on the same skill replaces its change; it is no second one.
  expect((await call("manage_skill", { action: "rewrite", name: "s-one", revision: 1, body: "1. Again.", reason: "Plainer still." })).error).toBeUndefined();
  expect(state.staged).toHaveLength(1);
  expect(state.staged[0]).toMatchObject({ kind: "rewrite", body: "1. Again.", reason: "Plainer still." });
  expect(await call("manage_skill", { action: "merge", name: "s-two", revision: 1, absorbed: [{ name: "s-one", revision: 1 }], body: "x", reason: "Same work." })).toEqual({ error: TIDY_TOOL_ERRORS.once });
  expect(await call("manage_skill", { action: "rewrite", name: "s-seven", revision: 2, body: "1. Back.", reason: "Plainer." })).toEqual({ error: TIDY_TOOL_ERRORS.notAvailable });
  for (const n of ["s-two", "s-three", "s-four", "s-five"]) {
    expect((await call("manage_skill", { action: "archive", name: n, revision: 1, reason: "No longer right." })).error).toBeUndefined();
  }
  expect(await call("manage_skill", { action: "rewrite", name: "s-six", revision: 1, body: "1. Six.", reason: "Plainer." })).toEqual({ error: TIDY_TOOL_ERRORS.limit });
  // At five, a change can still be done otherwise.
  expect((await call("manage_skill", { action: "rewrite", name: "s-two", revision: 1, body: "1. Two.", reason: "Plainer, not archived." })).error).toBeUndefined();
  expect(state.staged.map((c) => c.kind)).toEqual(["rewrite", "rewrite", "archive", "archive", "archive"]);
});

test("move takes global or an active project's name", async () => {
  const { state, call, make } = setup();
  make("deploy-check");
  make("check-ovens", { scope: "project", projectId: PROJECT.id });
  await call("read_skill", { name: "deploy-check" });
  await call("read_skill", { name: "check-ovens" });
  expect(await call("manage_skill", { action: "move", name: "deploy-check", revision: 1, scope: "project-9", reason: "It is that project's." })).toEqual({ error: TIDY_TOOL_ERRORS.noProject("project-9") });
  expect((await call("manage_skill", { action: "move", name: "deploy-check", revision: 1, scope: "project-1", reason: "It is that project's." })).error).toBeUndefined();
  expect((await call("manage_skill", { action: "move", name: "check-ovens", revision: 1, scope: "global", reason: "Not one project's." })).error).toBeUndefined();
  expect(state.staged.map((c) => (c.kind === "move" ? c.where : null))).toEqual([{ scope: "project", projectId: PROJECT.id }, { scope: "user" }]);
});

test("the tidy is offered read_skill, manage_skill with its four actions, and finish", () => {
  const { tools } = setup();
  expect(Object.fromEntries(tools.map((t) => [t.name, t.description]))).toEqual({
    read_skill: "Read a learned skill's full text and revision, archived ones included.",
    manage_skill: "Make one of this tidy's changes, at most five, each skill once: merge skills that cover the same kind of work (the survivor gets the merged text, the others are archived as merged into it), rewrite, move or archive one. They are saved together when the tidy ends well; calling again on the same skill replaces its change.",
    finish: "End the tidy with one sentence on what you changed, or why nothing needed to change."
  });
  expect(TIDY_TOOL_ERRORS.once).toBe("You can change this skill once in this tidy; call again on the skill whose change you are replacing.");
});

test("a merge or rewrite that only adds is staged, and told to fold it into its step", async () => {
  const { state, call, make } = setup();
  make("release-steps");
  await call("read_skill", { name: "release-steps" });
  const grown = "1. Do release-steps.\n- Check A.\n- Check B.\n- Check C.\n- Check D.\n- Check E.";
  const result = await call("manage_skill", { action: "rewrite", name: "release-steps", revision: 1, body: grown, reason: "More checks." });
  expect(result.advice).toEqual([
    "This change only adds to the skill: fold what it teaches into the step it corrects or adds to, and take out what that step no longer needs.",
    "To do it otherwise, call manage_skill again on this skill: that replaces this change."
  ]);
  expect(state.staged).toHaveLength(1);
});
