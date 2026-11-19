import type { z } from "zod";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { SkillRegistry } from "./skill-registry.js";
import type { LearnedSkill, ChangeResult } from "./learned-skill-store.js";
import { learnedSkillWhereText } from "./learned-skill-lines.js";
import { skillChangeNotice, type SkillNoticeKind } from "./learned-skill-notices.js";
import { AGENT_MANAGE_SKILL_PARAMS, MANAGE_SKILL_DESCRIPTIONS, MANAGE_SKILL_TOOL_NAME, type AGENT_ACTIONS, type ManageSkillArgs } from "./manage-skill-schema.js";
import { skillWriteAdvice } from "./skill-write-advice.js";

type Params = z.infer<typeof AGENT_MANAGE_SKILL_PARAMS>;
type Result = { name: string; revision: number; status: string; scope: string; advice?: string[] } | { error: string };

/** Every writer's refusals, in the words the agents' tool first had. */
export const MANAGE_SKILL_ERRORS = {
  notLoaded: "Load the skill with `skill` first; you can only edit a skill you loaded in this conversation.",
  stale: "The skill changed since you loaded it. Load it again.",
  passage: "The passage was not found in the skill, or it occurs more than once.",
  archived: "This skill is archived: restore it first.",
  noProject: (scope: string) => `There is no project named ${scope}.`,
  file: "This skill is a file the user maintains. Tell the user what should change.",
  needs: (field: string) => `Give \`${field}\`.`
} as const;

/** A blank the model filled in for a field it had no value for. */
export const given = (value: string | undefined): string | undefined => (value !== undefined && value.trim() !== "" ? value : undefined);

/** How many times `part` occurs in `text`, counting overlaps. */
export function occurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + 1)) count += 1;
  return count;
}

/** A patch's text: `old_text` replaced once by `new_text`; an empty
 *  replacement deletes the passage, a missing one is a mistake. */
export function patched(body: string, oldText: string | undefined, newText: string | undefined): { body: string } | { error: string } {
  const passage = given(oldText);
  if (passage === undefined) return { error: MANAGE_SKILL_ERRORS.needs("old_text") };
  if (newText === undefined) return { error: MANAGE_SKILL_ERRORS.needs("new_text") };
  if (occurrences(body, passage) !== 1) return { error: MANAGE_SKILL_ERRORS.passage };
  return { body: body.replace(passage, () => newText) };
}

/**
 * `manage_skill`, for the personal agent and managers: patch or rewrite a
 * learned skill it loaded, revert it, archive, restore or move it. Every
 * change is a revision by the agent with its reason, and a notice to the
 * owner; a text change is answered with skillWriteAdvice. A worker reports a
 * wrong step instead.
 */
export function buildManageSkillTool(registry: SkillRegistry): ToolDefinition<Params, Result> {
  return {
    name: MANAGE_SKILL_TOOL_NAME,
    description: MANAGE_SKILL_DESCRIPTIONS.agent,
    parameters: AGENT_MANAGE_SKILL_PARAMS,
    handler: async (input, ctx) => {
      // Read as every writer reads it: a field this schema leaves out is never set.
      const args = input as ManageSkillArgs & { action: (typeof AGENT_ACTIONS)[number] };
      const source = registry.learnedSource;
      if (registry.listAll().some((entry) => entry.name === args.name)) return { error: MANAGE_SKILL_ERRORS.file };
      const skill = source?.store.getByName(args.name) ?? null;
      if (!source || !skill) return { error: `Unknown skill: ${args.name}` };
      const by = { by: "agent" as const, threadId: ctx.threadId, reason: args.reason };
      let result: ChangeResult;
      let kind: SkillNoticeKind = "updated";
      // What a text change left the skill reading, for its advice.
      let written: string | null = null;
      switch (args.action) {
        case "patch":
        case "rewrite": {
          if (skill.status === "archived") return { error: MANAGE_SKILL_ERRORS.archived };
          const loaded = registry.loadedRevision(ctx.threadId, skill.id);
          if (loaded === null) return { error: MANAGE_SKILL_ERRORS.notLoaded };
          if (loaded !== skill.revision || (args.revision !== undefined && args.revision !== skill.revision)) return { error: MANAGE_SKILL_ERRORS.stale };
          let next: string;
          if (args.action === "patch") {
            const out = patched(skill.body, args.old_text, args.new_text);
            if ("error" in out) return out;
            next = out.body;
          } else {
            const body = given(args.body);
            if (body === undefined) return { error: MANAGE_SKILL_ERRORS.needs("body") };
            next = body;
          }
          result = source.store.change(skill.id, skill.revision, { ...by, body: next, description: given(args.description), change: args.action });
          written = next;
          // It wrote what the skill now says: a further change needs no reload.
          if (result.ok) registry.noteLoaded(ctx.threadId, result.skill.id, result.skill.revision);
          break;
        }
        case "revert": {
          const toRevision = args.to_revision !== undefined && args.to_revision > 0 ? args.to_revision : undefined;
          result = source.store.revert(skill.id, { ...by, toRevision });
          if (result.ok && result.skill.status !== skill.status) kind = result.skill.status === "archived" ? "archived" : "restored";
          break;
        }
        case "archive":
          if (skill.status === "archived") return answer(skill, source.projectName);
          result = source.store.change(skill.id, skill.revision, { ...by, status: "archived", archivedReason: args.reason, change: "archive" });
          kind = "archived";
          break;
        case "restore": {
          if (skill.status === "available") return answer(skill, source.projectName);
          const body = given(args.body);
          // A new text with it is a text change: of the revision this conversation holds.
          if (body !== undefined) {
            const loaded = registry.loadedRevision(ctx.threadId, skill.id);
            if (loaded === null) return { error: MANAGE_SKILL_ERRORS.notLoaded };
            if (loaded !== skill.revision || (args.revision !== undefined && args.revision !== skill.revision)) return { error: MANAGE_SKILL_ERRORS.stale };
          }
          result = source.store.change(skill.id, skill.revision, { ...by, status: "available", change: "restore", ...(body !== undefined ? { body } : {}), description: given(args.description) });
          if (body !== undefined) written = body;
          kind = "restored";
          break;
        }
        case "move": {
          const scope = given(args.scope)?.trim() ?? "";
          const where = scope.toLowerCase() === "global" ? { scope: "user" as const } : (() => {
            const projectId = source.projectIdByName(scope);
            return projectId ? { scope: "project" as const, projectId } : null;
          })();
          if (!where) return { error: MANAGE_SKILL_ERRORS.noProject(scope) };
          result = source.store.change(skill.id, skill.revision, { ...by, where, change: "move" });
          break;
        }
      }
      if (!result.ok) return { error: result.message };
      // Any other change leaves what the thread last read where it was: a
      // text change after it loads the skill again.
      source.notify?.(skillChangeNotice(kind, result.skill, args.reason));
      const advice = written === null ? [] : skillWriteAdvice(skill.body, written, "saved");
      return { ...answer(result.skill, source.projectName), ...(advice.length > 0 ? { advice } : {}) };
    }
  };
}

function answer(skill: LearnedSkill, projectName: (id: string) => string | null): Exclude<Result, { error: string }> {
  return { name: skill.name, revision: skill.revision, status: skill.status, scope: learnedSkillWhereText(skill, projectName) };
}
