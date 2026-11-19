import { afterEach, expect, test } from "bun:test";
import { createSkillNudge, finishedWork, SKILL_NUDGE_NOTE, type EndedTurn } from "../src/server/modules/skills/skill-nudge.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { runCleanups } from "./helpers/cleanup.js";

afterEach(() => runCleanups());

const turn = (over: Partial<EndedTurn> = {}): EndedTurn => ({ status: "finished", scope: "manager", duty: false, toolNames: [], workDone: false, ...over });
const tools = (n: number, name = "bash") => Array.from({ length: n }, () => name);

test("a finished piece of work is a manager's or the personal agent's turn that a worker's done report reached, or that made ten tool calls", () => {
  expect(finishedWork(turn({ workDone: true }))).toBe(true);
  expect(finishedWork(turn({ scope: "personal", toolNames: tools(10) }))).toBe(true);
  expect(finishedWork(turn({ toolNames: tools(9) }))).toBe(false);
  // Not one: a duty round, a worker's or a subagent's turn, a turn that did not finish.
  expect(finishedWork(turn({ workDone: true, duty: true }))).toBe(false);
  expect(finishedWork(turn({ workDone: true, scope: "worker" }))).toBe(false);
  expect(finishedWork(turn({ workDone: true, scope: "subagent" }))).toBe(false);
  for (const status of ["error", "canceled", "stuck", "cut_off"] as const) expect(finishedWork(turn({ workDone: true, status }))).toBe(false);
  // Nor one that already asked for a review or changed a skill.
  expect(finishedWork(turn({ toolNames: [...tools(10), "request_skill_review"] }))).toBe(false);
  expect(finishedWork(turn({ workDone: true, toolNames: ["manage_skill"] }))).toBe(false);
});

function nudge(ended: EndedTurn | null, reply: Array<{ toolName: string; args: unknown }>) {
  const sent: Array<{ messages: unknown[]; tools: unknown; system: unknown }> = [];
  const requested: Array<{ threadId: string; wakeId: string; call: unknown }> = [];
  const candidate = { model: {} };
  const job = createSkillNudge({
    endedTurn: () => ended,
    stepPromptFor: async () => ({
      system: "the system", tools: { request_skill_review: {}, bash: {} },
      candidates: [candidate], messagesFor: () => [{ role: "user", content: "the work" }, { role: "assistant", content: "Done." }]
    }) as never,
    send: async (input) => {
      sent.push({ messages: input.messages, tools: input.tools, system: input.system });
      return { toolCalls: reply.map((c, i) => ({ toolCallId: `c${i}`, toolName: c.toolName, args: c.args })) };
    },
    requestReview: async (threadId, wakeId, call) => { requested.push({ threadId, wakeId, call }); }
  });
  return { job, sent, requested };
}

test("after a finished piece of work, one call on the thread's own prompt with the note after it; only its review request is carried out", async () => {
  const n = nudge(turn({ workDone: true }), [
    { toolName: "bash", args: { command: "ls" } },
    { toolName: "request_skill_review", args: { thread: "wkr_1", focus: "the release steps" } }
  ]);
  await n.job.afterTurn("thr_m", { wakeId: "wake_1", status: "finished" });
  expect(n.sent).toHaveLength(1);
  expect(n.sent[0]!.system).toBe("the system");
  expect(n.sent[0]!.messages).toEqual([
    { role: "user", content: "the work" }, { role: "assistant", content: "Done." },
    { role: "user", content: [{ type: "text", text: SKILL_NUDGE_NOTE }] }
  ]);
  expect(n.requested).toEqual([{ threadId: "thr_m", wakeId: "wake_1", call: { toolCallId: "c1", toolName: "request_skill_review", args: { thread: "wkr_1", focus: "the release steps" } } }]);
});

test("a turn that is not a finished piece of work sends nothing", async () => {
  const n = nudge(turn({ toolNames: tools(3) }), []);
  await n.job.afterTurn("thr_m", { wakeId: "wake_1", status: "finished" });
  expect(n.sent).toEqual([]);
  const gone = nudge(null, []);
  await gone.job.afterTurn("thr_x", { wakeId: "wake_2", status: "finished" });
  expect(gone.sent).toEqual([]);
});

test("the note is word for word", () => {
  expect(SKILL_NUDGE_NOTE).toBe("[runtime_context]\nThe work above is finished. If this kind of work will come back and no skill covers it yet, or it taught something a skill does not hold, call `request_skill_review` for the conversation where it was done. Otherwise do nothing: no reply is needed.");
});

test("a wake's tool calls are read back by name, from its own rows", () => {
  const env = freshStoresEnv("md-skill-nudge-");
  const thread = env.agentStore.createManagerThread("Releases");
  const wake = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  for (const toolName of ["bash", "read_plan", "bash"]) {
    env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "tool", wakeId: wake.id, content: { type: "tool_result", toolCallId: `c-${toolName}`, toolName, result: "ok" } } as never);
  }
  expect(env.agentStore.toolNamesOfWake(thread.id, wake.id)).toEqual(["bash", "read_plan", "bash"]);
});
