import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";

export type LearnedSkillWhere = { scope: "user" } | { scope: "project"; projectId: string };
export type LearnedSkillStatus = "available" | "archived";
export type LearnedSkillChange = "create" | "patch" | "rewrite" | "revert" | "archive" | "restore" | "merge" | "move";
export type LearnedSkillActor = "agent" | "review" | "tidy" | "rule";

/** The tidy's revisions are stored as 'dream': the column's check, which
 *  every data directory keeps, was written when the dream was to tidy skills;
 *  the dream never writes skills, so the value is the tidy's alone. */
const storedActor = (actor: LearnedSkillActor): string => (actor === "tidy" ? "dream" : actor);
const actorOf = (stored: string): LearnedSkillActor => (stored === "dream" ? "tidy" : stored as LearnedSkillActor);
export type SkillUseAgent = "manager" | "worker" | "personal" | "subagent";

export interface LearnedSkill {
  id: string;
  name: string;
  description: string;
  body: string;
  where: LearnedSkillWhere;
  status: LearnedSkillStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  archivedReason: string | null;
  absorbedInto: string | null;
}

export interface LearnedSkillVersion {
  skillId: string;
  revision: number;
  name: string;
  description: string;
  body: string;
  status: LearnedSkillStatus;
  where: LearnedSkillWhere;
  archivedReason: string | null;
  absorbedInto: string | null;
  change: LearnedSkillChange;
  by: LearnedSkillActor;
  threadId: string | null;
  runId: string | null;
  changeId: string;
  reason: string | null;
  at: string;
}

/** A revision without its text: what a list or a history shows. */
export type LearnedSkillVersionMeta = Omit<LearnedSkillVersion, "body">;

/** Every column of a revision but its text. */
const VERSION_META_COLUMNS = "skill_id, revision, name, description, status, scope, project_id, archived_reason, absorbed_into, change, by_actor, thread_id, run_id, change_id, reason, at";

export type ChangeError = "stale" | "invalid" | "name_taken" | "not_found" | "blocked" | "archived";
export type ChangeResult = { ok: true; skill: LearnedSkill } | { ok: false; error: ChangeError; message: string };

export interface SkillReviewRun {
  id: string;
  threadId: string;
  requestedBy: string | null;
  focus: string | null;
  fromSeq: number;
  toSeq: number;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  provider: string | null;
  model: string | null;
  outcome: "none" | "created" | "changed" | "restored" | null;
  skillId: string | null;
  revision: number | null;
  reason: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  metadata: Record<string, unknown> | null;
}

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 300;
export const SKILL_BODY_MAX_LINES = 500;
export const SKILL_BODY_MAX_CHARS = 40_000;
/** Revisions kept per skill, besides the first. */
const KEPT_REVISIONS = 30;

/** The 60-day rule: an available skill neither used nor changed for this
 *  long is archived, with this reason. */
export const UNUSED_ARCHIVE_DAYS = 60;
export const UNUSED_ARCHIVE_REASON = "No use in 60 days";

/** A thread is reviewed at most once in this long: what it finishes after a
 *  review joins one queued run, due this long after that review began. A
 *  long thread finishes many pieces of work a day, and a review of each
 *  wrote its skill up as a diary of them. */
export const REVIEW_THREAD_INTERVAL_MS = 24 * 3_600_000;

/** The tidy of all learned skills: due this long after the last began, when
 *  that one changed nothing, once a skill changed since (by anyone but a tidy). */
export const TIDY_INTERVAL_MS = 7 * 86_400_000;
/** After a tidy that changed anything (more may be left), or failed: tidies
 *  follow a day apart until one finds nothing to change. */
export const TIDY_RETRY_MS = 86_400_000;
/** The most changes one tidy makes. */
export const TIDY_MAX_CHANGES = 5;

export interface SkillTidyRun {
  id: string;
  status: "running" | "succeeded" | "failed";
  provider: string | null;
  model: string | null;
  changes: number;
  reason: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
}

interface TidyRow {
  id: string; status: SkillTidyRun["status"]; provider: string | null; model: string | null; changes: number;
  reason: string | null; error: string | null; created_at: string; started_at: string; finished_at: string | null;
}

/** The revisions a tidy's run row keeps; none for one still running or unreadable. */
function changedOf(metadata: string | null): Array<{ skillId: string; revision: number }> {
  try {
    const changed = (JSON.parse(metadata ?? "{}") as { changed?: unknown }).changed;
    return Array.isArray(changed)
      ? changed.filter((c): c is { skillId: string; revision: number } => typeof c?.skillId === "string" && Number.isInteger(c?.revision)).map((c) => ({ skillId: c.skillId, revision: c.revision }))
      : [];
  } catch {
    return [];
  }
}

const toTidy = (row: TidyRow): SkillTidyRun => ({
  id: row.id, status: row.status, provider: row.provider, model: row.model, changes: row.changes, reason: row.reason,
  error: row.error, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at
});

export const SKILL_MESSAGES = {
  name: "A name is lowercase letters, digits and hyphens, at most 64 characters.",
  description: "A description is at most 300 characters.",
  body: "The skill would be longer than 500 lines or 40,000 characters.",
  nameTaken: "A skill with this name already exists.",
  fileName: "A skill file has this name.",
  stale: "The skill changed since you loaded it. Load it again.",
  notFound: "There is no learned skill by that name.",
  noRevision: (n: number) => `The skill has no revision ${n}.`,
  later: (name: string) => `A later change to ${name} came after it; revert that first.`
} as const;

interface SkillRow {
  id: string; name: string; description: string; body: string; scope: "user" | "project"; project_id: string | null;
  status: LearnedSkillStatus; revision: number; created_at: string; updated_at: string; last_used_at: string | null;
  archived_reason: string | null; absorbed_into: string | null;
}
interface VersionRow {
  skill_id: string; revision: number; name: string; description: string; body: string; status: LearnedSkillStatus;
  scope: "user" | "project"; project_id: string | null; archived_reason: string | null; absorbed_into: string | null; change: LearnedSkillChange;
  by_actor: string; thread_id: string | null; run_id: string | null; change_id: string; reason: string | null; at: string;
}
interface RunRow {
  id: string; thread_id: string; requested_by: string | null; focus: string | null; from_seq: number; to_seq: number;
  status: SkillReviewRun["status"]; provider: string | null; model: string | null; outcome: SkillReviewRun["outcome"];
  skill_id: string | null; revision: number | null; reason: string | null; error: string | null; created_at: string;
  started_at: string | null; finished_at: string | null; metadata_json: string | null;
}

const whereOf = (scope: "user" | "project", projectId: string | null): LearnedSkillWhere =>
  scope === "user" ? { scope: "user" } : { scope: "project", projectId: projectId ?? "" };
const projectIdOf = (where: LearnedSkillWhere): string | null => (where.scope === "project" ? where.projectId : null);

function toSkill(row: SkillRow): LearnedSkill {
  return {
    id: row.id, name: row.name, description: row.description, body: row.body, where: whereOf(row.scope, row.project_id),
    status: row.status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at, archivedReason: row.archived_reason, absorbedInto: row.absorbed_into
  };
}
function toVersion(row: VersionRow): LearnedSkillVersion {
  return {
    skillId: row.skill_id, revision: row.revision, name: row.name, description: row.description, body: row.body,
    status: row.status, where: whereOf(row.scope, row.project_id), archivedReason: row.archived_reason, absorbedInto: row.absorbed_into, change: row.change,
    by: actorOf(row.by_actor), threadId: row.thread_id, runId: row.run_id, changeId: row.change_id, reason: row.reason, at: row.at
  };
}
function toRun(row: RunRow): SkillReviewRun {
  return {
    id: row.id, threadId: row.thread_id, requestedBy: row.requested_by, focus: row.focus, fromSeq: row.from_seq, toSeq: row.to_seq,
    status: row.status, provider: row.provider, model: row.model, outcome: row.outcome, skillId: row.skill_id, revision: row.revision,
    reason: row.reason, error: row.error, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null
  };
}

function withoutBody(version: LearnedSkillVersion): LearnedSkillVersionMeta {
  const { body: _body, ...meta } = version;
  return meta;
}

/** Lines of a body, as the limit counts them: a final newline adds none. */
function lineCount(body: string): number {
  return body.replace(/\n$/, "").split("\n").length;
}

export interface ChangeFields {
  description?: string;
  body?: string;
  where?: LearnedSkillWhere;
  status?: LearnedSkillStatus;
  archivedReason?: string | null;
  absorbedInto?: string | null;
  change: LearnedSkillChange;
  by: LearnedSkillActor;
  threadId?: string | null;
  runId?: string | null;
  reason?: string | null;
  /** One id for every row an action writes (a merge, a revert of one). */
  changeId?: string;
}

export class LearnedSkillStore {
  constructor(
    private readonly db: Database,
    private readonly fileSkillNames: () => ReadonlySet<string>,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Several writes as one: a change and its run's end stand or fall together. */
  transaction<T>(write: () => T): T {
    return this.db.transaction(write).immediate();
  }

  /** Why these fields cannot be stored; null when they can. */
  validate(fields: { name?: string; description?: string; body?: string }): string | null {
    if (fields.name !== undefined && (fields.name.length > SKILL_NAME_MAX || !SKILL_NAME_PATTERN.test(fields.name))) return SKILL_MESSAGES.name;
    if (fields.description !== undefined && fields.description.length > SKILL_DESCRIPTION_MAX) return SKILL_MESSAGES.description;
    if (fields.body !== undefined && (fields.body.length > SKILL_BODY_MAX_CHARS || lineCount(fields.body) > SKILL_BODY_MAX_LINES)) return SKILL_MESSAGES.body;
    return null;
  }

  create(input: { name: string; description: string; body: string; where: LearnedSkillWhere; by: LearnedSkillActor; threadId?: string | null; runId?: string | null; reason?: string | null }): ChangeResult {
    const invalid = this.validate(input);
    if (invalid) return { ok: false, error: "invalid", message: invalid };
    if (this.fileSkillNames().has(input.name)) return { ok: false, error: "name_taken", message: SKILL_MESSAGES.fileName };
    const id = newId("skl");
    const at = this.now().toISOString();
    return this.db.transaction((): ChangeResult => {
      const taken = this.db.prepare("select 1 from learned_skills where name = ?").get(input.name);
      if (taken) return { ok: false, error: "name_taken", message: SKILL_MESSAGES.nameTaken };
      this.db.prepare(
        `insert into learned_skills (id, name, description, body, scope, project_id, status, revision, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, 'available', 1, ?, ?)`
      ).run(id, input.name, input.description, input.body, input.where.scope, projectIdOf(input.where), at, at);
      const skill = this.get(id)!;
      this.writeVersion(skill, { change: "create", by: input.by, threadId: input.threadId, runId: input.runId, reason: input.reason, changeId: newId("chg") }, at);
      return { ok: true, skill };
    }).immediate();
  }

  /**
   * The 60-day rule, with no model: every available skill whose latest
   * activity — its last use, or its last change by anyone — is older than
   * UNUSED_ARCHIVE_DAYS is archived by the rule, each as its own action (a
   * restore brings one back). Returns the skills archived.
   */
  archiveUnused(): LearnedSkill[] {
    return this.db.transaction((): LearnedSkill[] => {
      const now = this.now();
      const cutoff = new Date(now.getTime() - UNUSED_ARCHIVE_DAYS * 86_400_000).toISOString();
      const idle = this.db.prepare(
        `select id, revision from learned_skills
         where status = 'available' and max(coalesce(last_used_at, ''), updated_at) < ?
         order by name`
      ).all(cutoff) as Array<{ id: string; revision: number }>;
      const at = now.toISOString();
      return idle.flatMap((row) => {
        const done = this.changeNow(row.id, row.revision, {
          status: "archived", archivedReason: UNUSED_ARCHIVE_REASON, change: "archive", by: "rule", reason: UNUSED_ARCHIVE_REASON
        }, at);
        return done.ok ? [done.skill] : [];
      });
    }).immediate();
  }

  /** Whether the 60-day rule archived anything since `at` (an ISO time). */
  archivedByRuleSince(at: string): boolean {
    return this.db.prepare("select 1 from learned_skill_versions where by_actor = 'rule' and at >= ? limit 1").get(at) !== null;
  }

  /** A change from `baseRevision`: refused as stale when the skill moved on. */
  change(id: string, baseRevision: number, fields: ChangeFields): ChangeResult {
    const invalid = this.validate(fields);
    if (invalid) return { ok: false, error: "invalid", message: invalid };
    return this.db.transaction((): ChangeResult => this.changeNow(id, baseRevision, fields, this.now().toISOString())).immediate();
  }

  /**
   * Without `toRevision`: the action that wrote the skill's newest revision
   * is taken back, on every skill it changed (a skill it created is
   * archived) — refused while any of them has a later change. With it: this
   * skill goes back to that revision's text, scope and status.
   */
  revert(id: string, input: { toRevision?: number; by: LearnedSkillActor; threadId?: string | null; runId?: string | null; reason: string }): ChangeResult {
    return this.db.transaction((): ChangeResult => {
      const skill = this.get(id);
      if (!skill) return { ok: false, error: "not_found", message: SKILL_MESSAGES.notFound };
      const at = this.now().toISOString();
      const changeId = newId("chg");
      const by = { change: "revert" as const, by: input.by, threadId: input.threadId, runId: input.runId, reason: input.reason, changeId };
      if (input.toRevision !== undefined) {
        const target = this.version(id, input.toRevision);
        if (!target) return { ok: false, error: "invalid", message: SKILL_MESSAGES.noRevision(input.toRevision) };
        return this.changeNow(id, skill.revision, { ...by, description: target.description, body: target.body, where: target.where, status: target.status, archivedReason: target.archivedReason, absorbedInto: target.absorbedInto }, at);
      }
      const newest = this.version(id, skill.revision);
      if (!newest) return { ok: false, error: "invalid", message: SKILL_MESSAGES.noRevision(skill.revision) };
      // Every revision the action wrote, those whose text is gone too.
      const rows = this.db.prepare("select skill_id, revision from learned_skill_actions where change_id = ? order by skill_id, revision")
        .all(newest.changeId) as Array<{ skill_id: string; revision: number }>;
      const bySkill = new Map<string, number[]>();
      for (const row of rows) bySkill.set(row.skill_id, [...(bySkill.get(row.skill_id) ?? []), row.revision]);
      const plans: Array<{ skill: LearnedSkill; before: LearnedSkillVersion | null }> = [];
      for (const [skillId, versions] of bySkill) {
        const current = this.get(skillId);
        if (!current) continue;
        const last = versions[versions.length - 1]!;
        if (current.revision > last) return { ok: false, error: "blocked", message: SKILL_MESSAGES.later(current.name) };
        const first = versions[0]!;
        const before = first === 1 ? null : this.version(skillId, first - 1);
        if (first !== 1 && !before) return { ok: false, error: "invalid", message: SKILL_MESSAGES.noRevision(first - 1) };
        plans.push({ skill: current, before });
      }
      let result: ChangeResult = { ok: true, skill };
      for (const plan of plans) {
        const done = plan.before
          ? this.changeNow(plan.skill.id, plan.skill.revision, { ...by, description: plan.before.description, body: plan.before.body, where: plan.before.where, status: plan.before.status, archivedReason: plan.before.archivedReason, absorbedInto: plan.before.absorbedInto }, at)
          : this.changeNow(plan.skill.id, plan.skill.revision, { ...by, status: "archived", archivedReason: input.reason }, at);
        if (!done.ok) return done;
        if (plan.skill.id === id) result = done;
      }
      return result;
    }).immediate();
  }

  get(id: string): LearnedSkill | null {
    const row = this.db.prepare("select * from learned_skills where id = ?").get(id) as SkillRow | null;
    return row ? toSkill(row) : null;
  }

  getByName(name: string): LearnedSkill | null {
    const row = this.db.prepare("select * from learned_skills where name = ?").get(name) as SkillRow | null;
    return row ? toSkill(row) : null;
  }

  /** Skills of one scope (or all), of one status (or both), the latest active first. */
  list(filter: { where?: LearnedSkillWhere; status?: LearnedSkillStatus } = {}): LearnedSkill[] {
    const clauses: string[] = [];
    const params: Array<string | null> = [];
    if (filter.where?.scope === "project") {
      clauses.push("scope = 'project' and project_id = ?");
      params.push(filter.where.projectId);
    } else if (filter.where?.scope === "user") clauses.push("scope = 'user' and project_id is null");
    else if (!filter.status) clauses.push("scope in ('user', 'project')");
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const rows = this.db.prepare(
      `select * from learned_skills where ${clauses.join(" and ")}
       order by max(coalesce(last_used_at, ''), updated_at) desc, name asc`
    ).all(...params) as SkillRow[];
    return rows.map(toSkill);
  }

  /** The available skills an agent may use: global ones and those of the
   *  given projects (each read through the scope index on its own). */
  visible(view: { projectIds: readonly string[] | "all" }): LearnedSkill[] {
    if (view.projectIds === "all") return this.list({ status: "available" });
    const out = this.list({ where: { scope: "user" }, status: "available" });
    for (const projectId of new Set(view.projectIds)) out.push(...this.list({ where: { scope: "project", projectId }, status: "available" }));
    return out;
  }

  versions(id: string): LearnedSkillVersion[] {
    return (this.db.prepare("select * from learned_skill_versions where skill_id = ? order by revision desc").all(id) as VersionRow[]).map(toVersion);
  }

  /** A skill's history without the texts, newest first. */
  history(id: string): LearnedSkillVersionMeta[] {
    return (this.db.prepare(`select ${VERSION_META_COLUMNS} from learned_skill_versions where skill_id = ? order by revision desc`).all(id) as Array<Omit<VersionRow, "body">>)
      .map((row) => withoutBody(toVersion({ ...row, body: "" })));
  }

  /** Its first revision (always kept) and its newest, without their texts. */
  ends(id: string): { first: LearnedSkillVersionMeta; newest: LearnedSkillVersionMeta } | null {
    const newest = this.db.prepare(`select ${VERSION_META_COLUMNS} from learned_skill_versions where skill_id = ? order by revision desc limit 1`).get(id) as Omit<VersionRow, "body"> | null;
    const first = this.db.prepare(`select ${VERSION_META_COLUMNS} from learned_skill_versions where skill_id = ? order by revision asc limit 1`).get(id) as Omit<VersionRow, "body"> | null;
    return newest && first ? { first: withoutBody(toVersion({ ...first, body: "" })), newest: withoutBody(toVersion({ ...newest, body: "" })) } : null;
  }

  version(id: string, revision: number): LearnedSkillVersion | null {
    const row = this.db.prepare("select * from learned_skill_versions where skill_id = ? and revision = ?").get(id, revision) as VersionRow | null;
    return row ? toVersion(row) : null;
  }

  recordUse(id: string, threadId: string, agent: SkillUseAgent): void {
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare("insert into learned_skill_uses (skill_id, at, thread_id, agent) values (?, ?, ?, ?)").run(id, at, threadId, agent);
      this.db.prepare("update learned_skills set last_used_at = ? where id = ?").run(at, id);
    })();
  }

  usesSince(id: string, sinceIso: string): number {
    return (this.db.prepare("select count(*) as n from learned_skill_uses where skill_id = ? and at >= ?").get(id, sinceIso) as { n: number }).n;
  }

  /** Queues a review of a thread's work; one already queued for that thread
   *  takes the request instead (its range grows, the focuses join). */
  requestReview(input: { threadId: string; requestedBy: string; focus: string; fromSeq: number; toSeq: number }): { id: string; joined: boolean } {
    return this.db.transaction(() => {
      // At most one is queued per thread: no order to keep, so the thread index answers it.
      const queued = this.db.prepare("select * from skill_review_runs where thread_id = ? and status = 'queued' limit 1").get(input.threadId) as RunRow | null;
      if (queued) {
        const focus = [queued.focus, input.focus].filter((part): part is string => Boolean(part && part.trim())).join("; ");
        this.db.prepare("update skill_review_runs set to_seq = max(to_seq, ?), from_seq = min(from_seq, ?), focus = ? where id = ?")
          .run(input.toSeq, input.fromSeq, focus, queued.id);
        return { id: queued.id, joined: true };
      }
      const id = newId("skr");
      this.db.prepare(
        `insert into skill_review_runs (id, thread_id, requested_by, focus, from_seq, to_seq, status, created_at)
         values (?, ?, ?, ?, ?, ?, 'queued', ?)`
      ).run(id, input.threadId, input.requestedBy, input.focus, input.fromSeq, input.toSeq, this.now().toISOString());
      return { id, joined: false };
    }).immediate();
  }

  /** The oldest queued review that is due: not of a thread a review that
   *  succeeded began on within REVIEW_THREAD_INTERVAL_MS (a failed one saved
   *  nothing, so it holds nothing back). */
  nextQueuedReview(): SkillReviewRun | null {
    const since = new Date(this.now().getTime() - REVIEW_THREAD_INTERVAL_MS).toISOString();
    const row = this.db.prepare(
      `select * from skill_review_runs q where status = 'queued'
         and not exists (select 1 from skill_review_runs d where d.thread_id = q.thread_id and d.status = 'succeeded' and d.started_at > ?)
       order by created_at, rowid limit 1`
    ).get(since) as RunRow | null;
    return row ? toRun(row) : null;
  }

  /** The newest reviews, whatever their state, newest first. */
  recentReviews(limit: number): SkillReviewRun[] {
    const rows = this.db.prepare("select * from skill_review_runs order by created_at desc, rowid desc limit ?").all(limit) as RunRow[];
    return rows.map(toRun);
  }

  review(id: string): SkillReviewRun | null {
    const row = this.db.prepare("select * from skill_review_runs where id = ?").get(id) as RunRow | null;
    return row ? toRun(row) : null;
  }

  startReview(id: string, provider: string | null, model: string | null): void {
    this.db.prepare("update skill_review_runs set status = 'running', provider = ?, model = ?, started_at = ? where id = ? and status = 'queued'")
      .run(provider, model, this.now().toISOString(), id);
  }

  finishReview(id: string, result: { status: "succeeded" | "failed" | "skipped"; outcome?: SkillReviewRun["outcome"]; skillId?: string | null; revision?: number | null; reason?: string | null; error?: string | null; metadata?: Record<string, unknown> | null }): void {
    this.db.prepare(
      `update skill_review_runs set status = ?, outcome = ?, skill_id = ?, revision = ?, reason = ?, error = ?, metadata_json = ?, finished_at = ?
       where id = ?`
    ).run(result.status, result.outcome ?? null, result.skillId ?? null, result.revision ?? null, result.reason ?? null, result.error ?? null,
      result.metadata ? JSON.stringify(result.metadata) : null, this.now().toISOString(), id);
  }

  /** A tidy begins now, running. */
  startTidy(provider: string | null, model: string | null): SkillTidyRun {
    const at = this.now().toISOString();
    const id = newId("skt");
    this.db.prepare("insert into skill_tidy_runs (id, status, provider, model, created_at, started_at) values (?, 'running', ?, ?, ?, ?)").run(id, provider, model, at, at);
    return toTidy(this.db.prepare("select * from skill_tidy_runs where id = ?").get(id) as TidyRow);
  }

  /** `changed`: the revisions it wrote, kept with the run (a skill keeps
   *  only its newest revisions, so they are not looked up there). */
  finishTidy(id: string, result: { status: "succeeded" | "failed"; changes?: number; reason?: string | null; error?: string | null; changed?: Array<{ skillId: string; revision: number }> }): void {
    this.db.prepare("update skill_tidy_runs set status = ?, changes = ?, reason = ?, error = ?, metadata_json = ?, finished_at = ? where id = ?")
      .run(result.status, result.changes ?? 0, result.reason ?? null, result.error ?? null, JSON.stringify({ changed: result.changed ?? [] }), this.now().toISOString(), id);
  }

  /** Whether the tidy is due now (TIDY_INTERVAL_MS, TIDY_RETRY_MS): never
   *  while one runs, nor with no learned skill at all. */
  tidyDue(): boolean {
    if (this.db.prepare("select 1 from learned_skills limit 1").get() === null) return false;
    const latest = (where: string) => this.db.prepare(`select * from skill_tidy_runs ${where} order by started_at desc, rowid desc limit 1`).get() as TidyRow | null;
    const last = latest("");
    if (!last) return true;
    if (last.status === "running") return false;
    const ok = latest("where status = 'succeeded'");
    const more = (run: TidyRow | null) => run !== null && run.changes > 0;
    const wait = last.status === "failed" || more(last) ? TIDY_RETRY_MS : TIDY_INTERVAL_MS;
    if (this.now().getTime() - Date.parse(last.started_at) < wait) return false;
    if (!ok || more(ok)) return true;
    return this.db.prepare("select 1 from learned_skill_versions where at > ? and by_actor <> ? limit 1").get(ok.started_at, storedActor("tidy")) !== null;
  }

  /** The newest tidies, newest first, each with the revisions it wrote. */
  recentTidies(limit: number): Array<SkillTidyRun & { changed: Array<{ skillId: string; revision: number }> }> {
    const rows = this.db.prepare("select * from skill_tidy_runs order by started_at desc, rowid desc limit ?").all(limit) as Array<TidyRow & { metadata_json: string | null }>;
    return rows.map((row) => ({ ...toTidy(row), changed: changedOf(row.metadata_json) }));
  }

  /** Tidies a stopped server left running end as failed; how many. */
  closeInterruptedTidies(): number {
    return this.db.prepare("update skill_tidy_runs set status = 'failed', error = 'interrupted', finished_at = ? where status = 'running'")
      .run(this.now().toISOString()).changes;
  }

  /** Runs a stopped server left running end as failed; how many. */
  closeInterruptedReviews(): number {
    return this.db.prepare("update skill_review_runs set status = 'failed', error = 'interrupted', finished_at = ? where status = 'running'")
      .run(this.now().toISOString()).changes;
  }

  reviewMark(threadId: string): number | null {
    const row = this.db.prepare("select reviewed_to_seq from skill_review_marks where thread_id = ?").get(threadId) as { reviewed_to_seq: number } | null;
    return row?.reviewed_to_seq ?? null;
  }

  setReviewMark(threadId: string, seq: number): void {
    this.db.prepare(
      `insert into skill_review_marks (thread_id, reviewed_to_seq, at) values (?, ?, ?)
       on conflict(thread_id) do update set reviewed_to_seq = max(reviewed_to_seq, excluded.reviewed_to_seq), at = excluded.at`
    ).run(threadId, seq, this.now().toISOString());
  }

  /** Inside a transaction: the compare-and-set, its version row, the trim. */
  private changeNow(id: string, baseRevision: number, fields: ChangeFields, at: string): ChangeResult {
    const current = this.get(id);
    if (!current) return { ok: false, error: "not_found", message: SKILL_MESSAGES.notFound };
    if (current.revision !== baseRevision) return { ok: false, error: "stale", message: SKILL_MESSAGES.stale };
    const where = fields.where ?? current.where;
    const status = fields.status ?? current.status;
    const archivedReason = status === "archived" ? (fields.archivedReason !== undefined ? fields.archivedReason : current.archivedReason) : null;
    const absorbedInto = status === "archived" ? (fields.absorbedInto !== undefined ? fields.absorbedInto : current.absorbedInto) : null;
    const updated = this.db.prepare(
      `update learned_skills set description = ?, body = ?, scope = ?, project_id = ?, status = ?, archived_reason = ?, absorbed_into = ?,
         revision = revision + 1, updated_at = ?
       where id = ? and revision = ?`
    ).run(fields.description ?? current.description, fields.body ?? current.body, where.scope, projectIdOf(where), status,
      archivedReason, absorbedInto, at, id, baseRevision);
    if (updated.changes === 0) return { ok: false, error: "stale", message: SKILL_MESSAGES.stale };
    const skill = this.get(id)!;
    this.writeVersion(skill, { ...fields, changeId: fields.changeId ?? newId("chg") }, at);
    return { ok: true, skill };
  }

  private writeVersion(skill: LearnedSkill, fields: Pick<ChangeFields, "change" | "by" | "threadId" | "runId" | "reason"> & { changeId: string }, at: string): void {
    this.db.prepare(
      `insert into learned_skill_versions
        (skill_id, revision, name, description, body, status, scope, project_id, archived_reason, absorbed_into, change, by_actor, thread_id, run_id, change_id, reason, at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(skill.id, skill.revision, skill.name, skill.description, skill.body, skill.status, skill.where.scope, projectIdOf(skill.where),
      skill.archivedReason, skill.absorbedInto, fields.change, storedActor(fields.by), fields.threadId ?? null, fields.runId ?? null, fields.changeId, fields.reason ?? null, at);
    this.db.prepare("insert into learned_skill_actions (change_id, skill_id, revision) values (?, ?, ?)").run(fields.changeId, skill.id, skill.revision);
    // One revision leaves per change: the one just past the kept ones.
    const leaving = skill.revision - KEPT_REVISIONS;
    if (leaving > 1) this.db.prepare("delete from learned_skill_versions where skill_id = ? and revision = ?").run(skill.id, leaving);
  }
}
