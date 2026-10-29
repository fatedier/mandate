import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// How each layer is told to ask. These read the texts as they must stand:
// each new passage is there, and what it replaced is gone. Line breaks are not part of a prompt's
// wording: both sides are compared with their whitespace run together.

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const read = (path: string) => flat(readFileSync(path, "utf8"));
const manager = read("src/server/modules/agent/prompts/manager.md");
const worker = read("src/server/modules/agent/prompts/worker.md");
const global = read("src/server/modules/global/prompts/global.md");

function says(text: string, passages: string[], gone: string[]) {
  for (const passage of passages) expect(text).toContain(flat(passage));
  for (const old of gone) expect(text).not.toContain(flat(old));
}

test("what a few commands finish is done where it was asked; code and sustained work go on to a thread or a worker", () => {
  says(global, [
    "What a few commands finish, you do yourself. Anything more you do not do here and do not discuss at length: you send it to a thread, follow it to its result, and bring back what the user needs.",
    "- Do what the user asks when a few commands finish it and it changes no project's code (removing containers or files they named, for one): run it with `bash`, check that it took, and say in a line what you did. Something irreversible you do only when the user asked for it in so many words.",
    "Work past that goes to a thread: a change to a repository's code, an investigation, anything sustained.",
    "- You do not change the projects' code. A change to a repository is work for a thread: do not create, edit or delete files in a repository yourself,",
    "- You do no sustained work yourself. A question or a task a few commands settle is yours; past that it goes to a thread."
  ], [
    "You do not do the work yourself",
    "Work that needs more than looking goes to a thread",
    "You do not change the projects.",
    "delete files in a project yourself",
    "A question a few commands settle is yours"
  ]);
  says(manager, [
    `When the user asks for work, infer the project from their words (use
\`list_projects\`); ask only when you cannot tell. What a few commands finish
and touches no code, do yourself with \`bash\`. For the rest, start a worker
with \`create_feature\` and give it the work with \`feature_message_send\`.`,
    `- For triage, read-only queries ("find all TODOs in project X") and small
  tasks a few commands finish, \`bash\` and \`read\` are fine — no dispatch needed.`
  ], [
    "Then start a worker with `create_feature`",
    "For triage / read-only queries"
  ]);
});

test("the manager is told a worker's question is its own first, and that what is the user's goes to them with ask_user", () => {
  says(manager, [
    "1. `dismiss_work_item(id, reason?)` — clear the open questions in a worker's plan that no longer need an answer",
    "- `done` — it finished its plan: every step done, no open question.",
    "never because a report said done.",
    `A worker's question is not a flag: it is an open question in its plan, and it
reaches you as a report the moment the worker writes it.`,
    `**Worker reports.** When a worker's wake ends in a new state, or the moment it
writes a question into its plan, a`,
    // The report's form stays as it was.
    "`[Worker report] <feature> (<id>, project <name>): <state> — <line>` message arrives and wakes you.",
    `- \`input\` — it asked a question (the line is the question). The worker is
  still in its turn: it may go on with other work, or stop and wait for the answer.`,
    `(\`feature_message_send\`), nudge it on, start the next piece of work, or tell
the user. A worker's question comes to you first. Answer it now if you can; if it is the
user's to decide, ask them with \`ask_user\` and send the worker their answer.
Do not leave it unanswered and unasked: the worker waits on you. For a \`stopped\` worker,`,
    `Otherwise act without writing anything. A decision that is theirs goes to them
with \`ask_user\`, not in the running text of a reply: a question asked that way
is marked as waiting on them, and one written into a reply is not. Never answer
a question that asks the user's permission (push, publish, merge, delete,
anything outward-facing or irreversible): ask the user with \`ask_user\`, and
pass their answer to the worker in their exact words, in quotation marks.`,
    "`YOUR QUESTIONS TO THE USER` (what you asked and have no answer to yet)",
    "- Questions: `ask_user`, `withdraw_question` — put a decision to the user; it returns at once and their answer comes back as a message."
  ], [
    "update_work_item",
    "Work item `needsUser` field",
    "(null | review | input)",
    "clear needsUser when no longer needed",
    '`"input"` — the worker has an open question for the user',
    "tell the user to answer it in that worker's Chat"
  ]);
});

test("the worker is told its question goes to its manager at once, and what to do after asking", () => {
  says(worker, [
    `- Update the conclusion whenever the picture changes. Questions that need the
  manager or the user to decide go in \`openQuestions\`: the manager is told the
  moment you write one, and the answer arrives as a message. After asking, go
  on with what does not depend on the answer; when nothing is left, stop and
  wait. Do nothing that depends on it. Clear the question once it is answered.`,
    `canvas report; put the report's id in the step's note and the app links it.

A question you write is sent to the manager at once; any other change of your
state is told to it at the end of your turn. You do not need to tell it yourself.`,
    `- Ask for confirmation on destructive actions (rm, push, drop) with an open
  question in your plan, and wait for the answer.`
  ], [
    "You CANNOT set needsUser directly",
    "an open question asks the user for input",
    "that leaves an open question, while nothing is asked",
    "clearing the last question while `input` is asked",
    "Ask the user for confirmation on destructive actions"
  ]);
});

test("the agent is told a followed thread's question reaches it at once, and that it asks the user with ask_user", () => {
  says(global, [
    "- While you wait on a thread, a question its manager asks the user reaches you at once, with its suggested answers. It does not end the wait.",
    "- It needs a decision, or its manager asked the user one. When the user has decided this kind of question before",
    "tell the user in one line what you decided and on what. Otherwise ask them here with `ask_user`, with the thread's options and what it recommends; when they answer, pass it on in their words. If they answer in the thread instead, take your question back with `withdraw_question`.",
    "put the request to the user as it is, with `ask_user`, however they have decided such things before. You approve none of these yourself."
  ], [
    "Otherwise bring the question here with the options and what the thread recommends",
    "pass the request to the user as it is"
  ]);
});

// Worded in general terms: the work is seen through, and only what is the
// user's is put to them.
test("the manager and the agent see what they were given through to its end, and ask only what is the user's to decide", () => {
  const managerPassage = "See the work a thread was given through to its end: what it takes to finish it and to know it is right is part of it, so have that done and report it rather than asking the user's leave. Theirs to decide are a choice their request leaves open, work beyond what they asked for, and the outward or irreversible steps below; bring such a step to them once the work is finished and checked.";
  says(manager, [managerPassage], []);
  // Before the outward steps it points to.
  expect(manager.indexOf(flat(managerPassage))).toBeLessThan(manager.indexOf("Never answer a question that asks the user's permission"));
  const globalPassage = "- What follows from what the user asked is yours to settle: carry it to its end, decide what their request and their way of working make clear, and say in a line what you assumed. Ask them only what is theirs to decide: a choice their request leaves open, or something it does not cover.";
  says(global, [globalPassage], []);
  // Among what it does itself, right after doing what a few commands finish.
  const own = global.indexOf("- Do what the user asks when a few commands finish it");
  expect([own > -1, global.indexOf(flat(globalPassage)) > own, global.indexOf(flat(globalPassage)) < global.indexOf("## Matters")]).toEqual([true, true, true]);
});


test("Your agent runs in the foreground only what ends within seconds: the user cannot reach it while a command runs", () => {
  says(global, [
    "- You are one conversation: while a command runs in the foreground, the user cannot reach you. Run in the foreground only what ends within seconds. Anything that may take longer runs with `run_in_background` (you are woken when it ends), or goes to a subagent when it needs many commands. Say in a line what is running, and go on answering the user meanwhile."
  ], []);
});
