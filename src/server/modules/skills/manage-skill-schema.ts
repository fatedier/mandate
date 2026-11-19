import { z } from "zod";

/** The one tool that changes learned skills, for every writer: the agents
 *  in their conversations, the review and the tidy. Each is offered its own
 *  actions and only the parameters those use, in the same words. */
export const MANAGE_SKILL_TOOL_NAME = "manage_skill";

export type ManageSkillAction = "create" | "patch" | "rewrite" | "merge" | "revert" | "archive" | "restore" | "move";

export const AGENT_ACTIONS = ["patch", "rewrite", "revert", "archive", "restore", "move"] as const satisfies readonly ManageSkillAction[];
export const REVIEW_ACTIONS = ["create", "patch", "rewrite", "restore"] as const satisfies readonly ManageSkillAction[];
export const TIDY_ACTIONS = ["merge", "rewrite", "move", "archive"] as const satisfies readonly ManageSkillAction[];

export const MANAGE_SKILL_DESCRIPTIONS = {
  agent: "Change a learned skill: patch or rewrite its text (a skill you loaded in this conversation), revert a change, archive, restore, or move it. It applies at once and the user is told.",
  review: "Make this review's one change to the learned skills: create, patch, rewrite or restore a skill. It is saved when the review ends well; calling again on the same skill replaces it.",
  tidy: "Make one of this tidy's changes, at most five, each skill once: merge skills that cover the same kind of work (the survivor gets the merged text, the others are archived as merged into it), rewrite, move or archive one. They are saved together when the tidy ends well; calling again on the same skill replaces its change."
} as const;

const FIELDS = {
  revision: z.number().int().optional().describe("The revision you read (`skill` or `read_skill` shows it). Needed to change a skill you read."),
  old_text: z.string().optional().describe("For patch: the passage to replace, copied exactly from the skill as you read it. It must occur once."),
  new_text: z.string().optional().describe("For patch: the replacement for `old_text`; empty deletes it."),
  body: z.string().optional().describe("For create, rewrite and merge: the skill's whole text. For restore: a new text, only if it needs one."),
  description: z.string().optional().describe("For create, and when the kind of work a skill covers changed: one sentence on the kind of work it is for."),
  absorbed: z.array(z.object({
    name: z.string().min(1).describe("The skill's name, as in the skills list."),
    revision: z.number().int().describe("The revision you read with `read_skill`.")
  })).optional().describe("For merge: the skills merged into this one, each with the revision you read."),
  to_revision: z.number().int().optional().describe("For revert: the revision to go back to. Leave out to undo the last change."),
  scope: z.string().optional().describe("For create and move: global, or the project's name.")
};
type Field = keyof typeof FIELDS;

/** What each action reads, besides `name`, `action` and `reason`. */
const USES: Record<ManageSkillAction, readonly Field[]> = {
  create: ["description", "body", "scope"],
  patch: ["revision", "old_text", "new_text"],
  rewrite: ["revision", "body", "description"],
  merge: ["revision", "absorbed", "body", "description"],
  revert: ["to_revision"],
  archive: ["revision"],
  restore: ["revision", "body", "description"],
  move: ["revision", "scope"]
};

/** One writer's parameters: its actions, and the fields they use. A field
 *  another action takes is optional and checked by the handler. */
export function manageSkillParams<const A extends readonly [ManageSkillAction, ...ManageSkillAction[]]>(actions: A) {
  const used = new Set(actions.flatMap((action) => USES[action]));
  const fields = Object.fromEntries((Object.keys(FIELDS) as Field[]).filter((field) => used.has(field)).map((field) => [field, FIELDS[field]]));
  return z.object({
    name: z.string().min(1).describe("The skill's name, as in the skills list. For create: the new skill's name, short, lowercase, with hyphens."),
    action: z.enum(actions).describe(`What to do: ${actions.join(", ")}.`),
    ...(fields as Partial<typeof FIELDS>),
    reason: z.string().min(1).describe("One sentence: why — what was wrong and how you know, what the work showed, or what the user asked.")
  });
}

/** Each writer's parameters, as the tool-schema catalog holds them. */
export const AGENT_MANAGE_SKILL_PARAMS = manageSkillParams(AGENT_ACTIONS);
export const REVIEW_MANAGE_SKILL_PARAMS = manageSkillParams(REVIEW_ACTIONS);
export const TIDY_MANAGE_SKILL_PARAMS = manageSkillParams(TIDY_ACTIONS);

/** What every writer's handler reads; a field its schema leaves out is never set. */
export interface ManageSkillArgs {
  name: string;
  action: ManageSkillAction;
  revision?: number | undefined;
  old_text?: string | undefined;
  new_text?: string | undefined;
  body?: string | undefined;
  description?: string | undefined;
  absorbed?: Array<{ name: string; revision: number }> | undefined;
  to_revision?: number | undefined;
  scope?: string | undefined;
  reason: string;
}
