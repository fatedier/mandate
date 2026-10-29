import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { waitUntil } from "./helpers/wait.js";
import { freshStoresEnv, seedFeature, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import { HandoffService } from "../src/server/modules/global/handoff-service.js";
import { createManagerRequestCheck } from "../src/server/modules/manager-checks/request/manager-request-check.js";
import type { JudgementInput, JudgementNotUsed, JudgementCandidate } from "../src/server/modules/manager-checks/judge.js";
import type { ManagerRequestCheckOutcome } from "../src/server/modules/manager-checks/request/answer.js";
import type { ThreadStop } from "../src/shared/thread-dot.js";
import { threadNoticeMetadata, type ThreadNotice } from "../src/shared/thread-notice.js";

// After a manager's turn, while its thread still works, each request Your
// agent waits on there is judged once against the turn's reply; one judged
// done (or cannot go on) ends alone.

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const CANDIDATE = { kind: "decision", baseURL: "https://gw.example/v1", apiKey: "k", model: "m" } as unknown as JudgementCandidate;

function setup(opts: { candidates?: JudgementCandidate[] } = {}) {
  env = freshStoresEnv("md-request-check-");
  const stops = new Map<string, ThreadStop>();
  const notices: Array<{ notice: ThreadNotice; lastReply: string | null }> = [];
  const busy = new Set<string>();
  let service!: HandoffService;
  const queue = new AgentUserMessageQueue({
    agentStore: env.agentStore,
    wakeScheduler: { wake: () => "wake-1", isThreadBusy: (id) => busy.has(id) },
    onMessageAppended: (threadId, message) => service.noteAppended(threadId, message)
  });
  service = new HandoffService({
    db: env.store.db, agentStore: env.agentStore, featuresStore: env.features, queue,
    stopOf: (id) => stops.get(id) ?? null,
    notify: (_g, notice, lastReply) => notices.push({ notice, lastReply })
  });
  const global = env.agentStore.getOrCreateGlobalThread();
  const thread = env.agentStore.createManagerThread("Docs overhaul");
  const projectId = seedProject(env.projects, { name: "m", workingDir: "/tmp/m", tmuxSessionName: "m" });
  const featureId = seedFeature(env.features, projectId, { name: "release", ownerThreadId: thread.id });
  // What the judge is asked, and what it answers: by the request's words.
  const answers = new Map<string, ManagerRequestCheckOutcome | null | Promise<ManagerRequestCheckOutcome | null>>();
  const asked: string[] = [];
  /** What each judgement was about, and each answer not acted on, by the request's words. */
  const subjects: Array<[string, JudgementInput["subject"]]> = [];
  const notUsed: Array<[string, JudgementNotUsed]> = [];
  const judge = async (_c: readonly JudgementCandidate[], input: JudgementInput) => {
    const request = input.context.split("\n")[1]!;
    asked.push(request);
    subjects.push([request, input.subject]);
    const answer = await (answers.get(request) ?? "working");
    return answer === null ? null : { answer, notUsed: (reason: JudgementNotUsed) => { notUsed.push([request, reason]); } };
  };
  const check = createManagerRequestCheck({
    agentStore: env.agentStore, handoffs: service,
    stopOf: (id) => stops.get(id) ?? null,
    candidates: () => opts.candidates ?? [CANDIDATE],
    judge
  });
  const send = (text: string) => service.sendToThread({ globalThreadId: global.id, threadId: thread.id, text, spoken: false });
  const reply = (text: string) => env!.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text, toolCalls: [] } });
  return { env, service, check, global, thread, featureId, stops, notices, busy, answers, asked, subjects, notUsed, send, reply };
}

test("a request judged done ends alone and tells Your agent, with the reply; the other waits on", async () => {
  const s = setup();
  const merge = s.send("Merge #41");
  const bedrock = s.send("Set up the build worker");
  s.reply("Merged #41. The build worker is still being set up.");
  s.answers.set("Merge #41", "done");
  s.check.noteTurnEnded(s.thread.id);
  await s.check.idle();
  expect(s.service.dto(merge.id)).toMatchObject({ state: "replied", stop: "done" });
  expect(s.service.dto(bedrock.id)!.state).toBe("delivered");
  expect(s.notices.map((n) => [n.notice.stop, n.notice.requests, n.lastReply])).toStrictEqual([
    ["done", ["Merge #41"], "Merged #41. The build worker is still being set up."]
  ]);
  // Each judgement says what it was about: the request, and the reply.
  const latest = s.env.agentStore.latestReply(s.thread.id)!;
  const row = (id: string) => s.service.dto(id)!;
  expect(Object.fromEntries(s.subjects)).toEqual({
    "Merge #41": { replySeq: latest.seq, replyAt: latest.createdAt, handoffId: merge.id, requestAt: row(merge.id).createdAt },
    "Set up the build worker": { replySeq: latest.seq, replyAt: latest.createdAt, handoffId: bedrock.id, requestAt: row(bedrock.id).createdAt }
  });
  // Done was acted on, working has nothing to act on: neither is marked.
  expect(s.notUsed).toStrictEqual([]);
});

test("working, or a judgement that failed, tells nothing", async () => {
  const s = setup();
  const sent = s.send("Merge #41");
  s.reply("Working on it.");
  s.answers.set("Merge #41", null);
  s.check.noteTurnEnded(s.thread.id);
  await s.check.idle();
  expect([s.service.dto(sent.id)!.state, s.notices.length]).toEqual(["delivered", 0]);
});

/** The thread's manager asks the user "Deploy now?", and Your agent is told. */
function askAndTell(s: ReturnType<typeof setup>) {
  s.env.agentStore.appendMessage({
    threadId: s.thread.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c_q", toolName: "ask_user", result: { asked: true, questionId: "q_1", question: "Deploy now?", options: [] } }
  });
  s.env.agentStore.appendMessage({
    threadId: s.global.id, role: "user", source: "thread-notice", sourceThreadId: s.thread.id,
    content: { type: "text", text: "[Thread notice] asked", metadata: threadNoticeMetadata({ handoffIds: [], kind: "thread", targetThreadId: s.thread.id, featureId: null, title: "Docs overhaul", stop: "asked", reason: null, question: { id: "q_1", text: "Deploy now?", options: [] } }) }
  });
}

/** A verdict the test hands back when it chooses. */
function held(s: ReturnType<typeof setup>, request: string): (outcome: ManagerRequestCheckOutcome) => void {
  let answer!: (outcome: ManagerRequestCheckOutcome) => void;
  s.answers.set(request, new Promise((resolve) => { answer = resolve; }));
  return (outcome) => answer(outcome);
}

test("cannot ends the wait; but not while Your agent was told of an open question from that thread", async () => {
  const s = setup();
  const sent = s.send("Deploy to prod");
  askAndTell(s);
  s.reply("Waiting for your go to deploy.");
  s.answers.set("Deploy to prod", "cannot");
  s.check.noteTurnEnded(s.thread.id);
  await s.check.idle();
  expect([s.service.dto(sent.id)!.state, s.notices.length]).toEqual(["delivered", 0]);
  expect(s.notUsed).toStrictEqual([["Deploy to prod", "question_open"]]);

  const t = setup();
  const other = t.send("Deploy to prod");
  t.reply("This needs a decision from the user before it can go on.");
  t.answers.set("Deploy to prod", "cannot");
  t.check.noteTurnEnded(t.thread.id);
  await t.check.idle();
  expect(t.service.dto(other.id)).toMatchObject({ state: "replied", stop: "cannot" });
  expect(t.notUsed).toStrictEqual([]);
});

test("done and cannot on one reply end in two notices", async () => {
  const s = setup();
  s.send("Merge #41");
  s.send("Deploy to prod");
  s.reply("Merged #41. Deploying needs your decision.");
  s.answers.set("Merge #41", "done");
  s.answers.set("Deploy to prod", "cannot");
  s.check.noteTurnEnded(s.thread.id);
  await s.check.idle();
  expect(s.notices.map((n) => [n.notice.stop, n.notice.requests])).toStrictEqual([["done", ["Merge #41"]], ["cannot", ["Deploy to prod"]]]);
});

test("one reply is judged once, however often the thread settles", async () => {
  const s = setup();
  s.send("Merge #41");
  s.reply("Working on it.");
  s.check.noteTurnEnded(s.thread.id);
  s.check.noteTurnEnded(s.thread.id);
  await s.check.idle();
  s.check.noteTurnEnded(s.thread.id);
  await s.check.idle();
  expect(s.asked).toStrictEqual(["Merge #41"]);
  // A new reply is judged again.
  s.reply("Still on it.");
  s.check.noteTurnEnded(s.thread.id);
  await s.check.idle();
  expect(s.asked).toStrictEqual(["Merge #41", "Merge #41"]);
});

test("a reply older than the request is not judged", async () => {
  const s = setup();
  s.reply("Merged #40.");
  s.send("Merge #41");
  s.check.noteTurnEnded(s.thread.id);
  await s.check.idle();
  expect(s.asked).toStrictEqual([]);
});

test("a verdict that comes back once the thread has stopped, before its waits are settled, ends nothing: the stop notice does", async () => {
  const s = setup();
  const sent = s.send("Merge #41");
  s.reply("Merged #41.");
  const answer = held(s, "Merge #41");
  s.check.noteTurnEnded(s.thread.id);
  // A later turn ends and the thread stops; its release has not settled the waits yet.
  s.stops.set(s.thread.id, "stopped");
  answer("done");
  await s.check.idle();
  expect([s.service.dto(sent.id)!.state, s.notices.length]).toEqual(["delivered", 0]);
  s.service.noteSettled(s.thread.id);
  expect(s.notices.map((n) => n.notice.stop)).toStrictEqual(["stopped"]);
  expect(s.notUsed).toStrictEqual([["Merge #41", "stopped"]]);
});

test("the user answering the open question while cannot is judged leaves the wait open", async () => {
  const s = setup();
  const sent = s.send("Deploy to prod");
  askAndTell(s);
  s.reply("Waiting for your go to deploy.");
  const answer = held(s, "Deploy to prod");
  s.check.noteTurnEnded(s.thread.id);
  s.env.agentStore.appendMessage({
    threadId: s.thread.id, role: "user", source: "user",
    content: { type: "text", text: "Yes, deploy.", metadata: { answers: [{ id: "q_1", question: "Deploy now?" }] } }
  });
  expect(s.service.questionToldOpen(s.thread.id)).toBe(false);
  answer("cannot");
  await s.check.idle();
  expect([s.service.dto(sent.id)!.state, s.notices.length]).toEqual(["delivered", 0]);
  expect(s.notUsed).toStrictEqual([["Deploy to prod", "question_open"]]);
});

test("words the turn went on after (endTurn false) are not the turn's reply", async () => {
  const s = setup();
  s.send("Merge #41");
  s.env.agentStore.appendMessage({ threadId: s.thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Merged #41, checking CI.", toolCalls: [], endTurn: false } });
  s.env.agentStore.appendMessage({ threadId: s.thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [] } });
  s.check.noteTurnEnded(s.thread.id);
  await s.check.idle();
  expect(s.asked).toStrictEqual([]);
});

test("a stopped thread, a worker's chat, or no models to ask: nothing is judged", async () => {
  const s = setup();
  s.send("Merge #41");
  s.reply("Merged.");
  s.stops.set(s.thread.id, "stopped");
  s.check.noteTurnEnded(s.thread.id);
  s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "Keep the install script", spoken: false });
  const worker = s.env.agentStore.getThreadByScope("worker", s.featureId)!;
  s.env.agentStore.appendMessage({ threadId: worker.id, role: "assistant", source: "self", content: { type: "assistant", text: "Kept.", toolCalls: [] } });
  s.check.noteTurnEnded(worker.id);
  await s.check.idle();
  expect(s.asked).toStrictEqual([]);

  const t = setup({ candidates: [] });
  t.send("Merge #41");
  t.reply("Merged.");
  t.check.noteTurnEnded(t.thread.id);
  await t.check.idle();
  expect(t.asked).toStrictEqual([]);
});

test("Your agent's prompt says a request may be answered sooner", () => {
  const prompt = fs.readFileSync("src/server/modules/global/prompts/global.md", "utf8");
  expect(prompt).toContain("A request to a thread may be answered sooner: when its manager says that request is done or cannot go on.");
});

/** A config whose Decisions route is on, with a decision model. */
const DECISIONS_CONFIG = {
  models: {
    default: { model: "gw/chat-1" },
    providers: { gw: { type: "openai-compatible", baseURL: "https://gw.example/v1", apiKey: "sk-test", models: [{ id: "chat-1", input: ["text"] }, { id: "vendor/judge-1", input: ["text"], kind: "decision" }] } }
  },
  agent: { decisionsEnabled: true, decisionsModel: { model: "gw/vendor/judge-1", reasoningEffort: "provider-default" } }
};

test("a request whose delivery is written late is judged once it is", async () => {
  env = freshStoresEnv("md-request-check-late-");
  fs.writeFileSync(path.join(env.dir, "config.json"), JSON.stringify(DECISIONS_CONFIG));
  const runtime = testAgentRuntime(env, { stepRetryDelaysMs: [300] });
  try {
    // The database refuses the first write that marks the request delivered.
    const noteAppended = runtime.handoffs.noteAppended.bind(runtime.handoffs);
    let refusals = 1;
    runtime.handoffs.noteAppended = (threadId, message) => {
      if (refusals-- > 0) throw new Error("database is locked");
      noteAppended(threadId, message);
    };
    const global = env.agentStore.getOrCreateGlobalThread();
    const followed = env.agentStore.createManagerThread("Docs overhaul");
    const sent = runtime.handoffs.sendToThread({ globalThreadId: global.id, threadId: followed.id, text: "Merge #41", spoken: false });
    const turn = env.agentStore.createWake({ threadId: followed.id, reason: "user", triggerMessageId: null });
    env.agentStore.appendMessage({ threadId: followed.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "Merged #41.", toolCalls: [] } });
    runtime.userMessageQueue.submitThreadUserMessage({ threadId: followed.id, content: "Also the API docs.", source: "user" });
    env.agentStore.finishWake(turn.id, "finished");
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    await deps.afterWakeReleasedHook!(followed.id);
    // When the turn ended the request was not yet marked delivered: nothing to judge then.
    expect(runtime.handoffs.dto(sent.id)!.state).toBe("queued");
    await waitUntil(() => env!.store.listLlmCalls(20).some((call) => call.purpose === "manager_request_check"), { timeout: 3000, label: "a manager_request_check attempt" });
  } finally {
    runtime.dispose();
  }
});

test("a request delivered late while its thread's turn still runs is judged when that turn is released", async () => {
  env = freshStoresEnv("md-request-check-late-running-");
  fs.writeFileSync(path.join(env.dir, "config.json"), JSON.stringify(DECISIONS_CONFIG));
  const runtime = testAgentRuntime(env, { stepRetryDelaysMs: [100] });
  try {
    const noteAppended = runtime.handoffs.noteAppended.bind(runtime.handoffs);
    let refusals = 1;
    runtime.handoffs.noteAppended = (threadId, message) => {
      if (refusals-- > 0) throw new Error("database is locked");
      noteAppended(threadId, message);
    };
    const global = env.agentStore.getOrCreateGlobalThread();
    const followed = env.agentStore.createManagerThread("Docs overhaul");
    const sent = runtime.handoffs.sendToThread({ globalThreadId: global.id, threadId: followed.id, text: "Merge #41", spoken: false });
    const turn = env.agentStore.createWake({ threadId: followed.id, reason: "user", triggerMessageId: null });
    env.agentStore.appendMessage({ threadId: followed.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "Merged #41.", toolCalls: [] } });
    // The late write lands while the turn still runs (its end not yet written): not judged then.
    await waitUntil(() => runtime.handoffs.dto(sent.id)!.state === "delivered", { timeout: 2000, label: "the late delivery" });
    await Bun.sleep(200);
    expect(env.store.listLlmCalls(20).some((call) => call.purpose === "manager_request_check")).toBe(false);
    // Released, the turn's reply is judged as any is.
    runtime.userMessageQueue.submitThreadUserMessage({ threadId: followed.id, content: "Also the API docs.", source: "user" });
    env.agentStore.finishWake(turn.id, "finished");
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    await deps.afterWakeReleasedHook!(followed.id);
    await waitUntil(() => env!.store.listLlmCalls(20).some((call) => call.purpose === "manager_request_check"), { timeout: 3000, label: "a manager_request_check attempt" });
  } finally {
    runtime.dispose();
  }
});

test("a verdict on an older reply that lands after a newer reply was judged ends nothing: the newer reply's judgement stands", async () => {
  const s = setup();
  const sent = s.send("Merge #41");
  s.reply("Merging #41 now.");
  const answer = held(s, "Merge #41");
  s.check.noteTurnEnded(s.thread.id);
  // The thread ends another turn while that judgement is slow; its reply is judged working at once.
  s.answers.set("Merge #41", "working");
  s.reply("Still merging: CI runs.");
  s.check.noteTurnEnded(s.thread.id);
  answer("done");
  await s.check.idle();
  expect([s.service.dto(sent.id)!.state, s.notices.length]).toEqual(["delivered", 0]);
  expect(s.notUsed).toStrictEqual([["Merge #41", "newer_reply"]]);
});

test("a verdict that lands while the thread works through many tool steps, with no newer reply, still ends its request", async () => {
  const s = setup();
  const sent = s.send("Merge #41");
  s.reply("Merged #41.");
  const answer = held(s, "Merge #41");
  s.check.noteTurnEnded(s.thread.id);
  // Another turn runs: steps that only call tools, more than a reply lookup scans.
  for (let i = 0; i < 25; i++) {
    s.env.agentStore.appendMessage({ threadId: s.thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: `c${i}`, toolName: "bash", args: { command: "true" } }] } });
  }
  answer("done");
  await s.check.idle();
  expect(s.service.dto(sent.id)).toMatchObject({ state: "replied", stop: "done" });
});

test("an answer that lands after its thread was archived ends nothing, and says it was not used", async () => {
  const s = setup();
  const sent = s.send("Merge #41");
  s.reply("Merged #41.");
  const answer = held(s, "Merge #41");
  s.check.noteTurnEnded(s.thread.id);
  s.env.agentStore.archiveThread(s.thread.id);
  answer("done");
  await s.check.idle();
  expect([s.service.dto(sent.id)!.stop, s.notices.length]).toEqual([null, 0]);
  expect(s.notUsed).toStrictEqual([["Merge #41", "archived"]]);
});

test("an answer that lands after the thread's stop ended its wait, the thread working again, ends nothing more and says why", async () => {
  const s = setup();
  const sent = s.send("Merge #41");
  s.reply("Merged #41.");
  const answer = held(s, "Merge #41");
  s.check.noteTurnEnded(s.thread.id);
  // It stops, and its stop ends the wait; a new message sets it working again.
  s.stops.set(s.thread.id, "stopped");
  s.service.noteSettled(s.thread.id);
  s.stops.delete(s.thread.id);
  answer("done");
  await s.check.idle();
  expect(s.service.dto(sent.id)!.stop).toBe("stopped");
  expect(s.notices.map((n) => n.notice.stop)).toStrictEqual(["stopped"]);
  expect(s.notUsed).toStrictEqual([["Merge #41", "stopped"]]);
});
