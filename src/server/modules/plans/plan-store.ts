import type { Database } from "bun:sqlite";
import { PLAN_LIMITS, emptyPlan, type WorkerPlanDto, type PlanStepDto, type PlanStepStatus } from "../../../shared/api/plans.js";
import { planProgress } from "../../../shared/worker-state.js";
import { charLength } from "../../../shared/plan-text.js";
import { earlierWorkOf, planRounds } from "../../../shared/plan-rounds.js";

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
  | { ok: true; plan: WorkerPlanDto; summary: string; changed: boolean }
  | { ok: false; errors: string[] };

interface PlanRow { worker_id: string; goal: string | null; conclusion: string | null; open_questions: string; next_step_id: number; updated_at: string }
interface StepRow { worker_id: string; id: number; position: number; title: string; status: PlanStepStatus; note: string | null; created_at: string; started_at: string | null; blocked_at: string | null; completed_at: string | null; updated_at: string }

/** Limits count the text as stored: trimmed. Text is refused only past
 *  `refusedPast`; the answer names the limit itself. */
function tooLong(label: string, text: string, limit: number, refusedPast = limit): string | null {
  const n = charLength(text.trim());
  return n > refusedPast ? `${label} is ${n} characters; the limit is ${limit}` : null;
}

/** The worker is told the conclusion's and each question's limit, and text
 *  written to one often lands a few characters over: refused only a tenth
 *  past it, as a memory brief is, so that is not sent back. */
const CONCLUSION_REFUSED_PAST = PLAN_LIMITS.conclusion + PLAN_LIMITS.conclusion / 10;
const QUESTION_REFUSED_PAST = PLAN_LIMITS.question + PLAN_LIMITS.question / 10;

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

/** A plan as its worker's state reads it (isAsking, hasStepInProgress,
 *  workerStateFor, workerStateLine): its questions and conclusion, and its
 *  steps not done, in plan order — or, when every step is done, one of
 *  them, so a plan of finished work still reads as having steps. Not its
 *  progress, which counts the finished steps (get, planProgress). */
export type PlanStateView = Pick<WorkerPlanDto, "workerId" | "openQuestions" | "conclusion" | "steps">;

/** The steps a worker still has before it: what its state is read from. */
const OPEN_STATUSES = `('pending', 'in_progress', 'blocked')`;

/** Where a step placed after `after` goes: after the last step this call
 *  already placed there, else after `after` itself. */
function anchorFor(placedAfter: Map<number, number>, after: number | undefined): number | undefined {
  return after === undefined ? undefined : placedAfter.get(after) ?? after;
}

/** Everything wrong with an update, checked against the plan as the call
 *  would leave it; empty when it can be applied. */
function planUpdateErrors(current: WorkerPlanDto, input: PlanUpdateInput, openQuestions: string[] | undefined): string[] {
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
  if (input.conclusion !== undefined) { const e = tooLong("conclusion", input.conclusion, PLAN_LIMITS.conclusion, CONCLUSION_REFUSED_PAST); if (e) errors.push(e); }
  if (openQuestions !== undefined) {
    if (openQuestions.length > PLAN_LIMITS.openQuestions) errors.push(`openQuestions has ${openQuestions.length} items; the limit is ${PLAN_LIMITS.openQuestions}`);
    openQuestions.forEach((q, i) => { const e = tooLong(`openQuestions[${i}]`, q, PLAN_LIMITS.question, QUESTION_REFUSED_PAST); if (e) errors.push(e); });
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

/** A worker's plan. The worker is its only writer; one update is all or nothing. */
export class PlanStore {
  constructor(private readonly db: Database, private readonly now: () => string = () => new Date().toISOString()) {}

  get(workerId: string): WorkerPlanDto {
    const row = this.db.prepare(`select * from worker_plans where worker_id = ?`).get(workerId) as PlanRow | null;
    const steps = (this.db.prepare(`select * from worker_plan_steps where worker_id = ? order by position, id`).all(workerId) as StepRow[]).map(toStep);
    const goalHistory = (this.db.prepare(`select goal, changed_at from worker_plan_goal_history where worker_id = ? order by changed_at, rowid`).all(workerId) as Array<{ goal: string; changed_at: string }>)
      .map((g) => ({ goal: g.goal, changedAt: g.changed_at }));
    if (!row) return { ...emptyPlan(workerId), steps, goalHistory };
    return {
      workerId, goal: row.goal, conclusion: row.conclusion,
      openQuestions: JSON.parse(row.open_questions) as string[],
      steps, goalHistory, updatedAt: row.updated_at
    };
  }

  /** The workers, not archived, that have a plan; in id order. */
  private activeIds(): string[] {
    return (this.db.prepare(
      `select p.worker_id from worker_plans p join workers wk on wk.id = p.worker_id and wk.archived_at is null order by p.worker_id`
    ).all() as Array<{ worker_id: string }>).map((r) => r.worker_id);
  }

  /** One plan as its worker's state reads it (PlanStateView). */
  stateOf(workerId: string): PlanStateView {
    const row = this.db.prepare(`select conclusion, open_questions from worker_plans where worker_id = ?`).get(workerId) as Pick<PlanRow, "conclusion" | "open_questions"> | null;
    // Through the status index: the plan's finished steps are never read.
    const steps = (this.db.prepare(
      `select * from worker_plan_steps indexed by idx_worker_plan_steps_status
       where status in ${OPEN_STATUSES} and worker_id = ? order by position, id`
    ).all(workerId) as StepRow[]).map(toStep);
    return this.stateView(workerId, row, steps);
  }

  /** Every active plan as its worker's state reads it, by worker id: the
   *  status snapshot and the page read them all on each change. A worker
   *  with no plan has none here. */
  statesOfActive(): Map<string, PlanStateView> {
    const rows = this.db.prepare(
      `select p.worker_id, p.conclusion, p.open_questions from worker_plans p
       join workers wk on wk.id = p.worker_id and wk.archived_at is null order by p.worker_id`
    ).all() as Array<Pick<PlanRow, "worker_id" | "conclusion" | "open_questions">>;
    const open = new Map<string, PlanStepDto[]>();
    const stepRows = this.db.prepare(
      `select s.* from worker_plan_steps s join workers wk on wk.id = s.worker_id and wk.archived_at is null
       where s.status in ${OPEN_STATUSES} order by s.worker_id, s.position, s.id`
    ).all() as StepRow[];
    for (const step of stepRows) {
      const list = open.get(step.worker_id) ?? [];
      list.push(toStep(step));
      open.set(step.worker_id, list);
    }
    return new Map(rows.map((row) => [row.worker_id, this.stateView(row.worker_id, row, open.get(row.worker_id) ?? [])]));
  }

  /** The view from a plan's row and its open steps: one finished step
   *  stands in for the rest when nothing is open. */
  private stateView(workerId: string, row: Pick<PlanRow, "conclusion" | "open_questions"> | null, openSteps: PlanStepDto[]): PlanStateView {
    let steps = openSteps;
    if (steps.length === 0) {
      const done = this.db.prepare(`select * from worker_plan_steps where status = 'done' and worker_id = ? limit 1`).get(workerId) as StepRow | null;
      if (done) steps = [toStep(done)];
    }
    return {
      workerId,
      openQuestions: row ? JSON.parse(row.open_questions) as string[] : [],
      conclusion: row?.conclusion ?? null,
      steps
    };
  }

  /** The active workers whose plan asks something, in id order. */
  askingWorkerIds(): string[] {
    return (this.db.prepare(
      `select p.worker_id from worker_plans p join workers wk on wk.id = p.worker_id and wk.archived_at is null
       where json_array_length(p.open_questions) > 0 order by p.worker_id`
    ).all() as Array<{ worker_id: string }>).map((r) => r.worker_id);
  }

  /** A plan as the page is sent it (planForPage of the whole plan): the
   *  current work in full, earlier work as counts, read without the earlier
   *  steps' text. */
  pagePlan(workerId: string): WorkerPlanDto {
    const row = this.db.prepare(`select * from worker_plans where worker_id = ?`).get(workerId) as PlanRow | null;
    const goalHistory = (this.db.prepare(`select goal, changed_at from worker_plan_goal_history where worker_id = ? order by changed_at, rowid`).all(workerId) as Array<{ goal: string; changed_at: string }>)
      .map((g) => ({ goal: g.goal, changedAt: g.changed_at }));
    // planRounds: the current work is every open step and what was written
    // since the last change of goal; the done steps before it are earlier work.
    const lastChange = goalHistory.at(-1)?.changedAt ?? "";
    const steps = (this.db.prepare(
      `select * from worker_plan_steps where worker_id = ? and (status != 'done' or created_at >= ?) order by position, id`
    ).all(workerId, lastChange) as StepRow[]).map(toStep);
    const earlierDone = (this.db.prepare(
      `select id, created_at from worker_plan_steps where worker_id = ? and status = 'done' and created_at < ?`
    ).all(workerId, lastChange) as Array<{ id: number; created_at: string }>).map((s) => ({ id: s.id, status: "done" as const, createdAt: s.created_at }));
    const earlierWork = earlierWorkOf(planRounds({ steps: earlierDone, goalHistory }).earlier);
    // Its fields in the order get() and planForPage give them.
    const plan: WorkerPlanDto = row
      ? { workerId, goal: row.goal, conclusion: row.conclusion, openQuestions: JSON.parse(row.open_questions) as string[], steps, goalHistory: [], updatedAt: row.updated_at }
      : { ...emptyPlan(workerId), steps, goalHistory: [] };
    return { ...plan, earlierWork };
  }

  /** Every active plan as the page is sent it (pagePlan), in id order. */
  pagePlansOfActive(): WorkerPlanDto[] {
    return this.activeIds().map((workerId) => this.pagePlan(workerId));
  }

  /** `current`: the plan as the caller has just read it (get), so it is not
   *  read twice. */
  update(workerId: string, input: PlanUpdateInput, current: WorkerPlanDto = this.get(workerId)): PlanUpdateResult {
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
      // changes nothing leaves a worker with no plan exactly as it was.
      let hasRow = current.updatedAt !== null;
      const ensureRow = () => {
        if (hasRow) return;
        this.db.prepare(`insert into worker_plans (worker_id, open_questions, next_step_id, updated_at) values (?, '[]', 1, ?)`).run(workerId, at);
        hasRow = true;
      };
      this.writeFields(workerId, current, { ...input, openQuestions }, at, ensureRow, changes.fields);
      for (const id of new Set(input.delete ?? [])) {
        this.db.prepare(`delete from worker_plan_steps where worker_id = ? and id = ?`).run(workerId, id);
        changes.deleted.push(id);
      }
      // Steps placed after the same step in one call keep the order given:
      // each goes after the one placed there before it.
      const placedAfter = new Map<number, number>();
      for (const patch of input.steps ?? []) {
        if (patch.id === undefined) {
          ensureRow();
          changes.added.push(this.insertStep(workerId, patch, placedAfter, at));
          continue;
        }
        const line = this.patchStep(workerId, { ...patch, id: patch.id }, placedAfter, at);
        if (line) changes.steps.push(line);
      }
      if (changes.fields.length + changes.added.length + changes.steps.length + changes.deleted.length > 0) {
        this.db.prepare(`update worker_plans set updated_at = ? where worker_id = ?`).run(at, workerId);
      }
      // Immediate: it reads before it writes, and a deferred transaction fails
      // outright when another connection (an agent's sqlite3) commits between.
    }).immediate();

    const plan = this.get(workerId);
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
    workerId: string,
    current: WorkerPlanDto,
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
      if (current.goal) this.db.prepare(`insert into worker_plan_goal_history (worker_id, goal, changed_at) values (?, ?, ?)`).run(workerId, current.goal, at);
      this.db.prepare(`update worker_plans set goal = ? where worker_id = ?`).run(goal, workerId);
      changed.push("goal");
    }
    if (conclusion !== undefined && conclusion !== current.conclusion) {
      ensureRow();
      this.db.prepare(`update worker_plans set conclusion = ? where worker_id = ?`).run(conclusion, workerId);
      changed.push("conclusion");
    }
    if (input.openQuestions !== undefined && JSON.stringify(input.openQuestions) !== JSON.stringify(current.openQuestions)) {
      ensureRow();
      this.db.prepare(`update worker_plans set open_questions = ? where worker_id = ?`).run(JSON.stringify(input.openQuestions), workerId);
      changed.push("open questions");
    }
  }

  /** A new step, numbered from the plan's counter; its id. */
  private insertStep(workerId: string, patch: PlanStepPatch, placedAfter: Map<number, number>, at: string): number {
    const next = (this.db.prepare(`select next_step_id from worker_plans where worker_id = ?`).get(workerId) as { next_step_id: number }).next_step_id;
    this.db.prepare(`update worker_plans set next_step_id = ? where worker_id = ?`).run(next + 1, workerId);
    const position = this.positionFor(workerId, anchorFor(placedAfter, patch.after));
    if (patch.after !== undefined) placedAfter.set(patch.after, next);
    const status = patch.status ?? "pending";
    this.db.prepare(
      `insert into worker_plan_steps (worker_id, id, position, title, status, note, created_at, started_at, blocked_at, completed_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(workerId, next, position, patch.title!.trim(), status, patch.note?.trim() || null, at,
      status === "in_progress" || status === "done" ? at : null,
      status === "blocked" ? at : null,
      status === "done" ? at : null, at);
    return next;
  }

  /** An existing step changed or moved; its summary line, or null when the
   *  patch leaves it as it was. */
  private patchStep(workerId: string, patch: PlanStepPatch & { id: number }, placedAfter: Map<number, number>, at: string): string | null {
    const before = this.db.prepare(`select * from worker_plan_steps where worker_id = ? and id = ?`).get(workerId, patch.id) as StepRow;
    const title = patch.title !== undefined ? patch.title.trim() : before.title;
    const note = patch.note !== undefined ? (patch.note.trim() || null) : before.note;
    const status = patch.status ?? before.status;
    const anchor = anchorFor(placedAfter, patch.after);
    const moves = anchor !== undefined && this.predecessorOf(workerId, before) !== anchor;
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
    const position = moves ? this.positionFor(workerId, anchor, patch.id) : before.position;
    this.db.prepare(
      `update worker_plan_steps set title = ?, note = ?, status = ?, started_at = ?, blocked_at = ?, completed_at = ?, position = ?, updated_at = ?
       where worker_id = ? and id = ?`
    ).run(title, note, status, startedAt, blockedAt, completedAt, position, at, workerId, patch.id);
    const edited = title !== before.title || note !== before.note || moves;
    return `#${patch.id} ${[status !== before.status ? status.replace("_", " ") : "", edited ? "edited" : ""].filter(Boolean).join(", ")}`;
  }

  /** The step right before `step` in plan order (position, then id), or
   *  undefined for the first. */
  private predecessorOf(workerId: string, step: Pick<StepRow, "id" | "position">): number | undefined {
    // A step sharing its position comes first by id; otherwise the last one
    // before it. Two reads, each a range of the order index.
    const tied = this.db.prepare(
      `select id from worker_plan_steps indexed by idx_worker_plan_steps_order
       where worker_id = ? and position = ? and id < ? order by id desc limit 1`
    ).get(workerId, step.position, step.id) as { id: number } | null;
    if (tied) return tied.id;
    const row = this.db.prepare(
      `select id from worker_plan_steps where worker_id = ? and position < ? order by position desc, id desc limit 1`
    ).get(workerId, step.position) as { id: number } | null;
    return row?.id;
  }

  /** The position a step takes: after `after` (between it and the step that
   *  follows it), or at the end — writing no other step. Only when no whole
   *  number is left between the two are the plan's positions spread out
   *  again in tens. `moving`: the step being moved, which is not in its own way. */
  private positionFor(workerId: string, after: number | undefined, moving?: number): number {
    if (after === undefined) {
      // The last two by position: the step being moved may be one of them.
      const last = this.db.prepare(`select id, position from worker_plan_steps where worker_id = ? order by position desc limit 2`)
        .all(workerId) as Array<{ id: number; position: number }>;
      return (last.find((r) => r.id !== moving)?.position ?? 0) + 10;
    }
    const anchor = this.db.prepare(`select position from worker_plan_steps where worker_id = ? and id = ?`).get(workerId, after) as { position: number };
    // A step sharing the anchor's position, after it by id, leaves no room.
    const tied = this.db.prepare(
      `select 1 from worker_plan_steps indexed by idx_worker_plan_steps_order
       where worker_id = ? and position = ? and id > ? and id != ? limit 1`
    ).get(workerId, anchor.position, after, moving ?? -1);
    const next = tied ? null : this.db.prepare(
      `select position from worker_plan_steps where worker_id = ? and position > ? and id != ? order by position limit 1`
    ).get(workerId, anchor.position, moving ?? -1) as { position: number } | null;
    if (!tied && !next) return anchor.position + 10;
    if (next && next.position - anchor.position >= 2) return Math.floor((anchor.position + next.position) / 2);
    const order = (this.db.prepare(`select id from worker_plan_steps where worker_id = ? order by position, id`).all(workerId) as Array<{ id: number }>)
      .map((r) => r.id).filter((id) => id !== moving);
    const renumber = this.db.prepare(`update worker_plan_steps set position = ? where worker_id = ? and id = ?`);
    order.forEach((id, i) => renumber.run((i + 1) * 10, workerId, id));
    return (order.indexOf(after) + 1) * 10 + 5;
  }
}
