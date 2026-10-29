import { expect, test } from "bun:test";
import { buildQuestionTools } from "../src/server/modules/agent/tools/question-tools.js";
import type { OpenQuestion } from "../src/shared/questions.js";
import { toolContext } from "./helpers/typed.js";

const ASK_DESCRIPTION = [
  "Ask the user a question. It is shown above their composer until they answer, and it is marked as waiting on them. The call returns at once and does not end your turn; the answer comes as an ordinary message from the user, in this turn if you are still working, otherwise it wakes you.",
  "",
  "Ask only what is theirs to decide and you cannot settle from what they have said or saved: what you can decide, decide, and say what you assumed. One question per call, in a sentence or two that can be answered without reading anything else. When the likely answers are few, give two to four as `options`, the one you recommend first; the user can always type something else.",
  "",
  "After asking, do what does not depend on the answer, then stop. Do nothing that depends on it, and never treat your own guess as their answer. When you no longer need the answer, take the question back with `withdraw_question`."
].join("\n");

const WITHDRAW_DESCRIPTION = "Take back a question you asked with `ask_user` and no longer need answered, because the work settled it or it stopped mattering. The user's answer closes a question by itself; this is only for one nobody needs to answer any more.";

function setup(open: OpenQuestion[] = []) {
  const asked: Array<{ threadId: string; question: OpenQuestion }> = [];
  const tools = buildQuestionTools({
    openQuestions: () => open,
    onAsked: (threadId, question) => asked.push({ threadId, question })
  });
  const byName = (name: string) => tools.find((t) => t.name === name)!;
  /** As the dispatcher calls a tool: the arguments through its schema first. */
  const call = async (name: string, args: unknown, threadId = "thr_1") => {
    const tool = byName(name);
    return tool.handler(tool.parameters.parse(args), toolContext({ threadId })) as Promise<{ questionId: string } & Record<string, unknown>>;
  };
  return { tools, byName, call, asked };
}

test("the two tools, by name, with the words the model is given", () => {
  const { tools, byName } = setup();
  expect(tools.map((t) => t.name)).toEqual(["ask_user", "withdraw_question"]);
  expect(byName("ask_user").description).toBe(ASK_DESCRIPTION);
  expect(byName("withdraw_question").description).toBe(WITHDRAW_DESCRIPTION);
});

test("asking returns at once with a short id, and gives back what was asked", async () => {
  const { call, asked } = setup();
  const options = [{ label: "Push now", description: "The tests pass." }, { label: "Hold it" }];
  const first = await call("ask_user", { question: "  Push the branch?  ", options });
  expect(first).toEqual({ asked: true, questionId: first.questionId, question: "Push the branch?", options });
  expect(first.questionId).toMatch(/^q_[a-z0-9]{6}$/);
  const second = await call("ask_user", { question: "Tag it too?" });
  expect(second).toEqual({ asked: true, questionId: second.questionId, question: "Tag it too?", options: [] });
  expect(second.questionId).not.toBe(first.questionId);
  // Whoever follows this conversation is told at once.
  expect(asked.map((a) => [a.threadId, a.question.id, a.question.question, a.question.options.length])).toStrictEqual([
    ["thr_1", first.questionId, "Push the branch?", 2],
    ["thr_1", second.questionId, "Tag it too?", 0]
  ]);
});

test("what cannot be shown as a question is refused before anything is asked", () => {
  const { byName } = setup();
  const ask = byName("ask_user").parameters;
  const two = [{ label: "Yes" }, { label: "No" }];
  const cases: Array<[string, unknown, boolean]> = [
    ["a plain question", { question: "Push?" }, true],
    ["two options", { question: "Push?", options: two }, true],
    // A model that fills every field sends an empty list for "none".
    ["an empty list of options", { question: "Push?", options: [] }, true],
    ["four options", { question: "Push?", options: [...two, { label: "Later" }, { label: "Never" }] }, true],
    ["a question at the limit", { question: "x".repeat(2000) }, true],
    ["a label and a description at their limits", { question: "Push?", options: [{ label: "x".repeat(80), description: "y".repeat(200) }, { label: "No" }] }, true],
    ["no question", { question: "   " }, false],
    ["a question over the limit", { question: "x".repeat(2001) }, false],
    ["one option", { question: "Push?", options: [{ label: "Yes" }] }, false],
    ["five options", { question: "Push?", options: [...two, { label: "a" }, { label: "b" }, { label: "c" }] }, false],
    ["an empty label", { question: "Push?", options: [{ label: " " }, { label: "No" }] }, false],
    ["a label over the limit", { question: "Push?", options: [{ label: "x".repeat(81) }, { label: "No" }] }, false],
    ["a label of two lines", { question: "Push?", options: [{ label: "Yes\nplease" }, { label: "No" }] }, false],
    ["a description over the limit", { question: "Push?", options: [{ label: "Yes", description: "y".repeat(201) }, { label: "No" }] }, false],
    ["the same label twice", { question: "Push?", options: [{ label: "Yes" }, { label: "yes " }] }, false],
    ["a field it does not have", { question: "Push?", urgent: true }, false]
  ];
  for (const [name, args, ok] of cases) expect([name, ask.safeParse(args).success]).toEqual([name, ok]);
});

test("a question is taken back by its id, and only one that is open in this conversation", async () => {
  const open: OpenQuestion[] = [{ id: "q_abc123", question: "Push?", options: [], askedAt: "2026-01-12T14:00:00.000Z" }];
  const seen: string[] = [];
  const tools = buildQuestionTools({ openQuestions: (threadId) => { seen.push(threadId); return open; } });
  const withdraw = tools.find((t) => t.name === "withdraw_question")!;
  const run = (questionId: string) => withdraw.handler(withdraw.parameters.parse({ questionId }), toolContext({ threadId: "thr_7" }));
  expect(await run("q_abc123")).toEqual({ withdrawn: true, questionId: "q_abc123" });
  expect(await run("q_zzz999")).toEqual({ error: "not an open question of this conversation: q_zzz999" });
  expect(seen).toStrictEqual(["thr_7", "thr_7"]);
});

test("a question taken back is said so to whoever follows the conversation; one that is not open is not", async () => {
  const open: OpenQuestion[] = [{ id: "q_abc123", question: "Push?", options: [], askedAt: "2026-01-12T14:00:00.000Z" }];
  const withdrawn: unknown[] = [];
  const tools = buildQuestionTools({ openQuestions: () => open, onWithdrawn: (threadId, question) => withdrawn.push([threadId, question]) });
  const withdraw = tools.find((t) => t.name === "withdraw_question")!;
  await withdraw.handler(withdraw.parameters.parse({ questionId: "q_zzz999" }), toolContext({ threadId: "thr_7" }));
  expect(withdrawn).toStrictEqual([]);
  await withdraw.handler(withdraw.parameters.parse({ questionId: "q_abc123" }), toolContext({ threadId: "thr_7" }));
  expect(withdrawn).toStrictEqual([["thr_7", open[0]]]);
});

test("the question is Markdown, drawn as the agent's replies are, with literal paths and commands in backticks", () => {
  const { byName } = setup();
  const shape = (byName("ask_user").parameters as unknown as { shape: Record<string, { description?: string }> }).shape;
  expect(shape.question!.description).toBe("The question as the user will read it, in their language. Markdown, drawn as your replies are: put paths, commands and patterns in backticks.");
});
