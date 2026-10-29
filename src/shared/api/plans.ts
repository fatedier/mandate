import type { ApiErrorResponse } from "./common.js";

/** A step's state. `blocked` means waiting on something outside the worker;
 *  its note says what. */
export type PlanStepStatus = "pending" | "in_progress" | "blocked" | "done";

export interface PlanStepDto {
  /** Per-feature sequence, never reused: `#1`, `#2`, … */
  id: number;
  title: string;
  status: PlanStepStatus;
  /** Free text with links: the result and evidence when done, what it waits
   *  on when blocked, the pane doing it. Null when never written. */
  note: string | null;
  createdAt: string;
  /** The first time the step became `in_progress`. */
  startedAt: string | null;
  /** When it last entered `blocked`; null when not blocked. */
  blockedAt: string | null;
  /** When it became `done`; null when not done. */
  completedAt: string | null;
  updatedAt: string;
}

export interface PlanGoalChangeDto {
  goal: string;
  changedAt: string;
}

/** Earlier work counted, in a plan sent to the page (planForPage): the
 *  earlier goals' finished steps come with the whole plan, read on request. */
export interface PlanEarlierWorkDto {
  goals: number;
  steps: number;
  /** The highest id among them: a note's `#N` up to the plan's last step
   *  names a step, not an issue. */
  lastStepId: number;
}

export interface FeaturePlanDto {
  featureId: string;
  goal: string | null;
  conclusion: string | null;
  openQuestions: string[];
  /** Every step, in plan order. Folding is the reader's job (see plan-text). */
  steps: PlanStepDto[];
  /** Earlier goals, oldest first; the current goal is not repeated here. */
  goalHistory: PlanGoalChangeDto[];
  /** Null when the feature has never had a plan written. */
  updatedAt: string | null;
  /** Set on a plan sent to the page: its steps are then the current work
   *  only, its goal history empty. Null there when there is no earlier work;
   *  absent on a whole plan. */
  earlierWork?: PlanEarlierWorkDto | null;
}

export const PLAN_LIMITS = {
  goal: 1000,
  conclusion: 300,
  openQuestions: 5,
  question: 300,
  title: 200,
  note: 2000,
  recentDone: 5
} as const;

export type FeaturePlanResponse = { plan: FeaturePlanDto } | ApiErrorResponse;

/** A worker's task record: its history, as memory extraction last rewrote it. */
export interface FeatureRecordDto {
  id: string;
  content: string;
  updatedAt: string;
}

export type FeatureRecordResponse = { record: FeatureRecordDto | null } | ApiErrorResponse;

export function emptyPlan(featureId: string): FeaturePlanDto {
  return { featureId, goal: null, conclusion: null, openQuestions: [], steps: [], goalHistory: [], updatedAt: null };
}
