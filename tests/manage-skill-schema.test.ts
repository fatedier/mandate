import { expect, test } from "bun:test";
import type { z } from "zod";
import { AGENT_ACTIONS, MANAGE_SKILL_DESCRIPTIONS, MANAGE_SKILL_TOOL_NAME, REVIEW_ACTIONS, TIDY_ACTIONS, manageSkillParams } from "../src/server/modules/skills/manage-skill-schema.js";

// One tool for every writer of learned skills: each is offered its own
// actions, and only the parameters those actions use, in the same words.

const shape = (actions: Parameters<typeof manageSkillParams>[0]) => manageSkillParams(actions).shape as Record<string, z.ZodTypeAny>;
const described = (actions: Parameters<typeof manageSkillParams>[0]) => Object.fromEntries(Object.entries(shape(actions)).map(([key, field]) => [key, field.description]));

test("each writer is offered its own actions and only the parameters they use", () => {
  expect(MANAGE_SKILL_TOOL_NAME).toBe("manage_skill");
  expect([...AGENT_ACTIONS]).toEqual(["patch", "rewrite", "revert", "archive", "restore", "move"]);
  expect([...REVIEW_ACTIONS]).toEqual(["create", "patch", "rewrite", "restore"]);
  expect([...TIDY_ACTIONS]).toEqual(["merge", "rewrite", "move", "archive"]);
  expect(Object.keys(shape(AGENT_ACTIONS)).sort()).toEqual(["action", "body", "description", "name", "new_text", "old_text", "reason", "revision", "scope", "to_revision"]);
  expect(Object.keys(shape(REVIEW_ACTIONS)).sort()).toEqual(["action", "body", "description", "name", "new_text", "old_text", "reason", "revision", "scope"]);
  expect(Object.keys(shape(TIDY_ACTIONS)).sort()).toEqual(["absorbed", "action", "body", "description", "name", "reason", "revision", "scope"]);
  const params = manageSkillParams(REVIEW_ACTIONS);
  expect(params.safeParse({ name: "a", action: "merge", reason: "x" }).success).toBe(false);
  expect(params.safeParse({ name: "a", action: "patch", reason: "x" }).success).toBe(true);
  expect(params.safeParse({ name: "a", action: "patch" }).success).toBe(false);
});

test("the tool's descriptions and parameter descriptions are word for word", () => {
  expect(MANAGE_SKILL_DESCRIPTIONS).toEqual({
    agent: "Change a learned skill: patch or rewrite its text (a skill you loaded in this conversation), revert a change, archive, restore, or move it. It applies at once and the user is told.",
    review: "Make this review's one change to the learned skills: create, patch, rewrite or restore a skill. It is saved when the review ends well; calling again on the same skill replaces it.",
    tidy: "Make one of this tidy's changes, at most five, each skill once: merge skills that cover the same kind of work (the survivor gets the merged text, the others are archived as merged into it), rewrite, move or archive one. They are saved together when the tidy ends well; calling again on the same skill replaces its change."
  });
  expect(described(AGENT_ACTIONS)).toEqual({
    action: "What to do: patch, rewrite, revert, archive, restore, move.",
    name: "The skill's name, as in the skills list. For create: the new skill's name, short, lowercase, with hyphens.",
    revision: "The revision you read (`skill` or `read_skill` shows it). Needed to change a skill you read.",
    old_text: "For patch: the passage to replace, copied exactly from the skill as you read it. It must occur once.",
    new_text: "For patch: the replacement for `old_text`; empty deletes it.",
    body: "For create, rewrite and merge: the skill's whole text. For restore: a new text, only if it needs one.",
    description: "For create, and when the kind of work a skill covers changed: one sentence on the kind of work it is for.",
    to_revision: "For revert: the revision to go back to. Leave out to undo the last change.",
    scope: "For create and move: global, or the project's name.",
    reason: "One sentence: why — what was wrong and how you know, what the work showed, or what the user asked."
  });
  expect(described(TIDY_ACTIONS).action).toBe("What to do: merge, rewrite, move, archive.");
  expect(described(TIDY_ACTIONS).absorbed).toBe("For merge: the skills merged into this one, each with the revision you read.");
  expect(described(REVIEW_ACTIONS).action).toBe("What to do: create, patch, rewrite, restore.");
});
