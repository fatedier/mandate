import { randomInt } from "node:crypto";
import { z } from "zod";
import {
  ASK_TOOL, WITHDRAW_TOOL,
  type OpenQuestion, type QuestionOption
} from "../../../../shared/questions.js";
import type { ToolDefinition } from "../tool-registry.js";
import { askParams, withdrawParams } from "./question-tools-schema.js";

const ASK_DESCRIPTION = [
  "Ask the user a question. It is shown above their composer until they answer, and it is marked as waiting on them. The call returns at once and does not end your turn; the answer comes as an ordinary message from the user, in this turn if you are still working, otherwise it wakes you.",
  "",
  "Ask only what is theirs to decide and you cannot settle from what they have said or saved: what you can decide, decide, and say what you assumed. One question per call, in a sentence or two that can be answered without reading anything else. When the likely answers are few, give two to four as `options`, the one you recommend first; the user can always type something else.",
  "",
  "After asking, do what does not depend on the answer, then stop. Do nothing that depends on it, and never treat your own guess as their answer. When you no longer need the answer, take the question back with `withdraw_question`."
].join("\n");

const WITHDRAW_DESCRIPTION = "Take back a question you asked with `ask_user` and no longer need answered, because the work settled it or it stopped mattering. The user's answer closes a question by itself; this is only for one nobody needs to answer any more.";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Short enough for a model to copy back when it takes a question back. */
function newQuestionId(): string {
  return `q_${Array.from({ length: 6 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("")}`;
}

interface QuestionToolDeps {
  /** The questions open in a conversation now. */
  openQuestions: (threadId: string) => OpenQuestion[];
  /** A question was asked: whoever follows this conversation hears of it now. */
  onAsked?: (threadId: string, question: OpenQuestion) => void;
  /** A question was taken back: whoever heard of it hears that too. */
  onWithdrawn?: (threadId: string, question: OpenQuestion) => void;
}

type AskResult = { asked: true; questionId: string; question: string; options: QuestionOption[] };

/** How a manager or the personal agent asks the user. A question is its tool
 *  result and nothing else (shared/questions.ts): the result carries what was
 *  asked, so the conversation's rows alone say what is open. */
export function buildQuestionTools(deps: QuestionToolDeps): ToolDefinition[] {
  const ask: ToolDefinition<z.infer<typeof askParams>, AskResult> = {
    name: ASK_TOOL,
    description: ASK_DESCRIPTION,
    parameters: askParams,
    handler: async ({ question, options }, ctx) => {
      const asked: OpenQuestion = {
        id: newQuestionId(),
        question,
        options: (options ?? []).map((o) => (o.description ? { label: o.label, description: o.description } : { label: o.label })),
        askedAt: new Date().toISOString()
      };
      deps.onAsked?.(ctx.threadId, asked);
      return { asked: true, questionId: asked.id, question: asked.question, options: asked.options };
    }
  };
  const withdraw: ToolDefinition<z.infer<typeof withdrawParams>, { withdrawn: true; questionId: string } | { error: string }> = {
    name: WITHDRAW_TOOL,
    description: WITHDRAW_DESCRIPTION,
    parameters: withdrawParams,
    handler: async ({ questionId }, ctx) => {
      const question = deps.openQuestions(ctx.threadId).find((q) => q.id === questionId);
      if (!question) return { error: `not an open question of this conversation: ${questionId}` };
      deps.onWithdrawn?.(ctx.threadId, question);
      return { withdrawn: true, questionId };
    }
  };
  return [ask, withdraw] as ToolDefinition[];
}
