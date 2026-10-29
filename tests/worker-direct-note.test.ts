import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { noteWorkerMessageToManager } from "../src/server/runtime/worker-direct-note.js";
import { featureMessageMetadata } from "../src/shared/feature-message.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { waitUntil } from "./helpers/wait.js";
import { recordingInbox } from "./helpers/upward-inbox.js";

// What the user tells a worker directly reaches the worker's manager as a
// note: the manager directed the worker and would go on with
// what the user changed unknown to it. A copy, not a request: it wakes
// nobody, lands now when the manager is idle and at its next step when it
// is not, and only once the message is in the worker's conversation.

function setup(prefix: string) {
  const env = freshStoresEnv(prefix);
  const manager = env.agentStore.createManagerThread("Follow-up fix for PR 56");
  const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const featureId = seedFeature(env.features, projectId, { name: "Follow-up fix: parser fails on empty input", ownerThreadId: manager.id });
  const worker = env.agentStore.getOrCreateThread("worker", featureId);
  const busy = new Set<string>();
  const { inbox, emitted, wakes } = recordingInbox(env.agentStore, { busy: (threadId) => busy.has(threadId) });
  const deps = { agentStore: env.agentStore, featuresStore: env.features, inbox };
  const say = (text: string, extra: Partial<Extract<AgentMessage["content"], { type: "text" }>> = {}, source: AgentMessage["source"] = "user") =>
    env.agentStore.appendMessage({ threadId: worker.id, role: "user", source, content: { type: "text", text, ...extra } });
  const managerRows = () => env.agentStore.getMessages(manager.id);
  return { env, manager, projectId, featureId, worker, deps, emitted, wakes, busy, say, managerRows };
}

test("what the user tells a worker lands in its idle manager's conversation at once, as a note, waking nobody", () => {
  const s = setup("md-direct-note-idle-");
  try {
    const message = s.say("Keep parser.go's exports; accept an empty string and null.");
    noteWorkerMessageToManager(s.deps, s.worker.id, message);
    const rows = s.managerRows();
    expect(rows).toHaveLength(1);
    const note = rows[0]!;
    expect(note).toMatchObject({ role: "user", source: "feature-message" });
    expect(note.content.type === "text" && note.content.text).toBe(
      "The user wrote to your worker \"Follow-up fix: parser fails on empty input\" directly; the worker has the message:\n\n" +
      "Keep parser.go's exports; accept an empty string and null.\n\n" +
      "No reply is needed. Take it into account when you next direct this worker."
    );
    expect(featureMessageMetadata(note.content)).toEqual({
      direction: "note", featureId: s.featureId, featureName: "Follow-up fix: parser fails on empty input", by: "user",
      text: "Keep parser.go's exports; accept an empty string and null.", attachments: 0
    });
    // A note, keyed on the worker's feature.
    expect(note.content.type === "text" && note.content.metadata?.inbox).toStrictEqual({ kind: "note", key: `feature:${s.featureId}` });
    expect(s.emitted).toStrictEqual([{ event: SSE_EVENTS.agentMessageAppended, data: { threadId: s.manager.id, message: note } }]);
    // Nothing queued that could wake the manager.
    expect(s.env.agentStore.queuedMailboxSources(s.manager.id)).toEqual([]);
    expect(s.wakes).toStrictEqual([]);
  } finally { s.env.cleanup(); }
});

test("through the user's agent it says so; attachments are counted, not forwarded; a long message is cut", () => {
  const s = setup("md-direct-note-relay-");
  try {
    const image = { type: "image" as const, id: "img_1", name: "probe.png", mediaType: "image/png", data: "", sizeBytes: 10 };
    const long = "Write the load-check counts into the report as well. ".repeat(200);
    noteWorkerMessageToManager(s.deps, s.worker.id, s.say(long, {
      attachments: [image], relay: { by: "global", spoken: false, handoffId: "hof_1" }
    }));
    const note = s.managerRows()[0]!;
    const text = note.content.type === "text" ? note.content.text : "";
    expect(text.startsWith("The user, through their agent, wrote to your worker \"Follow-up fix: parser fails on empty input\" directly; the worker has the message (with 1 attachment, not forwarded):\n\n")).toBe(true);
    const meta = featureMessageMetadata(note.content)!;
    expect(meta).toMatchObject({ by: "agent", attachments: 1 });
    // The card keeps its own cut; the manager's model gets the one cut, the whole saved.
    expect(meta.text!.length).toBe(4001);
    expect(meta.text!.endsWith("…")).toBe(true);
    const said = long.trim();
    expect(text).toContain(`[Cut: the first 4,000 of ${said.length.toLocaleString("en-US")} characters. The whole text: `);
    expect(text).toContain(`]\n\n${said.slice(0, 4000)}\n\nNo reply is needed.`);
    const file = /The whole text: (\S+)\]/.exec(text)![1]!;
    expect(fs.readFileSync(file, "utf8")).toBe(said);
  } finally { s.env.cleanup(); }
});

// The copy of the user's words closes the questions its manager had asked
// them (they are the user's answer as far as anyone can tell). They may be
// about something else: the manager is woken once, told so, to judge it and
// ask again if they do not answer.
const ask = (s: ReturnType<typeof setup>, id: string, question: string) => s.env.agentStore.appendMessage({
  threadId: s.manager.id, role: "tool", source: "self",
  content: { type: "tool_result", toolCallId: `call_${id}`, toolName: "ask_user", result: { asked: true, questionId: id, question, options: [] } }
});
const textOf = (message: AgentMessage) => (message.content.type === "text" ? message.content.text : "");
const HEAD = "The user wrote to your worker \"Follow-up fix: parser fails on empty input\" directly; the worker has the message:\n\n";

test("a note leaves the questions the manager asked the user open, reads as any note, and wakes nobody, idle or mid-turn", () => {
  const s = setup("md-direct-note-questions-");
  try {
    ask(s, "q_1", "Push fix/evict-order and open a pull request?");
    noteWorkerMessageToManager(s.deps, s.worker.id, s.say("Rename the flag first."));
    expect(textOf(s.managerRows().at(-1)!)).toBe(`${HEAD}Rename the flag first.\n\nNo reply is needed. Take it into account when you next direct this worker.`);
    expect(s.env.agentStore.openQuestions(s.manager.id).map((q) => q.id)).toEqual(["q_1"]);
    // Mid-turn: held for the next step, starting no turn of its own; nothing
    // lands in its conversation or goes out to the page meanwhile.
    s.busy.add(s.manager.id);
    const rows = s.managerRows().map((m) => m.id);
    const sent = s.emitted.length;
    noteWorkerMessageToManager(s.deps, s.worker.id, s.say("And keep the old name as an alias."));
    expect(s.managerRows().map((m) => m.id)).toEqual(rows);
    expect(s.emitted.length).toBe(sent);
    expect(s.env.store.db.prepare("select source, trigger_turn from agent_mailbox where thread_id = ?").all(s.manager.id)).toEqual([{ source: "feature-message", trigger_turn: 0 }]);
    expect(s.env.agentStore.openQuestions(s.manager.id).map((q) => q.id)).toEqual(["q_1"]);
    const wake = s.env.agentStore.createWake({ threadId: s.manager.id, reason: "user", triggerMessageId: null });
    const [drained] = s.env.agentStore.drainMailboxToMessages(s.manager.id, wake.id);
    expect(textOf(drained!)).toBe(`${HEAD}And keep the old name as an alias.\n\nNo reply is needed. Take it into account when you next direct this worker.`);
    expect(drained!.content.type === "text" && drained!.content.metadata?.inbox).toStrictEqual({ kind: "note", key: `feature:${s.featureId}` });
    expect(s.wakes).toStrictEqual([]);
    expect(s.env.agentStore.openQuestions(s.manager.id).map((q) => q.id)).toEqual(["q_1"]);
  } finally { s.env.cleanup(); }
});

test("only the user's own messages to a worker with a live manager are noted", () => {
  const s = setup("md-direct-note-skip-");
  try {
    // The manager's own request, a watch firing: the manager knows, or it is no person's.
    noteWorkerMessageToManager(s.deps, s.worker.id, s.say("from the manager", {}, "feature-message"));
    noteWorkerMessageToManager(s.deps, s.worker.id, s.say("pane went quiet", {}, "watch"));
    // A message in the manager's own thread is not to a worker.
    const own = s.env.agentStore.appendMessage({ threadId: s.manager.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
    noteWorkerMessageToManager(s.deps, s.manager.id, own);
    expect(s.managerRows().map((m) => m.id)).toEqual([own.id]);
    // A worker with no manager, or whose manager thread is archived.
    const loose = seedFeature(s.env.features, s.projectId, { name: "loose", tmuxWindowName: "loose" });
    const looseThread = s.env.agentStore.getOrCreateThread("worker", loose);
    noteWorkerMessageToManager(s.deps, looseThread.id, s.env.agentStore.appendMessage({ threadId: looseThread.id, role: "user", source: "user", content: { type: "text", text: "no one to tell" } }));
    s.env.agentStore.archiveThread(s.manager.id);
    noteWorkerMessageToManager(s.deps, s.worker.id, s.say("archived manager"));
    expect(s.managerRows().map((m) => m.id)).toEqual([own.id]);
  } finally { s.env.cleanup(); }
});

test("the runtime wakes no manager for a note, a question of its open or not", () => {
  const env = freshStoresEnv("md-direct-note-runtime-wake-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const manager = env.agentStore.createManagerThread("Follow-up fix for PR 56");
    const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "parser", ownerThreadId: manager.id });
    runtime = testAgentRuntime(env);
    const woken: Array<[string, string]> = [];
    runtime.wakeScheduler.wake = ((threadId: string, reason: string) => { woken.push([threadId, reason]); return null; }) as typeof runtime.wakeScheduler.wake;
    runtime.userMessageQueue.submitUserMessage({ scope: "worker", scopeId: featureId, content: "keep parser.go's exports" });
    expect(woken.filter(([id]) => id === manager.id)).toStrictEqual([]);
    env.agentStore.appendMessage({
      threadId: manager.id, role: "tool", source: "self",
      content: { type: "tool_result", toolCallId: "call_q_1", toolName: "ask_user", result: { asked: true, questionId: "q_1", question: "Push the branch?", options: [] } }
    });
    runtime.userMessageQueue.submitUserMessage({ scope: "worker", scopeId: featureId, content: "rename the flag first" });
    expect(woken.filter(([id]) => id === manager.id)).toStrictEqual([]);
    expect(env.agentStore.openQuestions(manager.id).map((q) => q.id)).toEqual(["q_1"]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

// What follows a message's landing (its manager's copy, Your agent's handoff
// marked delivered) ran inside the send: a write the database refused there
// told the sender a written message had failed, so a resend doubled it, and
// left the handoff queued, its wait never ending.
test("a message to a worker is sent though the database refuses its manager's copy: the copy follows on a try again, once", async () => {
  const env = freshStoresEnv("md-direct-note-runtime-refused-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const manager = env.agentStore.createManagerThread("Follow-up fix for PR 56");
    const projectId = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "parser", ownerThreadId: manager.id });
    runtime = testAgentRuntime(env, { stepRetryDelaysMs: [5, 5, 5] });
    const real = env.agentStore.appendMessage.bind(env.agentStore);
    let refuse = true;
    env.agentStore.appendMessage = (input) => {
      if (input.threadId === manager.id && refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
      return real(input);
    };
    const sent = runtime.userMessageQueue.submitUserMessage({ scope: "worker", scopeId: featureId, content: "keep parser.go's exports" });
    expect(sent.messageId).not.toBeNull();
    const worker = env.agentStore.getThreadByScope("worker", featureId)!;
    expect(env.agentStore.getMessages(worker.id).filter((m) => m.source === "user")).toHaveLength(1);
    await waitUntil(() => env.agentStore.getMessages(manager.id).length === 1, { label: "the manager's copy", timeout: 2_000 });
    expect(env.agentStore.getMessages(manager.id).map((m) => featureMessageMetadata(m.content))).toEqual([expect.objectContaining({ direction: "note", text: "keep parser.go's exports" })]);
  } finally {
    logged.mockRestore();
    runtime?.dispose();
    env.cleanup();
  }
});

test("Your agent's message is sent though the database refuses marking its handoff delivered: marked on a try again", async () => {
  const env = freshStoresEnv("md-direct-note-runtime-handoff-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const manager = env.agentStore.createManagerThread("Docs overhaul");
    runtime = testAgentRuntime(env, { stepRetryDelaysMs: [5, 5, 5] });
    const handoffs = runtime.handoffs;
    const real = handoffs.noteAppended.bind(handoffs);
    let refuse = true;
    handoffs.noteAppended = (threadId, message) => {
      if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
      real(threadId, message);
    };
    const global = env.agentStore.getOrCreateGlobalThread();
    const handoff = handoffs.sendToThread({ globalThreadId: global.id, threadId: manager.id, text: "Ship the docs today", spoken: false });
    expect(env.agentStore.getMessages(manager.id).map((m) => m.source)).toEqual(["user"]);
    const state = () => (env.store.db.prepare("select state from global_handoffs where id = ?").get(handoff.id) as { state: string }).state;
    await waitUntil(() => state() === "delivered", { label: "the handoff marked delivered", timeout: 2_000 });
  } finally {
    logged.mockRestore();
    runtime?.dispose();
    env.cleanup();
  }
});

// The target can stop before the retry marks the handoff delivered (a turn
// that fails at once): its release judged the handoff while it was still
// queued, so the retry judges it again.
test("a handoff marked delivered on a try again after its target stopped ends then", async () => {
  const env = freshStoresEnv("md-direct-note-runtime-handoff-late-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const manager = env.agentStore.createManagerThread("Docs overhaul");
    runtime = testAgentRuntime(env, { stepRetryDelaysMs: [80, 80] });
    // The send's own wake is recorded, not run: the test plays the turn.
    runtime.wakeScheduler.wake = (() => "wk_recorded") as typeof runtime.wakeScheduler.wake;
    const handoffs = runtime.handoffs;
    const real = handoffs.noteAppended.bind(handoffs);
    let refuse = true;
    handoffs.noteAppended = (threadId, message) => {
      if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
      real(threadId, message);
    };
    const global = env.agentStore.getOrCreateGlobalThread();
    const handoff = handoffs.sendToThread({ globalThreadId: global.id, threadId: manager.id, text: "Ship the docs today", spoken: false });
    // Its turn answers and ends before the retry; its release judges the waits.
    const wake = env.agentStore.createWake({ threadId: manager.id, reason: "user", triggerMessageId: null });
    env.agentStore.appendMessage({ threadId: manager.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "Shipped.", toolCalls: [] } });
    env.agentStore.finishWake(wake.id, "finished", null);
    handoffs.noteSettled(manager.id);
    const state = () => (env.store.db.prepare("select state from global_handoffs where id = ?").get(handoff.id) as { state: string }).state;
    expect(state()).toBe("queued");
    await waitUntil(() => !["queued", "delivered", "waiting"].includes(state()), { label: "the handoff's wait to end", timeout: 2_000 });
  } finally {
    logged.mockRestore();
    runtime?.dispose();
    env.cleanup();
  }
});
