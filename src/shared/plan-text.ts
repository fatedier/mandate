import { PLAN_LIMITS, type FeaturePlanDto, type PlanStepDto } from "./api/plans.js";
import { FEATURE_STATE_LABEL, featureStateFor, planProgress, type FailureKind } from "./feature-state.js";
import { planRounds } from "./plan-rounds.js";

/** Characters as a reader counts them: a CJK character or an emoji is one. */
export function charLength(text: string): number {
  return [...text].length;
}

/** Every open step and the most recently completed ones, in plan order; the
 *  rest of the done steps become a count. */
export function foldSteps(steps: PlanStepDto[], recentDone: number = PLAN_LIMITS.recentDone): { shown: PlanStepDto[]; earlierDone: number } {
  const done = steps.filter((s) => s.status === "done");
  const recent = new Set(
    [...done]
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "") || b.id - a.id)
      .slice(0, recentDone)
      .map((s) => s.id)
  );
  return { shown: steps.filter((s) => s.status !== "done" || recent.has(s.id)), earlierDone: done.length - recent.size };
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

/** Every field reads as one line: a line break of any kind in model-written
 *  text (`\n`, a lone `\r`, U+2028/2029, NEL) must not be able to pass for
 *  another step, question or feature. Whitespace runs collapse to one space. */
export function oneLine(text: string): string {
  return text.replace(/[\s\u0085]+/g, " ").trim();
}

function stepTag(step: PlanStepDto): string {
  switch (step.status) {
    case "done": return `done ${day(step.completedAt)}`.trim();
    case "blocked": return `blocked since ${day(step.blockedAt)}`.trim();
    case "in_progress": return step.startedAt ? `in_progress since ${day(step.startedAt)}` : "in_progress";
    case "pending": return `pending, added ${day(step.createdAt)}`;
  }
}

export function stepLine(step: PlanStepDto): string {
  const note = step.note?.trim() ? ` — ${oneLine(step.note)}` : "";
  return `  #${step.id} [${stepTag(step)}] ${oneLine(step.title)}${note}`;
}

/** A plan's head as a model reads it: its progress, goal, conclusion and
 *  open questions. */
export function planHeadLines(plan: FeaturePlanDto): string[] {
  const { done, total } = planProgress(plan);
  const lines = [total > 0 ? `Plan: ${done} of ${total} done` : "Plan: no steps yet"];
  if (plan.goal) lines.push(`Goal: ${oneLine(plan.goal)}`);
  if (plan.conclusion) lines.push(`Conclusion: ${oneLine(plan.conclusion)}`);
  if (plan.openQuestions.length > 0) lines.push("Open questions:", ...plan.openQuestions.map((q) => `- ${oneLine(q)}`));
  return lines;
}

/** The plan as a model reads it: in the worker's initial context and in
 *  read_plan's result (the reminder shows less: plan-reminder). */
export function renderPlanText(plan: FeaturePlanDto, opts: { includeHistory?: boolean } = {}): string {
  const history = opts.includeHistory ? plan.goalHistory : [];
  if (plan.steps.length === 0 && !plan.goal && !plan.conclusion && plan.openQuestions.length === 0 && history.length === 0) return "No plan yet.";
  const lines = planHeadLines(plan);
  const { current, earlier } = planRounds(plan);
  if (opts.includeHistory ? plan.steps.length > 0 : current.length > 0 || earlier.length > 0) {
    lines.push("Steps:");
    if (opts.includeHistory) {
      lines.push(...plan.steps.map(stepLine));
    } else {
      // The earlier goals' finished steps are one line; the current work is
      // listed, its own older done steps folded as before.
      if (earlier.length > 0) {
        const goals = earlier.length;
        const steps = earlier.reduce((n, round) => n + round.steps.length, 0);
        lines.push(`  (earlier work: ${goals} goal${goals === 1 ? "" : "s"}, ${steps} step${steps === 1 ? "" : "s"} done; read_plan with includeHistory lists ${steps === 1 ? "it" : "them"})`);
      }
      const { shown, earlierDone } = foldSteps(current);
      if (earlierDone > 0) {
        lines.push(`  (${earlierDone} step${earlierDone === 1 ? "" : "s"} done earlier; read_plan with includeHistory lists ${earlierDone === 1 ? "it" : "them"})`);
      }
      lines.push(...shown.map(stepLine));
    }
  }
  if (history.length > 0) {
    lines.push("Earlier goals:", ...history.map((g) => `- ${day(g.changedAt)}: ${oneLine(g.goal)}`));
  }
  return lines.join("\n");
}

/** One line per feature for the manager's briefing: what its last wake did
 *  when it failed or stopped, else what its plan says. */
export function planBriefLine(name: string, plan: FeaturePlanDto, failure: { at: string; kind: FailureKind } | null, running: boolean): string {
  const state = featureStateFor(plan, failure?.at ?? null, failure?.kind ?? null, running);
  const { done, total } = planProgress(plan);
  const head = `[${oneLine(name)} · ${FEATURE_STATE_LABEL[state]}${total > 0 ? ` · ${done}/${total}` : ""}]`;
  if (state === "planning") return `${head} ${plan.conclusion?.trim() ? oneLine(plan.conclusion) : "No plan yet"}`;
  const conclusion = plan.conclusion?.trim() ? oneLine(plan.conclusion) : "(no conclusion)";
  if (state === "asking" && plan.openQuestions[0]) return `${head} ${conclusion} — open question: ${oneLine(plan.openQuestions[0])}`;
  const blocked = plan.steps.find((s) => s.status === "blocked");
  if (state === "blocked" && blocked) return `${head} ${conclusion} — #${blocked.id} blocked since ${day(blocked.blockedAt)}: ${oneLine(blocked.title)}`;
  const now = plan.steps.find((s) => s.status === "in_progress");
  if (state === "in_progress" && now) return `${head} ${conclusion} — now #${now.id}: ${oneLine(now.title)}`;
  const next = plan.steps.find((s) => s.status === "pending");
  if (state === "paused" && next) return `${head} ${conclusion} — next #${next.id}: ${oneLine(next.title)}`;
  return `${head} ${conclusion}`;
}
