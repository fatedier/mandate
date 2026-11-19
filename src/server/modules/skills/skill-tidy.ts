import type { TimeoutConfiguration, ToolSet } from "ai";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { NotifyRequest } from "../notifications/notification-service.js";
import { newId } from "../../platform/ids.js";
import { errorText } from "../../../shared/error-text.js";
import type { ChangeFields, LearnedSkill, LearnedSkillStore } from "./learned-skill-store.js";
import { learnedSkillWhereText } from "./learned-skill-lines.js";
import { skillChangeNotice, type SkillNoticeKind } from "./learned-skill-notices.js";
import { runReview, type ReviewCandidate, type ReviewRunInput } from "./skill-review-run.js";
import { renderTidyOpening, type TidyLine } from "./skill-tidy-input.js";
import { buildTidyTools, type TidyChange, type TidyState } from "./skill-tidy-tools.js";
import { skillPrompt } from "./skill-authoring-standard.js";
import systemPromptPath from "./prompts/skill-tidy-system.md" with { type: "file" };

const DAY_MS = 86_400_000;

export interface SkillTidyDeps {
  store: LearnedSkillStore;
  /** The Skill review route's models in order, read at each run. */
  candidates: () => readonly ReviewCandidate[];
  /** Memory, read only, built at each run. */
  lookupTools: () => readonly ToolDefinition[];
  /** The active projects a skill may move to. */
  projects: () => ReadonlyArray<{ id: string; name: string }>;
  projectName: (id: string) => string | null;
  notify?: (request: NotifyRequest) => void;
  limits?: ReviewRunInput["limits"];
  llmTimeout?: TimeoutConfiguration<ToolSet>;
  streamIdleTimeoutMs?: number;
  now?: () => Date;
}

/** A change that no longer applies: the whole tidy is saved or none of it. */
class Refused extends Error {}

/**
 * The tidy of all learned skills (the store says when one is due): one run
 * over every skill on the Skill review route, at most TIDY_MAX_CHANGES
 * changes, written together when it ends well — each a revision by the tidy
 * with its reason, the owner told of each — or not at all.
 */
export function createSkillTidy(deps: SkillTidyDeps): { run(): Promise<void> } {
  const now = () => deps.now?.() ?? new Date();
  return {
    async run() {
      const candidates = deps.candidates();
      if (candidates.length === 0) return;
      const run = deps.store.startTidy(candidates[0]!.provider ?? null, candidates[0]!.modelName ?? null);
      try {
        const state: TidyState = { readRevisions: new Map(), staged: [], finished: null };
        const tools = buildTidyTools({ store: deps.store, projects: deps.projects, projectName: deps.projectName, lookupTools: deps.lookupTools() }, state);
        const end = await runReview({
          runId: run.id,
          threadId: run.id,
          record: { purpose: "skill_tidy", scopeType: "skill_tidy", scopeId: run.id },
          candidates,
          system: skillPrompt(systemPromptPath),
          opening: opening(),
          tools,
          state,
          ...(deps.limits ? { limits: deps.limits } : {}),
          ...(deps.llmTimeout ? { llmTimeout: deps.llmTimeout } : {}),
          ...(deps.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: deps.streamIdleTimeoutMs } : {})
        });
        if (!end.ok) {
          deps.store.finishTidy(run.id, { status: "failed", error: end.error });
          return;
        }
        let told: Array<{ kind: SkillNoticeKind; skill: LearnedSkill; reason: string }>;
        try {
          told = deps.store.transaction(() => state.staged.flatMap((change) => apply(change, run.id)));
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
          deps.store.finishTidy(run.id, { status: "failed", error: error.message, reason: end.reason });
          return;
        }
        deps.store.finishTidy(run.id, { status: "succeeded", changes: state.staged.length, reason: end.reason, changed: told.map((t) => ({ skillId: t.skill.id, revision: t.skill.revision })) });
        for (const t of told) deps.notify?.(skillChangeNotice(t.kind, t.skill, t.reason));
      } catch (error) {
        deps.store.finishTidy(run.id, { status: "failed", error: errorText(error) });
        throw error;
      }
    }
  };

  function opening(): string {
    const at = now().getTime();
    const since = (days: number) => new Date(at - days * DAY_MS).toISOString();
    const lineOf = (s: LearnedSkill): TidyLine => ({
      name: s.name, description: s.description, where: learnedSkillWhereText(s, deps.projectName), revision: s.revision,
      uses30: deps.store.usesSince(s.id, since(30)), uses90: deps.store.usesSince(s.id, since(90)),
      lastUsedAt: s.lastUsedAt, lastChangedAt: s.updatedAt, lines: s.body.split("\n").length
    });
    const all = deps.store.list();
    return renderTidyOpening({ available: all.filter((s) => s.status === "available").map(lineOf), archived: all.filter((s) => s.status === "archived").map(lineOf) });
  }

  /** One staged change written, by the tidy, under one change id. */
  function apply(change: TidyChange, runId: string): Array<{ kind: SkillNoticeKind; skill: LearnedSkill; reason: string }> {
    const by = { by: "tidy" as const, runId, reason: change.reason, changeId: newId("chg") };
    const write = (skillId: string, baseRevision: number, fields: Omit<ChangeFields, "by" | "runId" | "reason" | "changeId">): LearnedSkill => {
      const done = deps.store.change(skillId, baseRevision, { ...fields, ...by });
      if (!done.ok) throw new Refused(done.message);
      return done.skill;
    };
    const described = (description: string | undefined) => (description ? { description } : {});
    switch (change.kind) {
      case "merge": {
        const survivor = write(change.survivor.skillId, change.survivor.baseRevision, { body: change.body, ...described(change.description), change: "merge" });
        const gone = change.absorbed.map((a) => write(a.skillId, a.baseRevision, { status: "archived", archivedReason: change.reason, absorbedInto: survivor.id, change: "merge" }));
        return [{ kind: "updated", skill: survivor, reason: change.reason }, ...gone.map((skill) => ({ kind: "archived" as const, skill, reason: change.reason }))];
      }
      case "rewrite":
        return [{ kind: "updated", skill: write(change.skillId, change.baseRevision, { body: change.body, ...described(change.description), change: "rewrite" }), reason: change.reason }];
      case "move":
        return [{ kind: "updated", skill: write(change.skillId, change.baseRevision, { where: change.where, change: "move" }), reason: change.reason }];
      case "archive":
        return [{ kind: "archived", skill: write(change.skillId, change.baseRevision, { status: "archived", archivedReason: change.reason, change: "archive" }), reason: change.reason }];
    }
  }
}
