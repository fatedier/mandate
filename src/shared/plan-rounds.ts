import type { FeaturePlanDto, PlanStepDto } from "./api/plans.js";

/** The done steps written under one earlier goal. */
export interface PlanRound {
  goal: string;
  /** When the goal gave way to the next one. */
  changedAt: string;
  steps: PlanStepDto[];
}

/** The plan by the goal each step was written under. A worker changes its
 *  goal when it starts new work: the steps written from then on, and any step
 *  still open, are the current work; each earlier goal's done steps are a
 *  round of earlier work, oldest first, a goal with none left out. A step
 *  written in the call that changed the goal shares that change's time and
 *  serves the new goal. */
export function planRounds(plan: Pick<FeaturePlanDto, "steps"> & Partial<Pick<FeaturePlanDto, "goalHistory">>): { current: PlanStepDto[]; earlier: PlanRound[] } {
  // A plan read without its history is one never re-aimed.
  const history = plan.goalHistory ?? [];
  const lastChange = history.at(-1)?.changedAt ?? "";
  const current = plan.steps.filter((s) => s.status !== "done" || s.createdAt >= lastChange);
  const earlier = history.map((change, i) => {
    const from = history[i - 1]?.changedAt ?? "";
    return {
      goal: change.goal,
      changedAt: change.changedAt,
      steps: plan.steps.filter((s) => s.status === "done" && s.createdAt >= from && s.createdAt < change.changedAt)
    };
  }).filter((round) => round.steps.length > 0);
  return { current, earlier };
}

/** The plan as the page receives it: the current work, and earlier work as
 *  counts; the page reads the whole plan when earlier work is opened. What a
 *  push carries then grows with the current work, not with every step the
 *  worker ever wrote. */
export function planForPage(plan: FeaturePlanDto): FeaturePlanDto {
  const { current, earlier } = planRounds(plan);
  const steps = earlier.flatMap((round) => round.steps);
  return {
    ...plan,
    steps: current,
    goalHistory: [],
    earlierWork: steps.length > 0 ? { goals: earlier.length, steps: steps.length, lastStepId: Math.max(...steps.map((s) => s.id)) } : null
  };
}
