import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { LanguageModel } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { PagePublisher } from "../src/server/modules/page/page-publisher.js";
import { pageContract } from "../src/server/modules/page/page-contract.js";
import { globalAgentDir } from "../src/server/platform/fs/resources.js";
import type { AgentPageStateDto } from "../src/shared/api-contracts.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { createMockLLM, createScriptedStreamLLM } from "./helpers/mock-llm.js";
import { stub } from "./helpers/typed.js";
import { waitUntil } from "./helpers/wait.js";
import { testShellRunner } from "./helpers/shell-runner.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { createWebTools } from "../src/server/modules/web/web-tools.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";

// Your agent's page subagent in the real runtime: its prompt, its tools, its
// queue and its quiet result. Only the models are the test's; a child is
// given its model by its task's title, and one given none hangs until stopped.

const PAGE_SUBAGENT_PROMPT = (pageDir: string) => `You are a page subagent in Mandate. Your agent keeps a page beside its conversation with the user, and you keep it for it: its task says what moved or what the user asked; beyond that, keeping the page true is yours to judge.

The page folder is ${pageDir}: index.html is the page and sources.json lists its data sources. Your agent's notes are in ${path.join(globalAgentDir(), "notes")}: index.md lists its open matters and matters/ says where each stands; read them to see what is current. Make the change the task asks for. Then bring up to date whatever else on the page is no longer true, and let data show what data can (the built-in sources, or a source of your own over the notes), so the page needs less rewriting next time. Keep the layout the user knows unless the task asks to change it, and keep what the page already does working. Try a command with bash before you list it as a source. Write nothing outside the page folder, and use absolute paths.
Make tool calls that do not depend on each other's results together, in one response; a call that needs another's result waits for it.
No one can answer a question here. When the task is unclear or cannot be done, change nothing and say why.

When you end, Mandate publishes index.html if it changed and applies sources.json. End with one line saying what you changed.

${pageContract()}`;

function scene(prefix: string) {
  const env = freshStoresEnv(prefix);
  const events: Array<{ event: string; data: unknown }> = [];
  const sse = stub<AgentSseEmitter>({ emit: (event: string, data: unknown) => { events.push({ event, data }); }, addSink: () => () => {} });
  const pageDir = path.join(env.dir, "agent", "page");
  fs.mkdirSync(pageDir, { recursive: true });
  const pageStore = new PageStore(env.store.db);
  const publisher = new PagePublisher({
    store: pageStore,
    agentStore: env.agentStore,
    pageDir,
    globalThreadId: () => env.agentStore.openGlobalThread()?.id ?? null,
    applySources: () => ({ names: null, error: null }),
    sourcesFile: () => "[]\n",
    sse
  });
  const runtime = testAgentRuntime(env, {
    commandRunner: testShellRunner(fs.mkdtempSync(path.join(env.dir, "shell-home-"))),
    ready: Promise.resolve(),
    sse,
    page: { dir: pageDir, publisher },
    // Web search on, so its tool is offered (nothing here calls it).
    web: createWebTools({ getConfig: () => ({ ...structuredClone(DEFAULT_CONFIG), webSearch: { use: "exa", kinds: { exa: { apiKey: "k" } } } }) })
  });
  const children = new Map<string, LanguageModel>();
  const parents = new Map<string, LanguageModel>();
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
  deps.buildRuntimeContext = () => null;
  deps.buildInitialContext = () => null;
  deps.beforeModelCallHook = undefined;
  deps.supportsInputForThread = () => true;
  deps.supportsToolResultImagesForThread = () => true;
  const global = env.agentStore.getOrCreateGlobalThread();
  const threadIds = () => (env.store.db.prepare("select id from agent_threads").all() as Array<{ id: string }>).map((r) => r.id);
  return {
    env, runtime, deps, events, pageDir, pageStore, global,
    childModel: (title: string, model: LanguageModel) => { children.set(title, model); },
    parentModel: (threadId: string, model: LanguageModel) => { parents.set(threadId, model); },
    startPage: (title: string) => runtime.subagents.start({ parentThreadId: global.id, title, task: `Do this: ${title}.`, type: "page" }),
    mailbox: (threadId: string) => env.store.db
      .prepare("select source, content, trigger_turn from agent_mailbox where thread_id = ? order by rowid")
      .all(threadId) as Array<{ source: string; content: string; trigger_turn: number }>,
    wakesOf: (threadId: string) =>
      env.store.db.prepare("select reason, status from agent_wakes where thread_id = ? order by rowid").all(threadId) as Array<{ reason: string; status: string }>,
    pageStates: () => events.filter((e) => e.event === "agentPageUpdated").map((e) => (e.data as { state: AgentPageStateDto }).state),
    async close() {
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

/** A child that writes index.html; one that finds a page there reads it first, as write asks. */
const writesPage = (pageDir: string, html: string, reply: string, { readFirst = false } = {}) => createMockLLM([
  ...(readFirst ? [{ toolCalls: [{ toolCallId: "r1", toolName: "read", args: { path: path.join(pageDir, "index.html") } }] }] : []),
  { toolCalls: [{ toolCallId: "w1", toolName: "write", args: { path: path.join(pageDir, "index.html"), content: html } }] },
  { text: reply }
]);

test("a page subagent starts at once with the page prompt and page tools; started while answering the user, its result wakes Your agent", async () => {
  const s = scene("md-page-subagent-run-");
  try {
    s.parentModel(s.global.id, createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "subagent", args: { title: "Put usage first", task: "Move the usage chart to the top.", type: "page" } }] },
      { text: "The page is being changed." },
      { text: "Usage is at the top of the page now." }
    ]));
    s.childModel("Put usage first", writesPage(s.pageDir, "<h1>Usage</h1>", "Moved the usage chart to the top."));
    const ask = s.env.agentStore.appendMessage({ threadId: s.global.id, role: "user", source: "user", content: { type: "text", text: "Put token usage at the top of the page." } });
    const first = s.runtime.wakeScheduler.wake(s.global.id, "user", ask.id)!;
    await waitUntil(() => s.env.agentStore.getWakeById(first)?.status === "finished");
    await waitUntil(() => s.pageStore.latest() !== null && s.runtime.backgroundTasks.listOpen().length === 0, { label: "the page subagent to end" });

    const [task] = s.env.store.db.prepare("select id, type, child_thread_id as child from background_tasks").all() as Array<{ id: string; type: string; child: string }>;
    expect(task!.type).toBe("page");
    expect(await s.runtime.scopes.subagent.buildSystemPrompt(task!.child)).toBe(PAGE_SUBAGENT_PROMPT(s.pageDir));
    const tools = Object.keys(s.runtime.scopes.subagent.dispatcherForThread!(task!.child).registry.tools).sort();
    expect(tools).toEqual(["bash", "edit", "read", "web_fetch", "web_search", "write"]);
    expect(toolReply(s, s.global.id, "c1")).toBe("Started the page subagent “Put usage first”. When it ends, its result reaches you as a note and wakes you, so you can tell the user. Until then do not edit page/ yourself.");

    expect(s.pageStore.latest()).toMatchObject({ revision: 1, html: "<h1>Usage</h1>", writer: "Put usage first" });
    const mail = s.mailbox(s.global.id);
    expect(mail.map((m) => [m.source, m.trigger_turn])).toEqual([["page-result", 1]]);
    expect(JSON.parse(mail[0]!.content).text).toBe("[Page] Version 1, from the page subagent “Put usage first”: Moved the usage chart to the top.");
    // The user's turn, then one to tell them it is done.
    await waitUntil(() => s.wakesOf(s.global.id).length === 2 && !s.runtime.wakeScheduler.isThreadBusy(s.global.id), { label: "Your agent woken for the result" });
    expect(s.wakesOf(s.global.id)).toEqual([{ reason: "user", status: "finished" }, { reason: "subagent-result", status: "finished" }]);
    expect(s.pageStates().map((state) => state.write?.status)).toStrictEqual(["running", "published"]);
  } finally { await s.close(); }
});

test("a page subagent reads Your agent's notes where its prompt says they are", async () => {
  const s = scene("md-page-subagent-notes-");
  try {
    const notes = path.join(globalAgentDir(), "notes");
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(path.join(notes, "index.md"), "- release-x: waiting on the thread\n");
    s.parentModel(s.global.id, createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "subagent", args: { title: "Bring it up to date", task: "Bring the page up to date.", type: "page" } }] },
      { text: "Updating the page." },
      { text: "Done." }
    ]));
    s.childModel("Bring it up to date", createMockLLM([
      { toolCalls: [{ toolCallId: "r1", toolName: "read", args: { path: path.join(notes, "index.md") } }] },
      { text: "Read the notes; nothing to change." }
    ]));
    const ask = s.env.agentStore.appendMessage({ threadId: s.global.id, role: "user", source: "user", content: { type: "text", text: "Update the page." } });
    const first = s.runtime.wakeScheduler.wake(s.global.id, "user", ask.id)!;
    await waitUntil(() => s.env.agentStore.getWakeById(first)?.status === "finished");
    await waitUntil(() => s.runtime.backgroundTasks.listOpen().length === 0, { label: "the page subagent to end" });
    const [task] = s.env.store.db.prepare("select child_thread_id as child from background_tasks").all() as Array<{ child: string }>;
    expect(await s.runtime.scopes.subagent.buildSystemPrompt(task!.child)).toContain(`Your agent's notes are in ${notes}:`);
    const read = s.env.agentStore.getMessages(task!.child).find((m) => m.content.type === "tool_result" && m.content.toolCallId === "r1");
    expect(JSON.stringify(read?.content)).toContain("release-x: waiting on the thread");
  } finally { await s.close(); }
});

test("a page subagent Your agent starts on its own leaves a quiet note when it publishes, and wakes it when it fails", async () => {
  const s = scene("md-page-subagent-own-");
  try {
    s.parentModel(s.global.id, createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "subagent", args: { title: "Note the merged MR", task: "Add the merged MR.", type: "page" } }] },
      { text: "Noted." },
      { toolCalls: [{ toolCallId: "c2", toolName: "subagent", args: { title: "Add the review", task: "Add the review.", type: "page" } }] },
      { text: "Noted." },
      { text: "The page update failed; I will try again." }
    ]));
    s.childModel("Note the merged MR", writesPage(s.pageDir, "<h1>Merged</h1>", "Added it."));
    s.childModel("Add the review", createMockLLM([{ error: new Error("provider 500: overloaded") }]));
    // Woken by a thread's news, not by the user: nobody waits on the page.
    const own = noticeWake(s, "Thread \"Docs\": MR merged.");
    await waitUntil(() => s.env.agentStore.getWakeById(own)?.status === "finished" && s.runtime.backgroundTasks.listOpen().length === 0 && !s.runtime.wakeScheduler.isThreadBusy(s.global.id), { label: "its page subagent to end" });
    expect(toolReply(s, s.global.id, "c1")).toBe("Started the page subagent “Note the merged MR”. Its result reaches you as a note on your next turn; it wakes you only if it fails. Until then do not edit page/ yourself.");
    const pageMail = () => s.mailbox(s.global.id).filter((m) => m.source === "page-result");
    expect(pageMail().map((m) => [m.source, m.trigger_turn])).toEqual([["page-result", 0]]);
    expect(s.wakesOf(s.global.id)).toEqual([{ reason: "thread-notice", status: "finished" }]);
    // One that fails wakes it, though nobody asked.
    const again = noticeWake(s, "Thread \"Docs\": reviewed.");
    await waitUntil(() => s.env.agentStore.getWakeById(again)?.status === "finished");
    await waitUntil(() => s.wakesOf(s.global.id).length === 3 && !s.runtime.wakeScheduler.isThreadBusy(s.global.id), { label: "Your agent woken for the failure" });
    const failed = pageMail().at(-1)!;
    expect([failed.source, failed.trigger_turn]).toEqual(["page-result", 1]);
    expect(JSON.parse(failed.content).text).toStartWith("[Page] The page subagent “Add the review” failed:");
    expect(s.wakesOf(s.global.id).map((w) => w.reason)).toEqual(["thread-notice", "thread-notice", "subagent-result"]);
  } finally { await s.close(); }
});

test("a user's message landing mid-turn makes the turn one that answers them: its page subagent wakes Your agent", async () => {
  const s = scene("md-page-subagent-midturn-");
  try {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    s.parentModel(s.global.id, heldUntil(gate, createMockLLM([
      { toolCalls: [{ toolCallId: "l1", toolName: "list_tasks", args: {} }] },
      { toolCalls: [{ toolCallId: "c1", toolName: "subagent", args: { title: "Usage first", task: "Move usage up.", type: "page" } }] },
      { text: "On it." },
      { text: "Done." }
    ])));
    s.childModel("Usage first", writesPage(s.pageDir, "<h1>Usage</h1>", "Moved it."));
    const own = noticeWake(s, "Thread \"Docs\": MR merged.");
    // While its first step waits, the user writes: queued, taken in before the next step.
    s.runtime.userMessageQueue.submitThreadUserMessage({ threadId: s.global.id, content: "Put usage at the top.", source: "user" });
    open();
    await waitUntil(() => s.env.agentStore.getWakeById(own)?.status === "finished");
    await waitUntil(() => s.runtime.backgroundTasks.listOpen().length === 0 && s.pageStore.latest() !== null, { label: "its page subagent to end" });
    expect(toolReply(s, s.global.id, "c1")).toContain("wakes you, so you can tell the user");
    await waitUntil(() => s.wakesOf(s.global.id).some((w) => w.reason === "subagent-result") && !s.runtime.wakeScheduler.isThreadBusy(s.global.id), { label: "Your agent woken for the result" });
  } finally { await s.close(); }
});

test("whether a page run's end wakes Your agent is kept with its task, so a run that waits its turn keeps it over a restart", async () => {
  const s = scene("md-page-subagent-kept-");
  try {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    s.childModel("Asked for", heldUntil(gate, writesPage(s.pageDir, "<h1>Asked</h1>", "Done.")));
    const asked = s.runtime.subagents.start({ parentThreadId: s.global.id, title: "Asked for", task: "Do it.", type: "page", wakeWhenDone: true });
    // Kept in its task message, beside what the run was handed.
    expect(s.env.agentStore.subagentTaskOfThread(asked.task.childThreadId!)).toMatchObject({ taskId: asked.task.id, wakesParent: true });
    const own = s.runtime.subagents.start({ parentThreadId: s.global.id, title: "On its own", task: "Do it.", type: "page" });
    expect(s.env.agentStore.subagentTaskOfThread(own.task.childThreadId!)?.wakesParent).toBeUndefined();
    // What is kept decides, not this process's memory: one marked since wakes too.
    const child = own.task.childThreadId!;
    const row = s.env.store.db.prepare("select id, content from agent_messages where thread_id = ? and source = 'subagent-task'").get(child) as { id: string; content: string };
    const content = JSON.parse(row.content) as { metadata: { subagentTask: Record<string, unknown> } };
    content.metadata.subagentTask.wakesParent = true;
    s.env.store.db.prepare("update agent_messages set content = ? where id = ?").run(JSON.stringify(content), row.id);
    s.childModel("On its own", writesPage(s.pageDir, "<h1>Own</h1>", "Done.", { readFirst: true }));
    s.parentModel(s.global.id, createMockLLM([{ text: "Done." }, { text: "Done." }]));
    open();
    await waitUntil(() => s.pageStore.latest()?.writer === "On its own", { label: "both page subagents to publish" });
    expect(s.mailbox(s.global.id).filter((m) => m.source === "page-result").map((m) => m.trigger_turn)).toEqual([1, 1]);
  } finally { await s.close(); }
});

/** Your agent woken by a thread's news, as the runtime wakes it: its notice
 *  waits in its mailbox. Not the user: nobody waits on what it does. */
function noticeWake(s: ReturnType<typeof scene>, text: string): string {
  s.env.agentStore.enqueueMailboxMessage({ threadId: s.global.id, role: "user", source: "thread-notice", content: { type: "text", text: `[Thread notice] ${text}` } });
  return s.runtime.wakeScheduler.wake(s.global.id, "thread-notice", null)!;
}

/** What a tool call of a thread returned, as its message says. */
function toolReply(s: ReturnType<typeof scene>, threadId: string, toolCallId: string): string {
  const row = s.env.agentStore.getMessages(threadId).find((m) => m.content.type === "tool_result" && m.content.toolCallId === toolCallId);
  const result = row && row.content.type === "tool_result" ? row.content.result as { message?: string } : null;
  return result?.message ?? "";
}

test("two page subagents run one after the other, in the order started", async () => {
  const s = scene("md-page-subagent-queue-");
  try {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    s.childModel("First change", heldUntil(gate, writesPage(s.pageDir, "<h1>One</h1>", "Wrote one.")));
    s.childModel("Second change", writesPage(s.pageDir, "<h1>Two</h1>", "Wrote two.", { readFirst: true }));
    const first = s.startPage("First change");
    const second = s.startPage("Second change");
    expect([first.status, second.status]).toEqual(["started", "queued"]);
    // A general subagent of the same conversation is not held by the page's queue.
    const general = s.runtime.subagents.start({ parentThreadId: s.global.id, title: "Look something up", task: "Look it up." });
    expect(general.status).toBe("started");
    expect(s.runtime.backgroundTasks.get(second.task.id)?.status).toBe("queued");
    open();
    await waitUntil(() => s.pageStore.latest()?.revision === 2, { label: "both page subagents to publish" });
    expect([s.pageStore.version(1)?.writer, s.pageStore.version(2)?.writer]).toEqual(["First change", "Second change"]);
    const notes = s.mailbox(s.global.id).filter((m) => m.source === "page-result").map((m) => JSON.parse(m.content).text);
    expect(notes).toEqual([
      "[Page] Version 1, from the page subagent “First change”: Wrote one.",
      "[Page] Version 2, from the page subagent “Second change”: Wrote two."
    ]);
  } finally { await s.close(); }
});

test("a page subagent interrupted by a restart fails its write and the next one starts", async () => {
  const s = scene("md-page-subagent-restart-");
  try {
    // The first hangs (no model of its own); the second waits behind it.
    const first = s.startPage("Cut short");
    const second = s.startPage("Next in line");
    expect(s.pageStore.state().write).toMatchObject({ taskId: first.task.id, status: "running" });
    const child = first.task.childThreadId!;
    await waitUntil(() => Boolean(s.runtime.wakeScheduler.getRunningWakeForThread(child)), { label: "the first child's wake" });
    // The restart: its wake ends with Mandate, and its end step never runs.
    const hook = s.deps.postWakeHook;
    s.deps.postWakeHook = undefined;
    s.runtime.wakeScheduler.cancelWake(s.runtime.wakeScheduler.getRunningWakeForThread(child)!.id);
    await waitUntil(() => !s.runtime.wakeScheduler.isThreadBusy(child), { label: "the first child's wake to end" });
    s.deps.postWakeHook = hook;
    expect(s.runtime.backgroundTasks.get(first.task.id)?.status).toBe("running");

    s.childModel("Next in line", writesPage(s.pageDir, "<h1>Next</h1>", "Wrote the next."));
    s.runtime.subagents.recoverAtStartup();
    expect(s.runtime.backgroundTasks.get(first.task.id)?.status).toBe("interrupted");
    expect(s.env.store.db.prepare("select status, error from agent_page_writes where task_id = ?").get(first.task.id))
      .toEqual({ status: "failed", error: "Mandate restarted while it ran" });
    const notes = () => s.mailbox(s.global.id).filter((m) => m.source === "page-result").map((m) => JSON.parse(m.content).text);
    expect(notes()[0]).toBe("[Page] The page subagent “Cut short” failed: Mandate restarted while it ran. The last page stays.");
    // The next one starts, and publishes.
    await waitUntil(() => s.pageStore.latest()?.writer === "Next in line", { label: "the next page subagent to publish" });
    expect(s.runtime.backgroundTasks.get(second.task.id)?.status).toBe("finished");
  } finally { await s.close(); }
});

test("a queued page subagent Your agent stops ends quietly; a running one is no wait of Your agent's", async () => {
  const s = scene("md-page-subagent-stop-");
  try {
    const running = s.startPage("Runs and hangs");
    const queued = s.startPage("Never runs");
    expect(s.runtime.subagents.stop(queued.task.id, "agent", s.global.id)?.status).toBe("stopped");
    expect(s.mailbox(s.global.id).filter((m) => m.source === "page-result")).toEqual([]);
    expect(s.env.store.db.prepare("select count(*) as n from agent_page_writes where task_id = ?").get(queued.task.id)).toEqual({ n: 0 });
    // A page subagent wakes nobody, so Your agent waits on none.
    expect(s.runtime.pendingMonitors(s.global.id).monitors).toEqual([]);
    expect(s.runtime.backgroundTasks.get(running.task.id)?.status).toBe("running");
    // Its steps are filed apart in Activity: under page_subagent_step, with Your agent's thread.
    expect(s.deps.stepRecordingForThread?.(running.task.childThreadId!)).toEqual({ purpose: "page_subagent_step", metadata: { parentThreadId: s.global.id } });
  } finally { await s.close(); }
});

test("only Your agent has a page: a manager's page subagent is refused", async () => {
  const s = scene("md-page-subagent-manager-");
  try {
    const manager = s.env.agentStore.createManagerThread("Docs overhaul");
    expect(() => s.runtime.subagents.start({ parentThreadId: manager.id, title: "Change a page", task: "Change it.", type: "page" }))
      .toThrow("Only Your agent has a page.");
    expect(s.runtime.backgroundTasks.listOpen()).toEqual([]);
  } finally { await s.close(); }
});
