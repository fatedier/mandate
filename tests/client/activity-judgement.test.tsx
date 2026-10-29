import { afterAll, beforeAll, expect, test } from "bun:test";
import type { JudgementRecordDto, LlmCallSummaryDto } from "@shared/api-contracts";
import { LogRow } from "@/routes/activity/logs/LogRow";
import { JudgementBox } from "@/routes/activity/JudgementBox";
import { judgementOf } from "@/routes/activity/judgement";
import { aboutLine, answerLabel, answerMeaning, notUsedLine } from "@/routes/activity/ledger-copy";
import { mountAsync } from "../helpers/mount.js";

// A judgement's answer in Activity: a chip on its row, a card in its detail.
// The model's words (done, cannot, …) stay in its prompt; the screen names them.

// The times below read as UTC wherever the tests run.
let zone: string | undefined;
beforeAll(() => { zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone; process.env.TZ = "UTC"; });
afterAll(() => { process.env.TZ = zone; });

const NOW = Date.parse("2026-08-03T15:00:00.000Z");
const REQUEST: JudgementRecordDto = {
  options: ["done", "cannot", "working"],
  answer: "cannot",
  subject: { replySeq: 412, replyAt: "2026-08-03T14:05:00.000Z", handoffId: "hnd_Tq3wZr8Kp1", requestAt: "2026-08-03T13:50:00.000Z" },
  notUsed: "question_open"
};
const STOP: JudgementRecordDto = {
  options: ["decision", "result", "nothing"],
  answer: "decision",
  probabilities: { decision: 0.861, result: 0.09, nothing: 0.049 },
  subject: { replySeq: 77, replyAt: "2026-08-02T13:42:00.000Z" }
};
const REPEAT: JudgementRecordDto = {
  options: ["repeat", "new"],
  answer: "repeat",
  probabilities: { repeat: 0.93, new: 0.07 },
  subject: { memory: "Releases of alpha are cut every Friday.", similar: ["mem_Kd81pQz2", "mem_Wr4nT0bx"] }
};

function call(metadata: Record<string, unknown> | null, purpose = "manager_request_check"): LlmCallSummaryDto {
  return {
    id: "llm_1", purpose, scopeType: "agent_thread", scopeId: "thread-1",
    providerName: null, provider: "openai-compatible", model: "deepseek-v4.1-flash", baseURL: null, apiMode: null, requestHash: "req", responseHash: "res",
    request: null, response: null, output: null, usage: null, metadata,
    inputTokens: 3_812, outputTokens: 9, totalTokens: 3_821, reasoningTokens: null, cacheReadTokens: 0, cacheWriteTokens: null,
    status: "succeeded", error: null, startedAt: "2026-08-03T14:05:10.000Z", finishedAt: "2026-08-03T14:05:11.600Z", latencyMs: 1_600, ttftMs: null,
    createdAt: "2026-08-03T14:05:10.000Z", updatedAt: "2026-08-03T14:05:11.600Z", cost: null
  };
}

test("each choice has a name on screen and a sentence; a choice no copy knows shows itself", () => {
  expect(["done", "cannot", "working", "decision", "result", "nothing"].map(answerLabel))
    .toEqual(["Done", "Can't go on", "Still working", "Needs a decision", "Has a result", "Nothing for you"]);
  expect(["done", "cannot", "working", "decision", "result", "nothing"].map(answerMeaning)).toEqual([
    "The reply reports the request's work as finished.",
    "The reply says the work cannot go on, or waits for the user's answer or decision.",
    "The work goes on, or the reply is about other work.",
    "The reply cannot go further until the user chooses, approves or answers something.",
    "The reply hands the user finished work they asked for.",
    "The reply leaves the user nothing to decide or read."
  ]);
  expect([answerLabel("maybe"), answerMeaning("maybe"), answerLabel("constructor"), answerMeaning("constructor")]).toEqual(["maybe", null, "constructor", null]);
});

test("what it was about: the reply's time, and the request's; a day not today is named", () => {
  expect(aboutLine(REQUEST.subject, NOW)).toBe("About the reply at 14:05 to the request sent at 13:50");
  expect(aboutLine(STOP.subject, NOW)).toBe("About the reply at Aug 2 13:42");
});

// Memory repeat check: whether a memory extraction was about to store said
// anything the stored memories most like it did not.
test("a memory repeat check's choices, what each means, and the memory it was about", () => {
  expect(["repeat", "new"].map(answerLabel)).toEqual(["Already stored", "New"]);
  expect(["repeat", "new"].map(answerMeaning)).toEqual([
    "A stored memory already says what it says, so it was not stored.",
    "It says something no stored memory says, so it was stored."
  ]);
  expect(aboutLine(REPEAT.subject, NOW)).toBe("About the memory “Releases of alpha are cut every Friday.”, read beside 2 stored memories");
  expect(aboutLine({ memory: "Builds run nightly.", similar: ["mem_Kd81pQz2"] }, NOW)).toBe("About the memory “Builds run nightly.”, read beside 1 stored memory");
  expect(judgementOf({ judgement: REPEAT })).toEqual(REPEAT);
  for (const subject of [{ memory: 3, similar: [] }, { memory: "x", similar: "mem_1" }, { memory: "x", similar: [1] }, { memory: "x" }]) {
    expect(judgementOf({ judgement: { ...REPEAT, subject } })).toBeNull();
  }
});

test("why an answer was not used, for each reason", () => {
  expect((["stopped", "newer_reply", "question_open", "newer_verdict", "archived", "memory_changed"] as const).map(notUsedLine)).toEqual([
    "Not used: the thread stopped first, and its stop ended the wait.",
    "Not used: a newer reply came first.",
    "Not used: the thread waits for the user's answer.",
    "Not used: a newer reply's answer is kept.",
    "Not used: the thread was archived.",
    "Not used: a memory it was read beside changed meanwhile, so it was stored."
  ]);
  expect(judgementOf({ judgement: { ...REPEAT, notUsed: "memory_changed" } })).toEqual({ ...REPEAT, notUsed: "memory_changed" });
});

test("a call's record is read only when it holds an answer among its choices and what it was about", () => {
  expect(judgementOf({ kind: "chat", judgement: REQUEST })).toEqual(REQUEST);
  expect(judgementOf({ judgement: STOP })).toEqual(STOP);
  for (const broken of [
    null, {}, { judgement: null }, { judgement: "done" },
    { judgement: { ...REQUEST, answer: "finished" } },
    { judgement: { ...REQUEST, options: "done" } },
    { judgement: { ...REQUEST, subject: { replySeq: "412", replyAt: "2026-08-03T14:05:00.000Z" } } },
    { judgement: { ...REQUEST, subject: null } }
  ]) expect(judgementOf(broken)).toBeNull();
  // A reason or odds this screen cannot read are left out; the answer stays.
  expect(judgementOf({ judgement: { ...REQUEST, notUsed: "later_on" } })).toEqual({ ...REQUEST, notUsed: undefined });
  expect(judgementOf({ judgement: { ...STOP, probabilities: { decision: "high" } } })).toEqual({ ...STOP, probabilities: undefined });
  for (const odds of [{ decision: 1.2, result: -0.2, nothing: 0 }, { decision: Number.NaN }, { decision: Infinity }]) {
    expect(judgementOf({ judgement: { ...STOP, probabilities: odds } })).toEqual({ ...STOP, probabilities: undefined });
  }
});

test("a judgement's row names its answer in a chip, and says when it was not used", async () => {
  const { host } = await mountAsync(<ul><LogRow call={call({ judgement: REQUEST })} nowMs={NOW} selected={false} onOpen={() => {}} /></ul>);
  expect(host.querySelector("[data-log-answer]")?.textContent).toBe("Can't go on");
  expect(host.querySelector("[data-log-not-used]")?.textContent).toBe("Not used: the thread waits for the user's answer.");
  const used = await mountAsync(<ul><LogRow call={call({ judgement: STOP }, "manager_stop_check")} nowMs={NOW} selected={false} onOpen={() => {}} /></ul>);
  expect(used.host.querySelector("[data-log-answer]")?.textContent).toBe("Needs a decision");
  expect(used.host.querySelector("[data-log-not-used]") === null).toBe(true);
  // Any other call: neither.
  const step = await mountAsync(<ul><LogRow call={call({ wakeId: "wake_1" }, "agent_wake_step")} nowMs={NOW} selected={false} onOpen={() => {}} /></ul>);
  expect([step.host.querySelector("[data-log-answer]") === null, step.host.querySelector("[data-log-not-used]") === null]).toEqual([true, true]);
});

test("the call's card shows every choice, the answer marked, what it means, what it was about, and why it was not used", async () => {
  const { host } = await mountAsync(<JudgementBox record={REQUEST} nowMs={NOW} />);
  // A list, said so: without its markers Safari reads an unmarked list as a group.
  expect(host.querySelector("ul")?.getAttribute("role")).toBe("list");
  const choices = Array.from(host.querySelectorAll("[data-judgement-choice]"));
  expect(choices.map((c) => [c.textContent, c.getAttribute("aria-current")])).toEqual([["Done", null], ["Can't go on", "true"], ["Still working", null]]);
  expect(host.querySelector("[data-judgement-meaning]")?.textContent).toBe("The reply says the work cannot go on, or waits for the user's answer or decision.");
  expect(host.querySelector("[data-judgement-about]")?.textContent).toBe("About the reply at 14:05 to the request sent at 13:50");
  expect(host.querySelector("[data-judgement-not-used]")?.textContent).toBe("Not used: the thread waits for the user's answer.");
  expect(host.textContent).toContain("Answer");
});

test("a decision model's card gives each choice its odds; a used answer has no not-used line", async () => {
  const { host } = await mountAsync(<JudgementBox record={STOP} nowMs={NOW} />);
  expect(Array.from(host.querySelectorAll("[data-judgement-choice]")).map((c) => c.textContent))
    .toEqual(["Needs a decision86%", "Has a result9%", "Nothing for you5%"]);
  expect(host.querySelector("[data-judgement-not-used]") === null).toBe(true);
});

test("a choice with no odds of its own shows none, whatever its name", async () => {
  const odd: JudgementRecordDto = { options: ["constructor", "toString"], answer: "constructor", probabilities: { toString: 0.4 }, subject: STOP.subject };
  const { host } = await mountAsync(<JudgementBox record={odd} nowMs={NOW} />);
  expect(Array.from(host.querySelectorAll("[data-judgement-choice]")).map((c) => c.textContent)).toEqual(["constructor", "toString40%"]);
});
