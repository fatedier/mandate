import type { z } from "zod";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { AgentScope } from "../agent/tool-scope.js";
import { readFileTool } from "../agent/tools/read-file.js";
import type { ChangeFields, LearnedSkill, LearnedSkillStore, LearnedSkillWhere } from "./learned-skill-store.js";
import { SKILL_MESSAGES } from "./learned-skill-store.js";
import { learnedSkillWhereText } from "./learned-skill-lines.js";
import { MANAGE_SKILL_ERRORS, given, patched } from "./manage-skill-tool.js";
import { MANAGE_SKILL_DESCRIPTIONS, MANAGE_SKILL_TOOL_NAME, REVIEW_MANAGE_SKILL_PARAMS, type ManageSkillArgs, type REVIEW_ACTIONS } from "./manage-skill-schema.js";
import { skillWriteAdvice } from "./skill-write-advice.js";
import { renderTranscript, TRANSCRIPT_PAGE_CHARS, TRANSCRIPT_RESULT_CHARS } from "./skill-review-input.js";
import { FINISH_SCHEMA, READ_SKILL_SCHEMA, READ_TRANSCRIPT_SCHEMA } from "./skill-review-schema.js";

/** The most messages one `read_transcript` call reads. */
const TRANSCRIPT_MAX_MESSAGES = 500;

export type ReviewOutcome = "none" | "created" | "changed" | "restored";

/** The review's one change, written when the run ends well: a run that
 *  fails (a limit, the model) saves nothing. */
export type StagedChange =
  | { kind: "create"; name: string; description: string; body: string; where: LearnedSkillWhere; reason: string }
  | { kind: "change"; skillId: string; baseRevision: number; fields: Omit<ChangeFields, "by" | "threadId" | "runId" | "reason">; outcome: "changed" | "restored"; reason: string };

export interface ReviewState {
  /** The revision of each skill read with `read_skill` in this run. */
  readRevisions: Map<string, number>;
  staged: StagedChange | null;
  finished: { reason: string } | null;
}

export const REVIEW_TOOL_ERRORS = {
  notPart: "That thread is not part of this work.",
  noMessages: "There are no messages there.",
  continues: (seq: number) => `Continues at message ${seq}.`,
  outOfReach: "This skill is outside this review's scopes.",
  scope: "Give the scope: global, or the project's name.",
  noProject: (scope: string) => `There is no project named ${scope} in this review's scopes.`,
  oneChange: "You have made this review's one change.",
  notRead: "Read the skill with `read_skill` in this review first.",
  stale: "The skill changed since you read it. Read it again.",
  notArchived: "This skill is not archived.",
  needs: (field: string) => `Give \`${field}\`.`
} as const;

export interface ReviewToolsDeps {
  store: Pick<LearnedSkillStore, "getByName" | "validate">;
  fileSkillNames: () => ReadonlySet<string>;
  agentStore: Pick<AgentStore, "getMessagesPage">;
  /** The reviewed conversation and its subagents' threads. */
  threadId: string;
  subagentThreadIds: readonly string[];
  /** The projects the review may write to, besides global. */
  projects: ReadonlyArray<{ id: string; name: string }>;
  projectName: (id: string) => string | null;
  /** What it looks up, reading only: memories and the chat history
   *  (reviewLookupTools). */
  lookupTools: readonly ToolDefinition[];
  /** How far the reviewed agent could read: `read` reads as far, no farther. */
  readScope: AgentScope;
}

/** A staged change's answer, with what its text is told (skillWriteAdvice). */
const withAdvice = (answer: Record<string, unknown>, advice: string[]) => (advice.length > 0 ? { ...answer, advice } : answer);

/** The review's tools over one run's state. */
export function buildReviewTools(deps: ReviewToolsDeps, state: ReviewState): ToolDefinition[] {
  const inReach = (skill: LearnedSkill) => skill.where.scope === "user" || deps.projects.some((p) => skill.where.scope === "project" && p.id === skill.where.projectId);
  /** A skill the review may change, read in this run at the revision it is now. */
  const readable = (name: string): LearnedSkill | { error: string } => {
    const skill = deps.store.getByName(name);
    if (!skill) return { error: `Unknown skill: ${name}` };
    if (!inReach(skill)) return { error: REVIEW_TOOL_ERRORS.outOfReach };
    return skill;
  };
  const current = (name: string, revision: number | undefined): LearnedSkill | { error: string } => {
    const skill = readable(name);
    if ("error" in skill) return skill;
    const read = state.readRevisions.get(skill.id);
    if (read === undefined) return { error: REVIEW_TOOL_ERRORS.notRead };
    if (read !== skill.revision || (revision !== undefined && revision !== skill.revision)) return { error: REVIEW_TOOL_ERRORS.stale };
    return skill;
  };

  const readTranscript: ToolDefinition = {
    name: "read_transcript",
    description: "Read the full messages of a stretch of the reviewed work, by message number.",
    parameters: READ_TRANSCRIPT_SCHEMA,
    handler: async (input) => {
      const args = READ_TRANSCRIPT_SCHEMA.parse(input);
      const thread = given(args.thread)?.trim() ?? deps.threadId;
      if (thread !== deps.threadId && !deps.subagentThreadIds.includes(thread)) return { error: REVIEW_TOOL_ERRORS.notPart };
      const from = Math.max(1, args.from_seq);
      const to = Math.max(from, args.to_seq);
      // A message's seq is its place in its thread: the first page's rows lie
      // below from + TRANSCRIPT_MAX_MESSAGES, read newest first and turned.
      const end = Math.min(to, from + TRANSCRIPT_MAX_MESSAGES - 1);
      const messages = deps.agentStore.getMessagesPage(thread, { fromSeq: from, beforeSeq: end + 1, limit: TRANSCRIPT_MAX_MESSAGES }).reverse();
      if (messages.length === 0) return { error: end < to ? REVIEW_TOOL_ERRORS.continues(end + 1) : REVIEW_TOOL_ERRORS.noMessages };
      const page = renderTranscript(messages, { resultChars: TRANSCRIPT_RESULT_CHARS, pageChars: TRANSCRIPT_PAGE_CHARS });
      const next = page.nextSeq ?? (end < to ? end + 1 : null);
      return next === null ? page.text : `${page.text}\n${REVIEW_TOOL_ERRORS.continues(next)}`;
    }
  };

  // The agents' own read, held to the reviewed agent's reach rather than
  // the run's: the files its work saved (a result spooled to a file among
  // them) and what it worked on. Only the reach changes; its reads mark
  // the run's id, never the reviewed thread's.
  const readFile: ToolDefinition = {
    ...readFileTool,
    handler: (input, ctx) => readFileTool.handler(input as Parameters<typeof readFileTool.handler>[0], { ...ctx, scope: deps.readScope })
  };

  const readSkill: ToolDefinition = {
    name: "read_skill",
    description: "Read a learned skill's full text and revision, archived ones included.",
    parameters: READ_SKILL_SCHEMA,
    handler: async (input) => {
      const { name } = READ_SKILL_SCHEMA.parse(input);
      const skill = readable(name);
      if ("error" in skill) return skill;
      state.readRevisions.set(skill.id, skill.revision);
      return {
        name: skill.name, description: skill.description, scope: learnedSkillWhereText(skill, deps.projectName), status: skill.status,
        revision: skill.revision, ...(skill.archivedReason ? { archivedReason: skill.archivedReason } : {}), body: skill.body
      };
    }
  };

  /** Whether a staged change is for this call's skill: another call on it
   *  replaces that change. */
  const sameSkill = (staged: StagedChange, name: string): boolean => {
    if (staged.kind === "create") return staged.name === name;
    return deps.store.getByName(name)?.id === staged.skillId;
  };
  const manageSkill: ToolDefinition = {
    name: MANAGE_SKILL_TOOL_NAME,
    description: MANAGE_SKILL_DESCRIPTIONS.review,
    parameters: REVIEW_MANAGE_SKILL_PARAMS,
    handler: async (input) => {
      const args = REVIEW_MANAGE_SKILL_PARAMS.parse(input) as ManageSkillArgs & { action: (typeof REVIEW_ACTIONS)[number] };
      if (state.staged && !sameSkill(state.staged, args.name)) return { error: REVIEW_TOOL_ERRORS.oneChange };
      const description = given(args.description);
      const body = given(args.body);
      if (args.action === "create") {
        const scope = given(args.scope)?.trim();
        if (!scope) return { error: REVIEW_TOOL_ERRORS.scope };
        const project = scope.toLowerCase() === "global" ? null : deps.projects.find((p) => p.name === scope || `project ${p.name}` === scope);
        if (project === undefined) return { error: REVIEW_TOOL_ERRORS.noProject(scope) };
        if (!description) return { error: REVIEW_TOOL_ERRORS.needs("description") };
        if (!body) return { error: REVIEW_TOOL_ERRORS.needs("body") };
        const invalid = deps.store.validate({ name: args.name, description, body });
        if (invalid) return { error: invalid };
        if (deps.fileSkillNames().has(args.name)) return { error: SKILL_MESSAGES.fileName };
        if (deps.store.getByName(args.name)) return { error: SKILL_MESSAGES.nameTaken };
        state.staged = { kind: "create", name: args.name, description, body, where: project ? { scope: "project", projectId: project.id } : { scope: "user" }, reason: args.reason };
        return withAdvice({ name: args.name, action: "create" }, skillWriteAdvice(null, body, "staged"));
      }
      const skill = current(args.name, args.revision);
      if ("error" in skill) return skill;
      let fields: Extract<StagedChange, { kind: "change" }>["fields"];
      let outcome: "changed" | "restored" = "changed";
      if (args.action === "restore") {
        if (skill.status !== "archived") return { error: REVIEW_TOOL_ERRORS.notArchived };
        fields = { status: "available", change: "restore", ...(body ? { body } : {}), ...(description ? { description } : {}) };
        outcome = "restored";
      } else {
        if (skill.status === "archived") return { error: MANAGE_SKILL_ERRORS.archived };
        if (args.action === "rewrite") {
          if (!body) return { error: REVIEW_TOOL_ERRORS.needs("body") };
          fields = { body, change: "rewrite", ...(description ? { description } : {}) };
        } else {
          const out = patched(skill.body, args.old_text, args.new_text);
          if ("error" in out) return out;
          fields = { body: out.body, change: "patch" };
        }
      }
      const invalid = deps.store.validate({ ...(fields.body !== undefined ? { body: fields.body } : {}), ...(fields.description !== undefined ? { description: fields.description } : {}) });
      if (invalid) return { error: invalid };
      state.staged = { kind: "change", skillId: skill.id, baseRevision: skill.revision, fields, outcome, reason: args.reason };
      const advice = fields.body !== undefined ? skillWriteAdvice(skill.body, fields.body, "staged") : [];
      return withAdvice({ name: skill.name, action: args.action }, advice);
    }
  };

  const finish: ToolDefinition = {
    name: "finish",
    description: "End the review with its outcome and one sentence on why.",
    parameters: FINISH_SCHEMA,
    handler: async (input) => {
      const { reason } = FINISH_SCHEMA.parse(input);
      state.finished = { reason };
      return { ok: true };
    }
  };

  return [readTranscript, readFile, readSkill, ...deps.lookupTools, manageSkill, finish];
}

/** What the run did, from its staged change. */
export function outcomeOf(state: ReviewState): ReviewOutcome {
  if (!state.staged) return "none";
  return state.staged.kind === "create" ? "created" : state.staged.outcome;
}

const LOOKUPS = new Set(["memory_search", "memory_read", "chat_history_search", "chat_history_read"]);

/**
 * What a review looks up, reading only: memories and the chat history, as the
 * agents read them. Its memory search covers every project: a preference that
 * bears on a kind of work can sit in another project than the one the work
 * ran in, so the search is never narrowed to one.
 */
export function reviewLookupTools(input: { memoryTools: readonly ToolDefinition[]; historyTools: readonly ToolDefinition[] }): ToolDefinition[] {
  return [...input.memoryTools, ...input.historyTools].flatMap((tool): ToolDefinition[] => {
    if (!LOOKUPS.has(tool.name)) return [];
    if (tool.name !== "memory_search") return [tool];
    const parameters = (tool.parameters as z.ZodObject<z.ZodRawShape>).omit({ project: true });
    return [{
      ...tool,
      parameters,
      handler: (args, ctx) => {
        const { project: _ignored, ...rest } = args as Record<string, unknown>;
        return tool.handler(rest as never, ctx);
      }
    }];
  });
}
