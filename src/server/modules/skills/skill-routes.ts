import type { Hono } from "hono";
import {
  API_ROUTES,
  type LearnedSkillAuthorDto,
  type LearnedSkillDetailResponse,
  type LearnedSkillRevisionResponse,
  type LearnedSkillsResponse,
  type LearnedSkillSummaryDto,
  type LearnedSkillVersionDto,
  type SkillReviewRunsResponse,
  type SkillsResponse
} from "../../../shared/api-contracts.js";
import type { AppDeps } from "../../app/deps.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { LearnedSkill, LearnedSkillStore, LearnedSkillVersion, LearnedSkillVersionMeta, LearnedSkillWhere } from "./learned-skill-store.js";
import { revisionPatch } from "./learned-skill-patch.js";

const DAY_MS = 86_400_000;
const REVIEWS_LISTED = 50;

/** What the learned-skill reads need: the store, and names for projects and conversations. */
export interface LearnedSkillRouteDeps {
  store: LearnedSkillStore;
  projectName: (id: string) => string | null;
  activeProjects: () => Array<{ id: string; name: string }>;
  thread: (threadId: string) => Pick<LearnedSkillAuthorDto, "threadTitle" | "threadKind">;
  now?: () => Date;
}

export function learnedSkillRouteDeps(input: {
  store: LearnedSkillStore;
  projectsStore: Pick<ProjectsStore, "getById" | "listActive">;
  agentStore: Pick<AgentStore, "getThreadById">;
  workersStore: Pick<WorkersStore, "getById">;
}): LearnedSkillRouteDeps {
  return {
    store: input.store,
    projectName: (id) => input.projectsStore.getById(id)?.name ?? null,
    activeProjects: () => input.projectsStore.listActive().map((p) => ({ id: p.id, name: p.name })),
    thread: (threadId) => {
      const thread = input.agentStore.getThreadById(threadId);
      if (!thread) return { threadTitle: null, threadKind: null };
      if (thread.scope === "worker") {
        const worker = thread.scopeId ? input.workersStore.getById(thread.scopeId) : null;
        return { threadTitle: worker?.name ?? thread.title, threadKind: "worker" };
      }
      if (thread.scope === "manager") return { threadTitle: thread.title, threadKind: "manager" };
      if (thread.scope === "personal") return { threadTitle: null, threadKind: "personal" };
      return { threadTitle: thread.title, threadKind: "other" };
    }
  };
}

export function mountSkillRoutes(app: Hono, deps: Pick<AppDeps, "skills" | "learnedSkills">): void {
  app.get(API_ROUTES.skills, (c) => {
    const response = { skills: deps.skills.list() } satisfies SkillsResponse;
    return c.json(response);
  });
  app.post(API_ROUTES.skillsRefresh, async (c) => {
    await deps.skills.refresh();
    const response = { skills: deps.skills.list() } satisfies SkillsResponse;
    return c.json(response);
  });

  const learned = deps.learnedSkills;
  if (!learned) return;
  const author = (by: LearnedSkillVersion["by"], threadId: string | null): LearnedSkillAuthorDto => ({
    by, threadId, ...(threadId ? learned.thread(threadId) : { threadTitle: null, threadKind: null })
  });
  const whereFields = (where: LearnedSkillWhere) => ({
    scope: where.scope,
    projectId: where.scope === "project" ? where.projectId : null,
    projectName: where.scope === "project" ? learned.projectName(where.projectId) : null
  });
  const versionDto = (v: LearnedSkillVersionMeta): LearnedSkillVersionDto => ({
    ...author(v.by, v.threadId), revision: v.revision, change: v.change, reason: v.reason, at: v.at,
    name: v.name, description: v.description, status: v.status, ...whereFields(v.where), runId: v.runId
  });
  const summary = (skill: LearnedSkill): LearnedSkillSummaryDto => {
    const now = (learned.now?.() ?? new Date()).getTime();
    const { first, newest } = learned.store.ends(skill.id)!;
    return {
      id: skill.id, name: skill.name, description: skill.description, ...whereFields(skill.where), status: skill.status,
      archivedReason: skill.archivedReason, revision: skill.revision, createdAt: skill.createdAt, updatedAt: skill.updatedAt, lastUsedAt: skill.lastUsedAt,
      uses30: learned.store.usesSince(skill.id, new Date(now - 30 * DAY_MS).toISOString()),
      uses90: learned.store.usesSince(skill.id, new Date(now - 90 * DAY_MS).toISOString()),
      // Revision 1 is always kept: who made the skill.
      createdBy: author(first.by, first.threadId),
      lastChange: { ...author(newest.by, newest.threadId), at: newest.at, reason: newest.reason, change: newest.change }
    };
  };

  app.get(API_ROUTES.learnedSkills, (c) => {
    const scope = c.req.query("scope");
    const projectId = c.req.query("projectId");
    const status = c.req.query("status");
    if (scope !== undefined && scope !== "global" && scope !== "project") return c.json({ error: "scope is global or project" }, 400);
    if (status !== undefined && status !== "available" && status !== "archived") return c.json({ error: "status is available or archived" }, 400);
    if (scope === "project" && !projectId) return c.json({ error: "a project scope needs projectId" }, 400);
    const where: LearnedSkillWhere | undefined = scope === "global" ? { scope: "user" } : scope === "project" ? { scope: "project", projectId: projectId! } : undefined;
    const skills = learned.store.list({ ...(where ? { where } : {}), ...(status ? { status } : {}) })
      .sort((a, b) => a.name.localeCompare(b.name));
    const projects = new Map(learned.activeProjects().map((p) => [p.id, p.name]));
    for (const skill of skills) {
      if (skill.where.scope === "project" && !projects.has(skill.where.projectId)) projects.set(skill.where.projectId, learned.projectName(skill.where.projectId) ?? skill.where.projectId);
    }
    const response = {
      skills: skills.map(summary),
      projects: [...projects].map(([id, name]) => ({ id, name }))
    } satisfies LearnedSkillsResponse;
    return c.json(response);
  });

  app.get(API_ROUTES.learnedSkill, (c) => {
    const skill = learned.store.get(c.req.param("id"));
    if (!skill) return c.json({ error: "no such skill" }, 404);
    const response = { skill: { ...summary(skill), body: skill.body }, versions: learned.store.history(skill.id).map(versionDto) } satisfies LearnedSkillDetailResponse;
    return c.json(response);
  });

  app.get(API_ROUTES.learnedSkillRevision, (c) => {
    const id = c.req.param("id");
    const revision = Number(c.req.param("revision"));
    const version = Number.isInteger(revision) ? learned.store.version(id, revision) : null;
    if (!version) return c.json({ error: "no such revision" }, 404);
    // The one before that is still kept (old ones go, the first stays).
    const before = learned.store.history(id).find((v) => v.revision < revision) ?? null;
    const { body: _body, ...meta } = version;
    const response = {
      version: versionDto(meta),
      body: version.body,
      against: before?.revision ?? null,
      patch: revisionPatch(before ? learned.store.version(id, before.revision)?.body ?? "" : "", version.body)
    } satisfies LearnedSkillRevisionResponse;
    return c.json(response);
  });

  app.get(API_ROUTES.skillReviews, (c) => {
    const response = {
      runs: learned.store.recentReviews(REVIEWS_LISTED).map((run) => ({
        id: run.id, threadId: run.threadId, ...learned.thread(run.threadId), status: run.status, outcome: run.outcome,
        skillId: run.skillId, skillName: run.skillId ? learned.store.get(run.skillId)?.name ?? null : null, revision: run.revision,
        reason: run.reason, error: run.error, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt
      })),
      tidies: learned.store.recentTidies(REVIEWS_LISTED).map((run) => ({
        id: run.id, status: run.status, reason: run.reason, error: run.error,
        createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
        changed: run.changed.map((c) => ({ skillId: c.skillId, skillName: learned.store.get(c.skillId)?.name ?? null, revision: c.revision }))
      }))
    } satisfies SkillReviewRunsResponse;
    return c.json(response);
  });
}
