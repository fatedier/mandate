import { expect, test } from "bun:test";
import * as path from "node:path";
import { renderTidyOpening, type TidyLine } from "../src/server/modules/skills/skill-tidy-input.js";
import { skillPrompt } from "../src/server/modules/skills/skill-authoring-standard.js";

// The tidy's and the review's prompts, and the opening the tidy reads: every
// learned skill, one line each.

const PROMPTS = path.join(import.meta.dir, "../src/server/modules/skills/prompts");

const STANDARD = `How a skill is written:
- It is the procedure for one kind of work that comes back: when it applies, what to check first, the steps in order, the pitfalls with what to do about each, how to verify the result. It names the conditions it applies in, not the particulars of one task.
- It reads as the current procedure. A lesson goes into the step it corrects or adds to, and what that step no longer needs comes out. A lesson learned again sharpens the rule already there; it is never written twice.
- It carries no account of a run, no update notes, dates or ticket numbers.
- Never drop a step that was shown to be needed, a correction the user made, or a check that guards a pitfall; shorter is not a goal of its own.
- Keep it within 500 lines.`;

const TIDY_PROMPT = `You tidy the learned skills: written procedures for kinds of work that come back. Keep them few, correct and distinct, so that an agent finds one procedure for its kind of work and can follow it.

Read a skill with \`read_skill\` before you change it. Look for:
- skills that cover the same kind of work: merge them into the one that covers it best, keeping every step of the others that it lacks;
- a skill that has grown into a record of particular tasks: rewrite it as the general procedure for its kind of work and leave out what was true of one task only;
- steps that contradict each other, or that a newer step superseded: keep the one the user's rules support, and remove the other; search memory for the user's rules about that step before you choose;
- a skill in the wrong place: global when it does not depend on one project, the project's when it does;
- a skill that is no longer right: archive it, saying why.

${STANDARD}

Change nothing you are unsure of: a skill left as it is costs less than a wrong one. Make at most five changes, those that matter most first. End with \`finish\`, saying in one sentence what you changed, or why nothing needed to change.`;

// The review's writing rules are the shared standard, between its rule on
// reading before a change and its words on a skill's name and scope.
const REVIEW_AROUND = [
  "Read a skill with `read_skill` in this review before you change it.",
  STANDARD,
  "Give it a short lowercase name with hyphens and a one-sentence description of the kind of work it is for. Choose its scope: the project when the procedure depends on that project, otherwise global.",
  "End with `finish`, saying in one sentence what you changed and why, or why nothing should change."
].join("\n\n");

test("the tidy's and the review's prompts carry the one authoring standard, word for word", () => {
  expect(skillPrompt(path.join(PROMPTS, "skill-tidy-system.md"))).toBe(TIDY_PROMPT);
  const review = skillPrompt(path.join(PROMPTS, "skill-review-system.md"));
  expect(review.endsWith(REVIEW_AROUND)).toBe(true);
  expect(review).not.toContain("A skill is general to its kind of work");
  expect(review).not.toContain("When you change a skill, fold what this work taught");
});

const line = (over: Partial<TidyLine> = {}): TidyLine => ({
  name: "release-steps", description: "Cut a release.", where: "global", revision: 3, uses30: 2, uses90: 4,
  lastUsedAt: "2026-11-18T09:00:00.000Z", lastChangedAt: "2026-11-17T10:00:00.000Z", lines: 42, ...over
});

test("the opening lists available then archived skills, one line each, in its fixed words", () => {
  expect(renderTidyOpening({ available: [line(), line({ name: "check-ovens", where: "project project-1", lastUsedAt: null, uses30: 0, uses90: 0 })], archived: [line({ name: "old-steps", revision: 1 })] })).toBe([
    "A tidy of the learned skills. One line each: name — description (where; revision; uses in 30 and 90 days; last used; last changed; lines).",
    "Available:",
    "- release-steps — Cut a release. (global; revision 3; 2 and 4 uses; last used 2026-11-18; last changed 2026-11-17; 42 lines)",
    "- check-ovens — Cut a release. (project project-1; revision 3; 0 and 0 uses; last used never; last changed 2026-11-17; 42 lines)",
    "Archived:",
    "- old-steps — Cut a release. (global; revision 1; 2 and 4 uses; last used 2026-11-18; last changed 2026-11-17; 42 lines)"
  ].join("\n"));
  expect(renderTidyOpening({ available: [], archived: [] }).split("\n").slice(1)).toEqual(["Available: none.", "Archived: none."]);
  // Past its budget, the descriptions are cut first.
  const long = renderTidyOpening({ available: [line({ description: "x".repeat(300) })], archived: [], budgetChars: 200 });
  expect(long).toContain(`- release-steps — ${"x".repeat(119)}… (global;`);
});
