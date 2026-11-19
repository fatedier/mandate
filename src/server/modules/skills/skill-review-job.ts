import * as os from "node:os";
import type { AgentMessage, AgentStore, AgentThread } from "../agent/agent-store.js";
import type { AgentScope } from "../agent/tool-scope.js";
import type { BackgroundTaskStore } from "../agent/background-task-store.js";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { NotifyRequest } from "../notifications/notification-service.js";
import { resolveDataDir } from "../../platform/fs/data-dir.js";
import { logError } from "../../platform/logger.js";
import { errorText } from "../../../shared/error-text.js";
import type { LearnedSkill, LearnedSkillStore, SkillReviewRun } from "./learned-skill-store.js";
import { learnedSkillWhereText } from "./learned-skill-lines.js";
import { skillChangeNotice } from "./learned-skill-notices.js";
import { renderReviewOpening, type ReviewOpeningInput } from "./skill-review-input.js";
import { buildReviewTools, outcomeOf, type ReviewState } from "./skill-review-tools.js";
import { runReview, type ReviewCandidate, type ReviewRunInput } from "./skill-review-run.js";
import { skillPrompt } from "./skill-authoring-standard.js";
import systemPromptPath from "./prompts/skill-review-system.md" with { type: "file" };

const DAY_MS = 86_400_000;

export const REVIEW_SKIPPED = {
  gone: "The conversation is gone.",
  empty: "The conversation has no messages in the range."
} as const;

export interface SkillReviewJobDeps {
  store: LearnedSkillStore;
  agentStore: Pick<AgentStore, "getThreadById" | "getMessagesPage">;
  workersStore: Pick<WorkersStore, "getById" | "listAllActive">;
  projectsStore: Pick<ProjectsStore, "getById" | "listActive">;
  backgroundTasks: Pick<BackgroundTaskStore, "childThreadIdsOf" | "getByChildThread">;
  /** A manager thread's projects: those of the workers it owns or owned. */
  projectIdsOfThread: (threadId: string) => readonly string[];
  fileSkillNames: () => ReadonlySet<string>;
  /** What a review looks up, reading only (reviewLookupTools), built at each run. */
  lookupTools: () => readonly ToolDefinition[];
  /** The Skill review route's models in order, read at each run. */
  candidates: () => readonly ReviewCandidate[];
  notify?: (request: NotifyRequest) => void;
  limits?: ReviewRunInput["limits"];
  /** The tidy of all learned skills: run when it is due and no review is. */
  tidy?: { due(): boolean; run(): Promise<void> };
  llmTimeout?: ReviewRunInput["llmTimeout"];
  streamIdleTimeoutMs?: number;
  now?: () => Date;
}

export interface SkillReviewJob {
  /** Runs the oldest queued review that is due, else a due tidy, unless one runs. */
  tick(): Promise<void>;
  /** A tick soon, outside whatever asked (a request, a wake). */
  kick(): void;
}

/**
 * The background skill review: one at a time for all of Mandate, oldest
 * request first, a thread at most once a day (the store's queue: what it
 * finishes meanwhile joins one run). A run reads the requested range of a conversation and may
 * make one change to a learned skill, written when the run ends well; the
 * conversation's review mark then moves to the range's end and the owner
 * is told of a change. A failed run saves nothing and leaves the mark.
 */
export function createSkillReviewJob(deps: SkillReviewJobDeps): SkillReviewJob {
  const now = () => deps.now?.() ?? new Date();
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    const run = deps.store.nextQueuedReview();
    if (!run) {
      if (!deps.tidy?.due()) return;
      running = true;
      try {
        await deps.tidy.run();
      } catch (error) {
        // The run is recorded failed; it is tried again when it is due.
        logError("skill tidy failed", error);
      } finally {
        running = false;
      }
      return;
    }
    running = true;
    try {
      await review(run);
    } catch (error) {
      logError(`skill review ${run.id} failed`, error);
      try {
        deps.store.finishReview(run.id, { status: "failed", error: errorText(error) });
      } catch (inner) {
        logError(`skill review ${run.id}: its end could not be written`, inner);
      }
    } finally {
      running = false;
    }
    // The next waiting one, outside this run. One left queued (no model to
    // run it on) waits for the next tick instead.
    if (deps.store.review(run.id)?.status !== "queued" && deps.store.nextQueuedReview()) kick();
  };

  const kick = () => {
    const timer = setTimeout(() => {
      tick().catch((error) => logError("skill review: the queue could not be read", error));
    }, 0);
    timer.unref?.();
  };

  const review = async (run: SkillReviewRun): Promise<void> => {
    const target = deps.agentStore.getThreadById(run.threadId);
    if (!target) {
      deps.store.finishReview(run.id, { status: "skipped", reason: REVIEW_SKIPPED.gone });
      return;
    }
    const messages = rangeOf(target.id, run.fromSeq, run.toSeq);
    if (messages.length === 0) {
      deps.store.finishReview(run.id, { status: "skipped", reason: REVIEW_SKIPPED.empty });
      return;
    }
    const candidates = deps.candidates();
    if (candidates.length === 0) return;
    deps.store.startReview(run.id, candidates[0]!.provider ?? null, candidates[0]!.modelName ?? null);

    const projectIds = projectsInReach(target, messages);
    const projects = projectIds.flatMap((id) => {
      const project = deps.projectsStore.getById(id);
      return project ? [{ id: project.id, name: project.name }] : [];
    });
    const projectName = (id: string) => deps.projectsStore.getById(id)?.name ?? null;
    const skills = [
      ...deps.store.list({ where: { scope: "user" } }),
      ...projects.flatMap((p) => deps.store.list({ where: { scope: "project", projectId: p.id } }))
    ];
    const since = new Date(now().getTime() - 90 * DAY_MS).toISOString();
    const subagentThreadIds = deps.backgroundTasks.childThreadIdsOf([target.id]);
    const opening = renderReviewOpening({
      conversation: conversationOf(target, projects.map((p) => p.name)),
      requestedBy: requesterOf(run.requestedBy),
      focus: run.focus ?? "",
      fromSeq: run.fromSeq,
      toSeq: run.toSeq,
      messages,
      subagents: subagentThreadIds.map((threadId) => ({ threadId, title: deps.backgroundTasks.getByChildThread(threadId)?.title ?? threadId })),
      skills: skills.map((s) => ({
        name: s.name, description: s.description, where: learnedSkillWhereText(s, projectName), status: s.status, revision: s.revision,
        uses90: deps.store.usesSince(s.id, since), lastUsedAt: s.lastUsedAt
      }))
    });
    const state: ReviewState = { readRevisions: new Map(), staged: null, finished: null };
    const tools = buildReviewTools({
      store: deps.store,
      fileSkillNames: deps.fileSkillNames,
      agentStore: deps.agentStore,
      threadId: target.id,
      subagentThreadIds,
      projects,
      projectName,
      // Looked up as the agent that asked for the review (the reviewed
      // conversation when nobody did): the run is no thread, and the history
      // answers a caller only as far as that caller may read.
      lookupTools: asCaller(deps.lookupTools(), run.requestedBy ?? target.id),
      readScope: readScopeOf(target)
    }, state);
    const end = await runReview({
      runId: run.id,
      threadId: target.id,
      candidates,
      system: skillPrompt(systemPromptPath),
      opening,
      tools,
      state,
      ...(deps.limits ? { limits: deps.limits } : {}),
      ...(deps.llmTimeout ? { llmTimeout: deps.llmTimeout } : {}),
      ...(deps.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: deps.streamIdleTimeoutMs } : {})
    });
    if (!end.ok) {
      deps.store.finishReview(run.id, { status: "failed", error: end.error });
      return;
    }
    const staged = state.staged;
    const by = { by: "review" as const, threadId: target.id, runId: run.id };
    const outcome = outcomeOf(state);
    // The change, the run's end and the mark are one write: a skill is never
    // saved by a run recorded failed, nor a run recorded done without it.
    const ended = deps.store.transaction((): { changed: LearnedSkill | null } | { refused: string } => {
      let changed: LearnedSkill | null = null;
      if (staged) {
        const written = staged.kind === "create"
          ? deps.store.create({ name: staged.name, description: staged.description, body: staged.body, where: staged.where, ...by, reason: staged.reason })
          : deps.store.change(staged.skillId, staged.baseRevision, { ...staged.fields, ...by, reason: staged.reason });
        if (!written.ok) return { refused: written.message };
        changed = written.skill;
      }
      deps.store.finishReview(run.id, { status: "succeeded", outcome, skillId: changed?.id ?? null, revision: changed?.revision ?? null, reason: end.reason });
      deps.store.setReviewMark(target.id, run.toSeq);
      return { changed };
    });
    if ("refused" in ended) {
      // Changed or taken meanwhile: nothing is overwritten, and the work
      // stays to be reviewed again.
      deps.store.finishReview(run.id, { status: "failed", error: ended.refused, reason: end.reason });
      return;
    }
    const changed = ended.changed;
    if (changed && staged) {
      deps.notify?.(skillChangeNotice(outcome === "created" ? "learned" : outcome === "restored" ? "restored" : "updated", changed, staged.reason));
    }
  };

  /** The range's messages in order, read a page at a time from the end. */
  const rangeOf = (threadId: string, fromSeq: number, toSeq: number): AgentMessage[] => {
    const out: AgentMessage[] = [];
    let before = toSeq + 1;
    for (;;) {
      const page = deps.agentStore.getMessagesPage(threadId, { fromSeq, beforeSeq: before, limit: 500 });
      out.push(...page);
      if (page.length < 500) break;
      before = page.at(-1)!.seq;
    }
    return out.reverse();
  };

  /** How far the reviewed agent could read, as its own tools reach: a
   *  worker its project's and worktree's files, scratch and Mandate's data
   *  (where its spooled results are); a manager or the personal agent any
   *  path. A worker whose project is gone keeps the rest. */
  const readScopeOf = (target: AgentThread): AgentScope => {
    if (target.scope === "worker") {
      const worker = target.scopeId ? deps.workersStore.getById(target.scopeId) : null;
      const project = worker ? deps.projectsStore.getById(worker.projectId) : null;
      return { kind: "worker", worker: { workingDir: worker?.worktreePath ?? null }, project: { workingDir: project?.workingDir ?? resolveDataDir() } };
    }
    return { kind: "manager", managerDir: os.homedir(), projectWorkingDirs: [] };
  };

  /** The projects a review may write to besides global: a worker's, a
   *  manager's workers', or those the personal agent's range touched. */
  const projectsInReach = (target: AgentThread, messages: readonly AgentMessage[]): string[] => {
    if (target.scope === "worker") {
      const worker = target.scopeId ? deps.workersStore.getById(target.scopeId) : null;
      return worker ? [worker.projectId] : [];
    }
    if (target.scope === "manager") return [...deps.projectIdsOfThread(target.id)];
    return projectsTouched(messages);
  };

  /** Active projects the range's tool calls named, by name or id, or through a worker's. */
  const projectsTouched = (messages: readonly AgentMessage[]): string[] => {
    const projects = deps.projectsStore.listActive();
    const workers = deps.workersStore.listAllActive();
    const found = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        for (const p of projects) if (p.id === value || p.name === value) found.add(p.id);
        for (const w of workers) if (w.id === value || w.name === value) found.add(w.projectId);
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    for (const m of messages) if (m.content.type === "assistant") for (const call of m.content.toolCalls ?? []) visit(call.args);
    return [...found];
  };

  const conversationOf = (target: AgentThread, projectNames: string[]): ReviewOpeningInput["conversation"] => {
    if (target.scope === "worker") {
      const worker = target.scopeId ? deps.workersStore.getById(target.scopeId) : null;
      return { threadId: target.id, title: worker?.name ?? target.title ?? target.id, kind: "worker", ...(worker ? { workerName: worker.name } : {}), projectNames };
    }
    if (target.scope === "manager") return { threadId: target.id, title: target.title ?? target.id, kind: "manager", projectNames };
    return { threadId: target.id, title: "the personal agent", kind: "personal", projectNames };
  };

  const requesterOf = (threadId: string | null): string => {
    const thread = threadId ? deps.agentStore.getThreadById(threadId) : null;
    if (!thread) return "an agent";
    if (thread.scope === "personal") return "the personal agent";
    return thread.title ? `the manager of ${thread.title}` : "a manager";
  };

  return { tick, kick };
}

/** The tools with `threadId` as their caller, whatever thread runs them. */
function asCaller(tools: readonly ToolDefinition[], threadId: string): ToolDefinition[] {
  return tools.map((tool) => ({ ...tool, handler: (args, ctx) => tool.handler(args as never, { ...ctx, threadId }) }));
}
