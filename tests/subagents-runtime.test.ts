import { expect, test } from "bun:test";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { LanguageModel } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { newId } from "../src/server/platform/ids.js";
import { SUBAGENT_LIMITS, type BackgroundTaskDto } from "../src/shared/api-contracts.js";
import { formatSubagentDuration } from "../src/shared/subagent-messages.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { createMockLLM, createScriptedStreamLLM } from "./helpers/mock-llm.js";
import { stub } from "./helpers/typed.js";
import { waitUntil } from "./helpers/wait.js";
import { testShellRunner } from "./helpers/shell-runner.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

// The real runtime: its tools, wakes, hooks and mail, as in
// tests/agent-runtime-recovery.test.ts. Only the models and the prompts are
// the test's, so nothing reaches a provider. A parent's model is given by its
// thread, a child's by its task's title; a child given none hangs until it is
// stopped.

function scene(prefix: string, before: (env: ReturnType<typeof freshStoresEnv>) => void = () => {}) {
  const env = freshStoresEnv(prefix);
  before(env);
  const events: Array<{ event: string; data: unknown }> = [];
  // Background commands run through an isolated shell, never the user's.
  const shellHome = fs.mkdtempSync(path.join(env.dir, "shell-home-"));
  const commandRunner = testShellRunner(shellHome);
  const runtime = testAgentRuntime(env, {
    commandRunner,
    ready: Promise.resolve(),
    sse: stub<AgentSseEmitter>({ emit: (event: string, data: unknown) => { events.push({ event, data }); }, addSink: () => () => {} })
  });
  const parents = new Map<string, LanguageModel>();
  const children = new Map<string, LanguageModel>();
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  deps.llmForThread = (threadId) => {
    const thread = env.agentStore.getThreadById(threadId);
    if (thread?.scope === "subagent") {
      const title = thread.scopeId ? runtime.backgroundTasks.get(thread.scopeId)?.title : undefined;
      return { model: (title ? children.get(title) : undefined) ?? createScriptedStreamLLM([[{ type: "hang" }]]) };
    }
    const model = parents.get(threadId);
    if (!model) throw new Error(`no model for thread ${threadId}`);
    return { model };
  };
  deps.llmCallRecorder = undefined;
  deps.buildSystemPrompt = () => "test";
  deps.buildRuntimeContext = () => null;
  deps.buildInitialContext = () => null;
  deps.beforeModelCallHook = undefined;
  deps.supportsInputForThread = () => true;
  deps.supportsToolResultImagesForThread = () => true;
  const gates: Array<() => void> = [];
  const threadIds = () => (env.store.db.prepare("select id from agent_threads").all() as Array<{ id: string }>).map((r) => r.id);
  return {
    env, runtime, deps, events,
    parentModel: (threadId: string, model: LanguageModel) => { parents.set(threadId, model); },
    childModel: (title: string, model: LanguageModel) => { children.set(title, model); },
    /** A promise the test opens; close() opens any left shut. */
    gate: () => {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => { open = resolve; });
      gates.push(open);
      return { promise, open };
    },
    start: (parentThreadId: string, title: string) =>
      runtime.subagents.start({ parentThreadId, title, task: `Do this: ${title}.` }).task,
    task: (id: string) => runtime.backgroundTasks.get(id),
    wakesOf: (threadId: string) =>
      env.store.db.prepare("select reason, status from agent_wakes where thread_id = ? order by rowid").all(threadId) as Array<{ reason: string; status: string }>,
    results: (threadId: string) => env.agentStore.getMessages(threadId).filter((m) => m.source === "subagent-result"),
    toolResult: (threadId: string, toolCallId: string): unknown => {
      for (const m of env.agentStore.getMessages(threadId)) {
        if (m.content.type === "tool_result" && m.content.toolCallId === toolCallId) return m.content.result ?? m.content.error;
      }
      return undefined;
    },
    taskStatuses: (taskId: string) => events
      .filter((e) => e.event === "backgroundTaskChanged" && (e.data as { task: BackgroundTaskDto }).task.id === taskId)
      .map((e) => (e.data as { task: BackgroundTaskDto }).task.status),
    idle: () => threadIds().every((id) => !runtime.wakeScheduler.isThreadBusy(id)),
    async close() {
      for (const open of gates) open();
      // Stopped by their own agent: nobody is told, so nothing more wakes.
      for (const status of ["queued", "running"] as const) {
        for (const task of runtime.backgroundTasks.listOpen().filter((t) => t.status === status)) runtime.subagents.stop(task.id, "agent");
      }
      try {
        await waitUntil(() => threadIds().every((id) => !runtime.wakeScheduler.isThreadBusy(id)), { label: "every wake to end" });
      } finally {
        runtime.dispose();
        env.cleanup();
      }
    }
  };
}

/** The model's first call waits until `gate` opens. */
function heldUntil<T extends LanguageModelV3>(gate: Promise<void>, model: T): T {
  const stream = model.doStream.bind(model);
  let first = true;
  model.doStream = async (options) => {
    if (first) { first = false; await gate; }
    return stream(options);
  };
  return model;
}

const durationOf = (task: BackgroundTaskDto) => Date.parse(task.finishedAt!) - Date.parse(task.startedAt ?? task.createdAt);
const UNTIL_IT_ARRIVES = "Until then you know nothing of what it did: do not report, assume or predict it. Carry on with other work or answer the user meanwhile, and do not work on the same files or the same question yourself.";

test("a manager's call starts a subagent in a hidden child that works with the manager's tools; its end lands in the manager's mail and wakes it for the result", async () => {
  const s = scene("md-subagents-run-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release 0.72");
    const notes = path.join(s.env.dir, "call-sites.md");
    fs.writeFileSync(notes, "retryWake: agent-runtime.ts:472, wake-loop.ts:612\n");
    const answer = "Two call sites: agent-runtime.ts:472 and wake-loop.ts:612.";
    s.parentModel(parent.id, createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "subagent", args: { title: "Find the retry call sites", task: `Read ${notes} and list the call sites of retryWake it names.` } }] },
      { text: "A subagent is finding the retry call sites." },
      { text: "Both call sites are in the wake path." }
    ]));
    const gate = s.gate();
    s.childModel("Find the retry call sites", heldUntil(gate.promise, createMockLLM([
      { toolCalls: [{ toolCallId: "r1", toolName: "read", args: { path: notes } }] },
      { text: answer }
    ])));
    const ask = s.env.agentStore.appendMessage({ threadId: parent.id, role: "user", source: "user", content: { type: "text", text: "Where is retryWake called?" } });
    const first = s.runtime.wakeScheduler.wake(parent.id, "user", ask.id)!;
    await waitUntil(() => s.env.agentStore.getWakeById(first)?.status === "finished" && !s.runtime.wakeScheduler.isThreadBusy(parent.id));
    // The call returned at once, its turn ended, and the child still runs.
    const call = s.toolResult(parent.id, "c1") as { taskId: string; status: string; message: string };
    expect(call).toEqual({
      taskId: expect.stringMatching(/^task_/),
      status: "started",
      message: `Started the subagent “Find the retry call sites”. Its result arrives as a message in this conversation when it finishes. ${UNTIL_IT_ARRIVES}`
    });
    const task = s.task(call.taskId)!;
    expect(task).toMatchObject({ parentThreadId: parent.id, status: "running", type: "general", title: "Find the retry call sites" });
    const child = s.env.agentStore.getThreadById(task.childThreadId!)!;
    expect([child.scope, child.scopeId]).toEqual(["subagent", task.id]);
    expect(s.env.agentStore.listOpenManagerThreads().map((t) => t.id)).toEqual([parent.id]);
    expect(s.wakesOf(child.id)).toEqual([{ reason: "subagent-task", status: "running" }]);

    gate.open();
    await waitUntil(() => s.wakesOf(parent.id)[1]?.status === "finished");
    const ended = s.task(task.id)!;
    expect(ended).toMatchObject({ status: "finished", stoppedBy: null, error: null });
    expect(s.runtime.backgroundTasks.replyOf(ended.id)).toBe(answer);
    // It read the file with the manager's own read, as its own thread.
    expect(String(s.toolResult(child.id, "r1"))).toContain("retryWake: agent-runtime.ts:472, wake-loop.ts:612");
    expect(s.wakesOf(parent.id).map((w) => w.reason)).toEqual(["user", "subagent-result"]);
    const [result] = s.results(parent.id);
    expect(result!.sourceThreadId).toBe(child.id);
    expect(result!.content).toEqual({
      type: "text",
      text: `[Subagent result] “Find the retry call sites”: finished after ${formatSubagentDuration(durationOf(ended))}.\n\n${answer}`,
      metadata: { taskId: task.id, outcome: "finished", title: "Find the retry call sites", durationMs: durationOf(ended), reply: answer, error: null },
      // It came through the manager's mailbox: the time it came.
      arrivedAt: expect.any(String)
    });
    expect(s.taskStatuses(task.id)).toEqual(["queued", "running", "finished"]);
  } finally { await s.close(); }
});

test("workers, managers and Your agent have subagent and stop_task; their subagents have neither", async () => {
  const s = scene("md-subagents-tools-");
  try {
    const ours = (names: readonly string[]) => names.filter((name) => name === "subagent" || name === "stop_task");
    expect((["worker", "manager", "global"] as const).map((scope) => [scope, ours(s.runtime.scopes[scope].toolDefinitions.map((tool) => tool.name))])).toEqual([
      ["worker", ["subagent", "stop_task"]],
      ["manager", ["subagent", "stop_task"]],
      ["global", ["subagent", "stop_task"]]
    ]);
    // A subagent is offered its parent's working set, which holds neither.
    const worker = s.env.agentStore.getOrCreateThread("worker", seedFeature(s.env.features, seedProject(s.env.projects, { name: "project-1" }), { name: "Retry map" }));
    for (const parent of [worker, s.env.agentStore.createManagerThread("Release"), s.env.agentStore.getOrCreateGlobalThread()]) {
      const taskId = newId("task");
      const child = s.env.agentStore.createSubagentThread(taskId);
      s.runtime.backgroundTasks.create({ id: taskId, parentThreadId: parent.id, childThreadId: child.id, type: "general", title: "t", task: "x" });
      const offered = Object.keys(s.deps.toolDispatcherForThread(child.id).registry.tools);
      expect([parent.scope, offered.includes("read"), ours(offered)]).toEqual([parent.scope, true, []]);
    }
  } finally { await s.close(); }
});

test("six of one conversation's subagents run at once; more wait and start by themselves, oldest first, while another conversation's start at once", async () => {
  const s = scene("md-subagents-queue-");
  try {
    const a = s.env.agentStore.createManagerThread("Release");
    const b = s.env.agentStore.createManagerThread("Docs");
    s.parentModel(a.id, createMockLLM([{ text: "Noted." }]));
    const started = Array.from({ length: 8 }, (_, i) =>
      s.runtime.subagents.start({ parentThreadId: a.id, title: `Job ${i + 1}`, task: `Do job ${i + 1}.` }));
    expect(started.map((r) => r.status)).toEqual(["started", "started", "started", "started", "started", "started", "queued", "queued"]);
    expect(s.runtime.backgroundTasks.countRunning(a.id)).toBe(SUBAGENT_LIMITS.perThread);
    expect(s.start(b.id, "Docs survey").status).toBe("running");
    const childOf = (i: number) => started[i]!.task.childThreadId!;
    await waitUntil(() => [0, 1, 2, 3, 4, 5].every((i) => s.wakesOf(childOf(i)).length === 1));
    expect(s.wakesOf(childOf(6))).toEqual([]);
    // One ends: the oldest waiting one starts, not the newest.
    s.runtime.subagents.stop(started[0]!.task.id, "user");
    await waitUntil(() => s.task(started[6]!.task.id)?.status === "running");
    expect(s.task(started[7]!.task.id)?.status).toBe("queued");
    expect(s.wakesOf(childOf(6)).map((w) => w.reason)).toEqual(["subagent-task"]);
    expect(s.runtime.backgroundTasks.countRunning(a.id)).toBe(SUBAGENT_LIMITS.perThread);
  } finally { await s.close(); }
});

test("the user's stop ends a running subagent stopped by the user and its conversation reads so; a Stop on the child's own turn is the user's too", async () => {
  const s = scene("md-subagents-stop-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    s.parentModel(parent.id, createMockLLM([{ text: "Noted." }, { text: "Noted again." }]));
    const first = s.start(parent.id, "Map the cache layer");
    await waitUntil(() => s.env.agentStore.getRunningWakeForThread(first.childThreadId!));
    // Still running until its wake has ended: the stop is asked for.
    expect(s.runtime.subagents.stop(first.id, "user")?.status).toBe("running");
    await waitUntil(() => s.wakesOf(parent.id)[0]?.status === "finished");
    const ended = s.task(first.id)!;
    expect(ended).toMatchObject({ status: "stopped", stoppedBy: "user" });
    expect(s.runtime.backgroundTasks.replyOf(ended.id)).toBeNull();
    expect(s.wakesOf(parent.id).map((w) => w.reason)).toEqual(["subagent-result"]);
    expect(s.results(parent.id).map((m) => m.content.type === "text" ? m.content.text : "")).toEqual([
      `[Subagent result] “Map the cache layer”: stopped by the user after ${formatSubagentDuration(durationOf(ended))}, before it finished.`
    ]);
    // The chat's Stop on the child's own turn goes by its wake, not the task.
    const second = s.start(parent.id, "Map the queue");
    const wake = await waitUntil(() => s.env.agentStore.getRunningWakeForThread(second.childThreadId!));
    s.runtime.wakeScheduler.cancelWake(wake.id);
    await waitUntil(() => s.task(second.id)?.status === "stopped");
    expect(s.task(second.id)?.stoppedBy).toBe("user");
    await waitUntil(() => s.results(parent.id).length === 2);
  } finally { await s.close(); }
});

test("stop_task in the agent's own turn stops its subagent; no result follows and the agent is not woken again", async () => {
  const s = scene("md-subagents-stop-task-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    // Empty until the first call's result is stored.
    const startedId = () => (s.toolResult(parent.id, "c1") as { taskId: string } | undefined)?.taskId ?? "";
    s.parentModel(parent.id, createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "subagent", args: { title: "Wrong brief", task: "Map the cache layer." } }] },
      // Read when the model is called: by then the first call's result is stored.
      { get toolCalls() { return [{ toolCallId: "c2", toolName: "stop_task", args: { taskId: startedId() } }]; } },
      { text: "Stopped it; I will start one with a better brief." }
    ]));
    const ask = s.env.agentStore.appendMessage({ threadId: parent.id, role: "user", source: "user", content: { type: "text", text: "Map the cache layer." } });
    s.runtime.wakeScheduler.wake(parent.id, "user", ask.id);
    await waitUntil(() => s.task(startedId())?.status === "stopped" && s.idle());
    expect(s.toolResult(parent.id, "c2")).toEqual({ stopped: true, message: "Stopped the subagent “Wrong brief”." });
    expect(s.task(startedId())?.stoppedBy).toBe("agent");
    expect(s.results(parent.id)).toEqual([]);
    expect(s.env.agentStore.queuedMailboxSources(parent.id)).toEqual([]);
    expect(s.wakesOf(parent.id)).toEqual([{ reason: "user", status: "finished" }]);
  } finally { await s.close(); }
});

test("a conversation whose turn the user stopped is woken by its subagent's result, as by a worker's report", async () => {
  const s = scene("md-subagents-after-stop-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const stopped = s.env.agentStore.createWake({ threadId: parent.id, reason: "user", triggerMessageId: null });
    s.env.agentStore.finishWake(stopped.id, "canceled", "Stopped by user.");
    const parentModel = createMockLLM([{ text: "It found both call sites." }]);
    s.parentModel(parent.id, parentModel);
    s.childModel("Find the retry call sites", createMockLLM([{ text: "Found them." }]));
    s.start(parent.id, "Find the retry call sites");
    await waitUntil(() => s.wakesOf(parent.id)[1]?.status === "finished");
    expect(s.wakesOf(parent.id)).toEqual([{ reason: "user", status: "canceled" }, { reason: "subagent-result", status: "finished" }]);
    expect(s.env.agentStore.getMessages(parent.id).filter((m) => m.role !== "system").map((m) => m.source)).toEqual(["subagent-result", "self"]);
    expect(parentModel.callsMade).toBe(1);
  } finally { await s.close(); }
});

test("results that land while their conversation is busy reach it together, in one wake for the results", async () => {
  const s = scene("md-subagents-together-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const parentModel = createMockLLM([{ text: "Both answers are in." }]);
    s.parentModel(parent.id, parentModel);
    s.childModel("First", createMockLLM([{ text: "Found the first." }]));
    s.childModel("Second", createMockLLM([{ text: "Found the second." }]));
    const release = s.runtime.wakeScheduler.holdThread(parent.id)!;
    const runs = [s.start(parent.id, "First"), s.start(parent.id, "Second")];
    await waitUntil(() => runs.every((t) => s.task(t.id)?.status === "finished"));
    expect(s.wakesOf(parent.id)).toEqual([]);
    release();
    await waitUntil(() => s.wakesOf(parent.id)[0]?.status === "finished");
    expect(s.wakesOf(parent.id)).toEqual([{ reason: "subagent-result", status: "finished" }]);
    expect(s.results(parent.id).map((m) => m.sourceThreadId).sort()).toEqual(runs.map((t) => t.childThreadId!).sort());
    expect(parentModel.callsMade).toBe(1);
  } finally { await s.close(); }
});

test("a parent archived while its subagents run gets no result, and none of its queued ones start: they end stopped by the archive", async () => {
  const s = scene("md-subagents-archived-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const runs = Array.from({ length: 7 }, (_, i) => s.start(parent.id, `Job ${i + 1}`));
    await waitUntil(() => runs.slice(0, 6).every((t) => s.env.agentStore.getRunningWakeForThread(t.childThreadId!)));
    s.env.agentStore.archiveThread(parent.id);
    s.runtime.wakeScheduler.cancelWake(s.env.agentStore.getRunningWakeForThread(runs[0]!.childThreadId!)!.id);
    await waitUntil(() => s.task(runs[0]!.id)?.status === "stopped");
    expect(s.env.store.db.prepare("select count(*) as n from agent_mailbox where thread_id = ?").get(parent.id)).toEqual({ n: 0 });
    expect(s.task(runs[6]!.id)).toMatchObject({ status: "stopped", stoppedBy: "archive", startedAt: null });
  } finally { await s.close(); }
});

test("a child's failed wake fails its run with the reason its parent reads: the model error as recorded, a repeated failing call, replies cut off at the output limit", async () => {
  const s = scene("md-subagents-failures-");
  try {
    const cases = [
      { title: "Errors out", model: createMockLLM([{ error: new Error("invalid tool schema") }]) },
      { title: "Keeps failing", model: createMockLLM([1, 2, 3, 4, 5].map((n) => ({ toolCalls: [{ toolCallId: `r${n}`, toolName: "read", args: { path: "notes.md" } }] }))) },
      { title: "Cut off", model: createMockLLM([1, 2, 3].map(() => ({ text: "The call sites are", finishReason: "length" as const }))) }
    ];
    const runs = cases.map((c, i) => {
      const parent = s.env.agentStore.createManagerThread(`Thread ${i + 1}`);
      s.parentModel(parent.id, createMockLLM([{ text: "Noted." }]));
      s.childModel(c.title, c.model);
      return s.start(parent.id, c.title);
    });
    await waitUntil(() => runs.every((t) => s.wakesOf(t.parentThreadId)[0]?.status === "finished"));
    const ended = runs.map((t) => s.task(t.id)!);
    const childWakes = runs.map((t) => s.env.agentStore.getLatestWakeForThread(t.childThreadId!)!);
    expect(childWakes.map((w) => w.status)).toEqual(["error", "stuck", "finished"]);
    expect(ended.map((t) => [t.status, t.error])).toEqual([
      ["failed", childWakes[0]!.errorMessage],
      ["failed", "it kept repeating a failing call"],
      ["failed", "its replies kept reaching the output token limit"]
    ]);
    expect(s.runtime.backgroundTasks.replyOf(ended[2]!.id)).toBe("The call sites are");
    const firstLine = (i: number) => {
      const content = s.results(runs[i]!.parentThreadId)[0]!.content;
      return content.type === "text" ? content.text.split("\n")[0] : "";
    };
    expect(firstLine(1)).toBe(`[Subagent result] “Keeps failing”: failed after ${formatSubagentDuration(durationOf(ended[1]!))}: it kept repeating a failing call.`);
    expect(firstLine(2)).toBe(`[Subagent result] “Cut off”: failed after ${formatSubagentDuration(durationOf(ended[2]!))}: its replies kept reaching the output token limit.`);
  } finally { await s.close(); }
});

// A command bash runs in the background ends in its conversation as a
// subagent does: its end is the conversation's mail and wakes it.
test("a background command's end wakes its conversation for the result, which reads how it ended", async () => {
  const s = scene("md-bgcmd-runtime-wake-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    s.parentModel(parent.id, createMockLLM([{ text: "The lint failed: 3 issues." }]));
    const task = await s.runtime.commands.start({ parentThreadId: parent.id, command: "printf '3 issues found\\n'; exit 1", title: "Lint the tree", cwd: s.env.dir, owner: { kind: "global" } });
    await waitUntil(() => s.wakesOf(parent.id).some((w) => w.reason === "command-result" && w.status === "finished"), { label: "the wake for the result" });
    expect(s.task(task.id)).toMatchObject({ status: "failed", exitCode: 1 });
    const result = s.env.agentStore.getMessages(parent.id).find((m) => m.source === "command-result")!;
    expect(result.content.type === "text" && result.content.text.split("\n")[0]).toBe("[Background command] “Lint the tree”: exited 1 after 0s.");
  } finally { await s.close(); }
});

test("a manager thread archived while its command runs: the command ends stopped by the archive, and nobody is told", async () => {
  const s = scene("md-bgcmd-runtime-archive-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const task = await s.runtime.commands.start({ parentThreadId: parent.id, command: "sleep 30", title: "Wait", cwd: s.env.dir, owner: { kind: "global" } });
    s.env.agentStore.archiveThread(parent.id);
    s.runtime.releaseThreadResources(parent.id);
    await waitUntil(() => s.task(task.id)?.status === "stopped", { label: "the command to stop" });
    expect(s.task(task.id)).toMatchObject({ stoppedBy: "archive" });
    expect(s.env.store.db.prepare("select count(*) as n from agent_mailbox where thread_id = ?").get(parent.id)).toEqual({ n: 0 });
    expect(s.runtime.isThreadWorking(parent.id)).toBe(false);
  } finally { await s.close(); }
});

test("at start-up a command a restart cut short ends interrupted, and its conversation is told", async () => {
  let taskId = "";
  let parentId = "";
  const s = scene("md-bgcmd-runtime-restart-", (env) => {
    parentId = env.agentStore.createManagerThread("Release").id;
    taskId = new BackgroundTaskStore(env.store.db).createCommand({
      parentThreadId: parentId, title: "Build", command: "make", outputPath: path.join(env.dir, "gone.log"), pid: null, startedAt: new Date().toISOString()
    }).id;
  });
  try {
    expect(s.task(taskId)).toMatchObject({ status: "interrupted" });
    const told = s.env.agentStore.getMessages(parentId).filter((m) => m.source === "command-result");
    const queued = s.env.agentStore.queuedMailboxSources(parentId);
    expect(told.length + queued.filter((source) => source === "command-result").length).toBe(1);
  } finally { await s.close(); }
});

test("a worker whose feature was archived starts no background command", async () => {
  const s = scene("md-bgcmd-runtime-retired-");
  try {
    const featureId = seedFeature(s.env.features, seedProject(s.env.projects, { name: "project-1" }), { name: "Retry map" });
    const worker = s.env.agentStore.getOrCreateThread("worker", featureId);
    s.env.features.archive(featureId);
    await expect(s.runtime.commands.start({ parentThreadId: worker.id, command: "sleep 5", title: "Late", cwd: s.env.dir, owner: { kind: "global" } })).rejects.toThrow("Stopped before it started.");
    expect(s.runtime.backgroundTasks.listOpen("command")).toEqual([]);
  } finally { await s.close(); }
});

// A command outliving a subagent's one answer would land on a task already
// reported done: a subagent's shell runs in the foreground only.
test("workers, managers and Your agent can run bash in the background; their subagents cannot", async () => {
  const s = scene("md-bgcmd-runtime-tools-");
  try {
    // The two shells' descriptions differ by it: only the background one names run_in_background.
    const background = (bash: unknown) => String((bash as { description?: string } | undefined)?.description).includes("run_in_background");
    expect((["worker", "manager", "global"] as const).map((scope) => [scope, background(s.runtime.scopes[scope].toolDefinitions.find((t) => t.name === "bash"))])).toEqual([
      ["worker", true], ["manager", true], ["global", true]
    ]);
    const worker = s.env.agentStore.getOrCreateThread("worker", seedFeature(s.env.features, seedProject(s.env.projects, { name: "project-1" }), { name: "Retry map" }));
    for (const parent of [worker, s.env.agentStore.createManagerThread("Release"), s.env.agentStore.getOrCreateGlobalThread()]) {
      const taskId = newId("task");
      const child = s.env.agentStore.createSubagentThread(taskId);
      s.runtime.backgroundTasks.create({ id: taskId, parentThreadId: parent.id, childThreadId: child.id, type: "general", title: "t", task: "x" });
      expect([parent.scope, background(s.deps.toolDispatcherForThread(child.id).registry.tools.bash)]).toEqual([parent.scope, false]);
    }
  } finally { await s.close(); }
});

// Your agent is one conversation: the user cannot reach it while a command
// runs in the foreground, so its shell sets how long that lasts.
test("Your agent's shell names no timeout and moves a command after 30 s; a manager's and a worker's keep their timeout", async () => {
  const s = scene("md-bgcmd-runtime-global-window-");
  try {
    const shell = (scope: "global" | "manager" | "worker") => s.runtime.scopes[scope].toolDefinitions.find((tool) => tool.name === "bash")!;
    const params = (scope: "global" | "manager" | "worker") => Object.keys((z.toJSONSchema(shell(scope).parameters as z.ZodType) as { properties: Record<string, unknown> }).properties).sort();
    expect(params("global")).toEqual(["command", "cwd", "description", "run_in_background"]);
    expect(shell("global").description).toContain("A command still running after 30 s is not killed: it moves to the background");
    for (const scope of ["manager", "worker"] as const) {
      expect(params(scope)).toContain("timeout");
      expect(shell(scope).description).toContain("timeout is in milliseconds: default 60000 (60 s), max 600000.");
    }
    // What Your agent's turns are offered is that shell.
    const offered = s.deps.toolDispatcherForThread(s.env.agentStore.getOrCreateGlobalThread().id).registry.tools.bash as { description?: string };
    expect(offered.description).toBe(shell("global").description);
  } finally { await s.close(); }
});

test("a manager lists its background command and stops it with its tools; its first context names it; nobody is told of the stop", async () => {
  const s = scene("md-bgcmd-runtime-list-stop-");
  try {
    const parent = s.env.agentStore.createManagerThread("Release");
    const task = await s.runtime.commands.start({ parentThreadId: parent.id, command: "sleep 30", title: "Wait for CI", cwd: s.env.dir, owner: { kind: "global" } });
    const model = createMockLLM([
      { toolCalls: [{ toolCallId: "l1", toolName: "list_tasks", args: {} }, { toolCallId: "s1", toolName: "stop_task", args: { taskId: task.id } }] },
      { text: "Stopped the wait." }
    ]);
    s.parentModel(parent.id, model);
    const ask = s.env.agentStore.appendMessage({ threadId: parent.id, role: "user", source: "user", content: { type: "text", text: "Stop waiting for CI." } });
    const wake = s.runtime.wakeScheduler.wake(parent.id, "user", ask.id)!;
    await waitUntil(() => s.env.agentStore.getWakeById(wake)?.status === "finished" && !s.runtime.wakeScheduler.isThreadBusy(parent.id));
    expect(JSON.stringify(model.streamCalls[0]!.prompt)).toContain(`- ${task.id} · Command · Wait for CI · \`sleep 30\` · running`);
    expect(s.toolResult(parent.id, "l1")).toEqual({ tasks: [expect.objectContaining({ taskId: task.id, kind: "command", title: "Wait for CI", status: "running", command: "sleep 30" })] });
    expect(s.toolResult(parent.id, "s1")).toEqual({ stopped: true, message: "Stopped the background command “Wait for CI”." });
    await waitUntil(() => s.task(task.id)?.status === "stopped");
    expect(s.task(task.id)).toMatchObject({ stoppedBy: "agent" });
    expect(s.env.agentStore.getMessages(parent.id).filter((m) => m.source === "command-result")).toEqual([]);
  } finally { await s.close(); }
});
