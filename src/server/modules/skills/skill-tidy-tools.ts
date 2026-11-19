import type { ToolDefinition } from "../agent/tool-registry.js";
import type { LearnedSkill, LearnedSkillStore, LearnedSkillWhere } from "./learned-skill-store.js";
import { TIDY_MAX_CHANGES } from "./learned-skill-store.js";
import { learnedSkillWhereText } from "./learned-skill-lines.js";
import { REVIEW_TOOL_ERRORS } from "./skill-review-tools.js";
import { FINISH_TIDY_SCHEMA, READ_SKILL_SCHEMA } from "./skill-review-schema.js";
import { MANAGE_SKILL_DESCRIPTIONS, MANAGE_SKILL_TOOL_NAME, TIDY_MANAGE_SKILL_PARAMS, type ManageSkillArgs, type TIDY_ACTIONS } from "./manage-skill-schema.js";
import { MANAGE_SKILL_ERRORS, given } from "./manage-skill-tool.js";
import { skillWriteAdvice } from "./skill-write-advice.js";

/** One change of a tidy, written when the tidy ends well, each from the
 *  revision it was read at. */
export type TidyChange =
  | { kind: "merge"; survivor: { skillId: string; baseRevision: number }; absorbed: Array<{ skillId: string; baseRevision: number }>; body: string; description?: string; reason: string }
  | { kind: "rewrite"; skillId: string; baseRevision: number; body: string; description?: string; reason: string }
  | { kind: "move"; skillId: string; baseRevision: number; where: LearnedSkillWhere; reason: string }
  | { kind: "archive"; skillId: string; baseRevision: number; reason: string };

export interface TidyState {
  /** The revision of each skill read with `read_skill` in this tidy. */
  readRevisions: Map<string, number>;
  staged: TidyChange[];
  finished: { reason: string } | null;
}

export const TIDY_TOOL_ERRORS = {
  /** TIDY_MAX_CHANGES, in words. */
  limit: "You have made this tidy's five changes.",
  once: "You can change this skill once in this tidy; call again on the skill whose change you are replacing.",
  notAvailable: "Only available skills can be changed.",
  noProject: (scope: string) => `There is no project named ${scope}.`,
  unknown: (name: string) => `Unknown skill: ${name}`
} as const;

export interface TidyToolsDeps {
  store: Pick<LearnedSkillStore, "getByName" | "validate">;
  /** The active projects a skill may move to. */
  projects: () => ReadonlyArray<{ id: string; name: string }>;
  projectName: (id: string) => string | null;
  /** Memory, read only. */
  lookupTools: readonly ToolDefinition[];
}

/** The skill a change is for: another call on it replaces the change. */
const mainOf = (change: TidyChange): string => (change.kind === "merge" ? change.survivor.skillId : change.skillId);
/** Every skill a change touches. */
const skillsOf = (change: TidyChange): string[] => (change.kind === "merge" ? [change.survivor.skillId, ...change.absorbed.map((s) => s.skillId)] : [change.skillId]);

/** The tidy's tools over one run's state: every learned skill is in reach. */
export function buildTidyTools(deps: TidyToolsDeps, state: TidyState): ToolDefinition[] {
  /** A skill this tidy may change now: read here at the revision it is at,
   *  available, not touched by another change of this tidy (`others`). */
  const current = (name: string, revision: number | undefined, others: readonly TidyChange[]): LearnedSkill | { error: string } => {
    const skill = deps.store.getByName(name);
    if (!skill) return { error: TIDY_TOOL_ERRORS.unknown(name) };
    const read = state.readRevisions.get(skill.id);
    if (read === undefined) return { error: REVIEW_TOOL_ERRORS.notRead };
    if (read !== skill.revision || (revision !== undefined && revision !== skill.revision)) return { error: REVIEW_TOOL_ERRORS.stale };
    if (skill.status !== "available") return { error: TIDY_TOOL_ERRORS.notAvailable };
    if (others.some((c) => skillsOf(c).includes(skill.id))) return { error: TIDY_TOOL_ERRORS.once };
    return skill;
  };
  const invalid = (fields: { body?: string; description?: string }) => {
    const message = deps.store.validate(fields);
    return message ? { error: message } : null;
  };

  const readSkill: ToolDefinition = {
    name: "read_skill",
    description: "Read a learned skill's full text and revision, archived ones included.",
    parameters: READ_SKILL_SCHEMA,
    handler: async (input) => {
      const { name } = READ_SKILL_SCHEMA.parse(input);
      const skill = deps.store.getByName(name);
      if (!skill) return { error: TIDY_TOOL_ERRORS.unknown(name) };
      state.readRevisions.set(skill.id, skill.revision);
      return {
        name: skill.name, description: skill.description, scope: learnedSkillWhereText(skill, deps.projectName), status: skill.status,
        revision: skill.revision, ...(skill.archivedReason ? { archivedReason: skill.archivedReason } : {}), body: skill.body
      };
    }
  };

  const manageSkill: ToolDefinition = {
    name: MANAGE_SKILL_TOOL_NAME,
    description: MANAGE_SKILL_DESCRIPTIONS.tidy,
    parameters: TIDY_MANAGE_SKILL_PARAMS,
    handler: async (input) => {
      const args = TIDY_MANAGE_SKILL_PARAMS.parse(input) as ManageSkillArgs & { action: (typeof TIDY_ACTIONS)[number] };
      // The change staged for this skill, which this call replaces: it is no
      // second change, and its skills are free again.
      const target = deps.store.getByName(args.name);
      const replacing = target ? state.staged.findIndex((c) => mainOf(c) === target.id) : -1;
      const others = state.staged.filter((_, i) => i !== replacing);
      if (replacing < 0 && state.staged.length >= TIDY_MAX_CHANGES) return { error: TIDY_TOOL_ERRORS.limit };
      const skill = current(args.name, args.revision, others);
      if ("error" in skill) return skill;
      const description = given(args.description);
      let change: TidyChange;
      let answer: Record<string, unknown> = { name: skill.name, action: args.action };
      let advice: string[] = [];
      switch (args.action) {
        case "merge": {
          if (!args.absorbed?.length) return { error: MANAGE_SKILL_ERRORS.needs("absorbed") };
          const absorbed: LearnedSkill[] = [];
          for (const other of args.absorbed) {
            const into = current(other.name, other.revision, others);
            if ("error" in into) return into;
            if (into.id === skill.id || absorbed.some((s) => s.id === into.id)) return { error: TIDY_TOOL_ERRORS.once };
            absorbed.push(into);
          }
          const body = given(args.body);
          if (!body) return { error: MANAGE_SKILL_ERRORS.needs("body") };
          const bad = invalid({ body, ...(description ? { description } : {}) });
          if (bad) return bad;
          change = {
            kind: "merge", survivor: { skillId: skill.id, baseRevision: skill.revision },
            absorbed: absorbed.map((s) => ({ skillId: s.id, baseRevision: s.revision })), body, ...(description ? { description } : {}), reason: args.reason
          };
          answer = { ...answer, absorbed: absorbed.map((s) => s.name) };
          advice = skillWriteAdvice(skill.body, body, "staged");
          break;
        }
        case "rewrite": {
          const body = given(args.body);
          if (!body) return { error: MANAGE_SKILL_ERRORS.needs("body") };
          const bad = invalid({ body, ...(description ? { description } : {}) });
          if (bad) return bad;
          change = { kind: "rewrite", skillId: skill.id, baseRevision: skill.revision, body, ...(description ? { description } : {}), reason: args.reason };
          advice = skillWriteAdvice(skill.body, body, "staged");
          break;
        }
        case "move": {
          const scope = given(args.scope)?.trim();
          if (!scope) return { error: MANAGE_SKILL_ERRORS.needs("scope") };
          let where: LearnedSkillWhere;
          if (scope.toLowerCase() === "global") where = { scope: "user" };
          else {
            const project = deps.projects().find((p) => p.name === scope || `project ${p.name}` === scope);
            if (!project) return { error: TIDY_TOOL_ERRORS.noProject(scope) };
            where = { scope: "project", projectId: project.id };
          }
          change = { kind: "move", skillId: skill.id, baseRevision: skill.revision, where, reason: args.reason };
          answer = { ...answer, scope: learnedSkillWhereText({ ...skill, where }, deps.projectName) };
          break;
        }
        case "archive":
          change = { kind: "archive", skillId: skill.id, baseRevision: skill.revision, reason: args.reason };
          break;
      }
      if (replacing >= 0) state.staged[replacing] = change;
      else state.staged.push(change);
      return advice.length > 0 ? { ...answer, advice } : answer;
    }
  };

  const finish: ToolDefinition = {
    name: "finish",
    description: "End the tidy with one sentence on what you changed, or why nothing needed to change.",
    parameters: FINISH_TIDY_SCHEMA,
    handler: async (input) => {
      const { reason } = FINISH_TIDY_SCHEMA.parse(input);
      state.finished = { reason };
      return { ok: true };
    }
  };

  return [readSkill, ...deps.lookupTools, manageSkill, finish];
}
