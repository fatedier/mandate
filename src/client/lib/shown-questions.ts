import type { ThreadWorker } from "@/hooks/useThreadWorkers";
import type { FeaturePlanDto } from "@shared/api/plans";
import type { OpenQuestion } from "@shared/questions";

/** A question that stands above a conversation's composer. */
export interface ShownQuestion extends OpenQuestion {
  /** The worker whose question it is: one nobody above it took up. */
  from?: string;
}

/** Who waits for the question's answer, as its block's head says it. */
export function questionHeading(question: Pick<ShownQuestion, "from">): string {
  return question.from ? `${question.from} is waiting for an answer` : "Needs your answer";
}

export interface ShownQuestionFacts {
  /** What was asked of the user in this conversation and is not answered. */
  questions: readonly OpenQuestion[];
  /** A manager thread's workers, and their plans. */
  workers?: readonly ThreadWorker[];
  plans?: ReadonlyMap<string, FeaturePlanDto>;
  /** The workers whose question the server lists as the user's: the thread
   *  rests and its manager asked nothing (Home lists them by the same rule). */
  askingWorkers?: ReadonlySet<string>;
}

/** The questions a conversation shows above its composer: its own, and in a
 *  manager's thread what those of its workers ask that are the user's to
 *  answer now. The user answers in the thread, and the manager passes it on.
 *  Pure, so which questions show is tested as data. */
export function shownQuestions(facts: ShownQuestionFacts): ShownQuestion[] {
  const own: ShownQuestion[] = [...facts.questions];
  const { workers = [], plans, askingWorkers } = facts;
  if (!askingWorkers) return own;
  for (const worker of workers) {
    if (!askingWorkers.has(worker.featureId)) continue;
    const plan = plans?.get(worker.featureId);
    (plan?.openQuestions ?? []).forEach((question, index) => {
      own.push({ id: `plan:${worker.featureId}:${index}`, question, options: [], askedAt: plan?.updatedAt ?? "", from: worker.name });
    });
  }
  return own;
}
