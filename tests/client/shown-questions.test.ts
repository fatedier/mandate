import { expect, test } from "bun:test";
import { shownQuestions } from "@/lib/shown-questions";
import { emptyPlan, type FeaturePlanDto } from "@shared/api/plans";
import { threadWorker } from "../helpers/client-builders.js";

const AT = "2026-01-12T14:00:00.000Z";
const own = [{ id: "q_1", question: "Push the branch?", options: [{ label: "Push now" }, { label: "Hold it" }], askedAt: AT }];

const plans = (...list: FeaturePlanDto[]) => new Map(list.map((p) => [p.featureId, p]));
const asks = threadWorker("evict", { state: "asking", asking: true });
const evictPlan = { ...emptyPlan("evict"), openQuestions: ["Keep the old flag as an alias?", "Ship behind a flag?"], updatedAt: AT };

// A worker's question goes to its manager first; the server says when it is
// the user's (its thread rests and its manager asked nothing). Then it stands
// above the thread's composer, named by its worker.
test("a worker's question the server lists as the user's stands above the composer, each named by its worker", () => {
  const shown = shownQuestions({ questions: [], workers: [asks, threadWorker("quiet")], plans: plans(evictPlan), askingWorkers: new Set(["evict"]) });
  expect(shown).toEqual([
    { id: "plan:evict:0", question: "Keep the old flag as an alias?", options: [], askedAt: AT, from: "evict" },
    { id: "plan:evict:1", question: "Ship behind a flag?", options: [], askedAt: AT, from: "evict" }
  ]);
});

test("a worker's question the server does not list is its manager's: none is shown", () => {
  expect(shownQuestions({ questions: [], workers: [asks], plans: plans(evictPlan), askingWorkers: new Set() })).toEqual([]);
  expect(shownQuestions({ questions: own, workers: [asks], plans: plans(evictPlan) })).toEqual(own);
});
