import type { Database } from "bun:sqlite";
import { PLAN_LIMITS, emptyPlan, type FeaturePlanDto, type PlanStepDto, type PlanStepStatus } from "../../../shared/api/plans.js";
import { planProgress } from "../../../shared/feature-state.js";
import { charLength } from "../../../shared/plan-text.js";

interface PlanStepPatch {
  id?: number;
  title?: string;
  status?: PlanStepStatus;
  note?: string;
  after?: number;
}

interface PlanUpdateInput {
  goal?: string;
  conclusion?: string;
  openQuestions?: string[];
  steps?: PlanStepPatch[];
  delete?: number[];
}

type PlanUpdateResult =
  /** `changed`: whether the call wrote anything. Two calls in one
   *  millisecond share an updatedAt, so that stamp cannot tell. */
  | { ok: true; plan: FeaturePlanDto; summary: string; changed: boolean }
  | { ok: false; errors: string[] };

interface PlanRow { feature_id: string; goal: string | null; conclusion: string | null; open_questions: string; next_step_id: number; updated_at: string }
interface StepRow { feature_id: string; id: number; position: number; title: string; status: PlanStepStatus; note: string | null; created_at: string; started_at: string | null; blocked_at: string | null; completed_at: string | null; updated_at: string }

/** Limits count the text as stored: trimmed. */
function tooLong(label: string, text: string, limit: number): string | null {
  const n = charLength(text.trim());
  return n > limit ? `${label} is ${n} characters; the limit is ${limit}` : null;
}

function toStep(r: StepRow): PlanStepDto {
  return { id: r.id, title: r.title, status: r.status, note: r.note, createdAt: r.created_at, startedAt: r.started_at, blockedAt: r.blocked_at, completedAt: r.completed_at, updatedAt: r.updated_at };
}

/** What one update changed, for its summary line. */
interface PlanChanges {
  fields: string[];
  added: number[];
  steps: string[];
  deleted: number[];
}

/** Where a step placed after `after` goes: after the last step this call
 *  already placed there, else after `after` itself. */
function anchorFor(placedAfter: Map<number, number>, after: number | undefined): number | undefined {
  return after === undefined ? undefined : placedAfter.get(after) ?? after;
}

/** Everything wrong with an update, checked against the plan as the call
 *  would leave it; empty when it can be applied. */
function planUpdateErrors(current: FeaturePlanDto, input: PlanUpdateInput, openQuestions: string[] | undefined): string[] {
  const byId = new Map(current.steps.map((s) => [s.id, s]));
  const deleting = new Set(input.delete ?? []);
  const errors = fieldErrors(input, openQuestions);
  // Each step as the call leaves it, so a note cleared on a done step is
  // caught. A step may appear once per call: two patches of one step would
  // need an order to apply them in, and the plan would pass through states
  // nobody asked for.
  const projected = new Map(current.steps.map((s) => [s.id, { status: s.status, note: s.note }]));
  const touched: number[] = [];
  const newSteps: Array<{ status: PlanStepStatus; note: string | null }> = [];
  for (const patch of input.steps ?? []) {
    const label = patch.id !== undefined ? `step #${patch.id}` : "a new step";
    const repeated = patch.id !== undefined && touched.includes(patch.id);
    if (repeated) errors.push(`step #${patch.id} appears more than once; send each step once`);
    const known = patch.id === undefined || (byId.has(patch.id) && !deleting.has(patch.id));
    if (!known && !repeated) {
      errors.push(byId.has(patch.id!) ? `step #${patch.id} is both changed and deleted in this call; send one` : `step #${patch.id} does not exist`);
    }
    errors.push(...patchTextErrors(patch, label), ...patchAnchorErrors(patch, label, byId, deleting));
    if (repeated) continue;
    if (patch.id !== undefined) touched.push(patch.id);
    if (!known) continue;
    const before = patch.id !== undefined ? projected.get(patch.id)! : { status: "pending" as PlanStepStatus, note: null };
    const next = {
      status: patch.status ?? before.status,
      note: patch.note !== undefined ? (patch.note.trim() || null) : before.note
    };
    if (patch.id === undefined) { newSteps.push(next); continue; }
    projected.set(patch.id, next);
  }
  const needsNote = (label: string, step: { status: PlanStepStatus; note: string | null }) => {
    if (step.status === "done" && !step.note?.trim()) errors.push(`${label}: done needs a note with the result and evidence`);
    if (step.status === "blocked" && !step.note?.trim()) errors.push(`${label}: blocked needs a note saying what it waits on`);
  };
  for (const id of touched) if (projected.has(id) && byId.has(id)) needsNote(`step #${id}`, projected.get(id)!);
  for (const step of newSteps) needsNote("a new step", step);
  for (const id of deleting) if (!byId.has(id)) errors.push(`delete: step #${id} does not exist`);
  return errors;
}

function fieldErrors(input: PlanUpdateInput, openQuestions: string[] | undefined): string[] {
  const errors: string[] = [];
  if (input.goal !== undefined) { const e = tooLong("goal", input.goal, PLAN_LIMITS.goal); if (e) errors.push(e); }
  if (input.conclusion !== undefined) { const e = tooLong("conclusion", input.conclusion, PLAN_LIMITS.conclusion); if (e) errors.push(e); }
  if (openQuestions !== undefined) {
    if (openQuestions.length > PLAN_LIMITS.openQuestions) errors.push(`openQuestions has ${openQuestions.length} items; the limit is ${PLAN_LIMITS.openQuestions}`);
    openQuestions.forEach((q, i) => { const e = tooLong(`openQuestions[${i}]`, q, PLAN_LIMITS.question); if (e) errors.push(e); });
  }
  return errors;
}

/** A step patch's title and note, on their own. */
function patchTextErrors(patch: PlanStepPatch, label: string): string[] {
  const errors: string[] = [];
  if (patch.id === undefined && !patch.title?.trim()) errors.push("a new step needs a title");
  if (patch.id !== undefined && patch.title !== undefined && !patch.title.trim()) errors.push(`${label}: title cannot be empty`);
  if (patch.title !== undefined) { const e = tooLong(`${label}: title`, patch.title, PLAN_LIMITS.title); if (e) errors.push(e); }
  if (patch.note !== undefined) { const e = tooLong(`${label}: note`, patch.note, PLAN_LIMITS.note); if (e) errors.push(e); }
  return errors;
}

/** The step a patch is placed after: an existing step, not itself, not deleted. */
function patchAnchorErrors(patch: PlanStepPatch, label: string, byId: ReadonlyMap<number, unknown>, deleting: ReadonlySet<number>): string[] {
  if (patch.after === undefined) return [];
  if (patch.after === patch.id) return [`${label}: cannot be placed after itself`];
  if (!byId.has(patch.after)) return [`${label}: after #${patch.after}, which does not exist`];
  if (deleting.has(patch.after)) return [`${label}: after #${patch.after}, which this call deletes`];
  return [];
}

/** A feature's plan. The worker is its only writer; one update is all or nothing. */
export class PlanStore {
  constructor(private readonly db: Database, private readonly now: () => string = () => new Date().toISOString()) {}

  get(featureId: string): FeaturePlanDto {
    const row = this.db.prepare(`select * from feature_plans where feature_id = ?`).get(featureId) as PlanRow | null;
    const steps = (this.db.prepare(`select * from feature_plan_steps where feature_id = ? order by position, id`).all(featureId) as StepRow[]).map(toStep);
    const goalHistory = (this.db.prepare(`select goal, changed_at from feature_plan_goal_history where feature_id = ? order by changed_at, rowid`).all(featureId) as Array<{ goal: string; changed_at: string }>)
      .map((g) => ({ goal: g.goal, changedAt: g.changed_at }));
    if (!row) return { ...emptyPlan(featureId), steps, goalHistory };
    return {
      featureId, goal: row.goal, conclusion: row.conclusion,
      openQuestions: JSON.parse(row.open_questions) as string[],
      steps, goalHistory, updatedAt: row.updated_at
    };
  }

  /** Plans of every feature that is not archived and has one. */
  listActive(): FeaturePlanDto[] {
    const ids = this.db.prepare(
      `select p.feature_id from feature_plans p join features f on f.id = p.feature_id and f.archived_at is null order by p.feature_id`
    ).all() as Array<{ feature_id: string }>;
    return ids.map((r) => this.get(r.feature_id));
  }

  update(featureId: string, input: PlanUpdateInput): PlanUpdateResult {
    const current = this.get(featureId);
    // Questions are kept trimmed, without blanks or repeats.
    const openQuestions = input.openQuestions === undefined
      ? undefined
      : [...new Set(input.openQuestions.map((q) => q.trim()).filter(Boolean))];
    const errors = planUpdateErrors(current, input, openQuestions);
    if (errors.length > 0) return { ok: false, errors };

    const at = this.now();
    const changes: PlanChanges = { fields: [], added: [], steps: [], deleted: [] };
    this.db.transaction(() => {
      // The plan row is written only once something changes, so a call that
      // changes nothing leaves a feature with no plan exactly as it was.
      let hasRow = current.updatedAt !== null;
      const ensureRow = () => {
        if (hasRow) return;
        this.db.prepare(`insert into feature_plans (feature_id, open_questions, next_step_id, updated_at) values (?, '[]', 1, ?)`).run(featureId, at);
        hasRow = true;
      };
      this.writeFields(featureId, current, { ...input, openQuestions }, at, ensureRow, changes.fields);
      for (const id of new Set(input.delete ?? [])) {
        this.db.prepare(`delete from feature_plan_steps where feature_id = ? and id = ?`).run(featureId, id);
        changes.deleted.push(id);
      }
      // Steps placed after the same step in one call keep the order given:
      // each goes after the one placed there before it.
      const placedAfter = new Map<number, number>();
      for (const patch of input.steps ?? []) {
        if (patch.id === undefined) {
          ensureRow();
          changes.added.push(this.insertStep(featureId, patch, placedAfter, at));
          continue;
        }
        const line = this.patchStep(featureId, { ...patch, id: patch.id }, placedAfter, at);
        if (line) changes.steps.push(line);
      }
      if (changes.fields.length + changes.added.length + changes.steps.length + changes.deleted.length > 0) {
        this.db.prepare(`update feature_plans set updated_at = ? where feature_id = ?`).run(at, featureId);
      }
      // Immediate: it reads before it writes, and a deferred transaction fails
      // outright when another connection (an agent's sqlite3) commits between.
    }).immediate();

    const plan = this.get(featureId);
    const { done, total } = planProgress(plan);
    const parts = [
      ...(changes.fields.length ? [changes.fields.join(", ")] : []),
      ...(changes.added.length ? [`added ${changes.added.map((id) => `#${id}`).join(", ")}`] : []),
      ...changes.steps,
      ...(changes.deleted.length ? [`deleted ${changes.deleted.map((id) => `#${id}`).join(", ")}`] : [])
    ];
    const summary = parts.length ? `Plan updated: ${parts.join("; ")} (${done} of ${total} done)` : `Plan unchanged (${done} of ${total} done)`;
    return { ok: true, plan, summary, changed: parts.length > 0 };
  }

  /** Goal, conclusion and open questions; each written only when it differs. */
  private writeFields(
    featureId: string,
    current: FeaturePlanDto,
    input: Pick<PlanUpdateInput, "goal" | "conclusion" | "openQuestions">,
    at: string,
    ensureRow: () => void,
    changed: string[]
  ): void {
    // Kept trimmed; an empty goal or conclusion clears it.
    const goal = input.goal === undefined ? undefined : input.goal.trim() || null;
    const conclusion = input.conclusion === undefined ? undefined : input.conclusion.trim() || null;
    if (goal !== undefined && goal !== current.goal) {
      ensureRow();
      if (current.goal) this.db.prepare(`insert into feature_plan_goal_history (feature_id, goal, changed_at) values (?, ?, ?)`).run(featureId, current.goal, at);
      this.db.prepare(`update feature_plans set goal = ? where feature_id = ?`).run(goal, featureId);
      changed.push("goal");
    }
    if (conclusion !== undefined && conclusion !== current.conclusion) {
      ensureRow();
      this.db.prepare(`update feature_plans set conclusion = ? where feature_id = ?`).run(conclusion, featureId);
      changed.push("conclusion");
    }
    if (input.openQuestions !== undefined && JSON.stringify(input.openQuestions) !== JSON.stringify(current.openQuestions)) {
      ensureRow();
      this.db.prepare(`update feature_plans set open_questions = ? where feature_id = ?`).run(JSON.stringify(input.openQuestions), featureId);
      changed.push("open questions");
    }
  }

  /** A new step, numbered from the plan's counter; its id. */
  private insertStep(featureId: string, patch: PlanStepPatch, placedAfter: Map<number, number>, at: string): number {
    const next = (this.db.prepare(`select next_step_id from feature_plans where feature_id = ?`).get(featureId) as { next_step_id: number }).next_step_id;
    this.db.prepare(`update feature_plans set next_step_id = ? where feature_id = ?`).run(next + 1, featureId);
    const position = this.positionFor(featureId, anchorFor(placedAfter, patch.after));
    if (patch.after !== undefined) placedAfter.set(patch.after, next);
    const status = patch.status ?? "pending";
    this.db.prepare(
      `insert into feature_plan_steps (feature_id, id, position, title, status, note, created_at, started_at, blocked_at, completed_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(featureId, next, position, patch.title!.trim(), status, patch.note?.trim() || null, at,
      status === "in_progress" || status === "done" ? at : null,
      status === "blocked" ? at : null,
      status === "done" ? at : null, at);
    return next;
  }

  /** An existing step changed or moved; its summary line, or null when the
   *  patch leaves it as it was. */
  private patchStep(featureId: string, patch: PlanStepPatch & { id: number }, placedAfter: Map<number, number>, at: string): string | null {
    const before = this.db.prepare(`select * from feature_plan_steps where feature_id = ? and id = ?`).get(featureId, patch.id) as StepRow;
    const title = patch.title !== undefined ? patch.title.trim() : before.title;
    const note = patch.note !== undefined ? (patch.note.trim() || null) : before.note;
    const status = patch.status ?? before.status;
    const anchor = anchorFor(placedAfter, patch.after);
    const moves = anchor !== undefined && this.predecessorOf(featureId, patch.id) !== anchor;
    if (moves) {
      // What was placed after it, and the chain it ended, stay where they
      // were: a later `after` names where it is now.
      for (const [key, value] of placedAfter) if (key === patch.id || value === patch.id) placedAfter.delete(key);
    }
    if (patch.after !== undefined) placedAfter.set(patch.after, patch.id);
    if (title === before.title && note === before.note && status === before.status && !moves) return null;
    const startedAt = before.started_at ?? (status === "in_progress" || status === "done" ? at : null);
    const blockedAt = status === "blocked" ? (before.status === "blocked" ? before.blocked_at : at) : null;
    const completedAt = status === "done" ? (before.status === "done" ? before.completed_at : at) : null;
    const position = moves ? this.positionFor(featureId, anchor, patch.id) : before.position;
    this.db.prepare(
      `update feature_plan_steps set title = ?, note = ?, status = ?, started_at = ?, blocked_at = ?, completed_at = ?, position = ?, updated_at = ?
       where feature_id = ? and id = ?`
    ).run(title, note, status, startedAt, blockedAt, completedAt, position, at, featureId, patch.id);
    const edited = title !== before.title || note !== before.note || moves;
    return `#${patch.id} ${[status !== before.status ? status.replace("_", " ") : "", edited ? "edited" : ""].filter(Boolean).join(", ")}`;
  }

  /** The step right before `id` in plan order, or undefined for the first. */
  private predecessorOf(featureId: string, id: number): number | undefined {
    const order = (this.db.prepare(`select id from feature_plan_steps where feature_id = ? order by position, id`).all(featureId) as Array<{ id: number }>).map((r) => r.id);
    const index = order.indexOf(id);
    return index > 0 ? order[index - 1] : undefined;
  }

  /** The position a step takes: after `after`, or at the end. Positions are
   *  renumbered in steps of 10 first, so there is always room after any step. */
  private positionFor(featureId: string, after: number | undefined, moving?: number): number {
    const rows = this.db.prepare(`select id from feature_plan_steps where feature_id = ? order by position, id`).all(featureId) as Array<{ id: number }>;
    const order = rows.map((r) => r.id).filter((id) => id !== moving);
    const renumber = this.db.prepare(`update feature_plan_steps set position = ? where feature_id = ? and id = ?`);
    order.forEach((id, i) => renumber.run((i + 1) * 10, featureId, id));
    if (after === undefined) return (order.length + 1) * 10;
    return (order.indexOf(after) + 1) * 10 + 5;
  }
}
