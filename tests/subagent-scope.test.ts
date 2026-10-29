import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { buildSubagentScope, pickSubagentTools, SUBAGENT_TOOLS } from "../src/server/runtime/scopes/subagent-scope.js";
import { toolPack } from "../src/server/runtime/tool-packs.js";
import type { PaneRuntimeRegistry } from "../src/server/runtime/pane-runtime-registry.js";
import type { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import type { AgentThread } from "../src/server/modules/agent/agent-store.js";
import type { ToolContext, ToolDefinition } from "../src/server/modules/agent/tool-registry.js";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { newId } from "../src/server/platform/ids.js";
import { localTimeZone } from "../src/server/platform/time/agent-time.js";
import { withMessageTimes } from "../src/server/modules/agent/system-prompt.js";
import { onCleanup } from "./helpers/cleanup.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

// The subagent's system prompt word for word: changing it changes what the
// model reads, and is done on purpose.
const SUBAGENT_PROMPT = [
  "You are a subagent in Mandate. Another agent has handed you one job: its task is your brief, and it directs your work. You start with a fresh context: you know the task and what you read, nothing else.",
  "",
  "Use the tools you have to complete the task. Complete it fully: don't gold-plate, but don't leave it half-done. Change files only when the task asks you to. Use absolute paths.",
  "Make tool calls that do not depend on each other's results together, in one response; a call that needs another's result waits for it.",
  "No one can answer a question here. When something is missing, work from what you have and say what is missing.",
  "",
  "When you are done, respond with a concise report of what you did and what you found: the paths, line numbers and command results the agent needs, and anything you could not do or check. It relays what matters, so give it only the essentials."
].join("\n");

/** What a worker's or a manager's subagent works with. Your agent's lacks
 *  view_image, as Your agent does. web_search is there while web search is
 *  set up (the default runtime's is off, so only web_fetch is offered). */
const WORKING_SET = ["bash", "chat_history_read", "chat_history_search", "edit", "memory_read", "memory_search", "read", "view_image", "web_fetch", "web_search", "write"];
/** Outside every root a worker has, and nowhere anything can be written. */
const NOWHERE = "/mandate-test-nowhere/notes.md";

/** The whole runtime over fresh stores, never ready (no wake runs), with a
 *  worker whose feature has a tree of its own, a manager thread and Your
 *  agent's thread to start subagents from. */
function setup() {
  const env = freshStoresEnv("md-subagent-scope-");
  onCleanup(env.cleanup);
  const runtime = testAgentRuntime(env, {
    paneRuntimes: stub<PaneRuntimeRegistry>({ forProject: () => stub<TmuxRuntime>() })
  });
  onCleanup(() => runtime.dispose());
  const tasks = new BackgroundTaskStore(env.store.db);
  const projectDir = path.join(env.dir, "project-1");
  const treeDir = path.join(env.dir, "project-1-retry-map");
  fs.mkdirSync(projectDir);
  fs.mkdirSync(treeDir);
  const projectId = seedProject(env.projects, { name: "project-1", workingDir: projectDir, tmuxSessionName: "md-project-1" });
  const featureId = seedFeature(env.features, projectId, {
    name: "Retry map", mode: "new-branch-new-worktree", branch: "retry-map", worktreePath: treeDir, tmuxWindowName: "retry-map"
  });
  const worker = env.agentStore.getOrCreateThread("worker", featureId);
  const manager = env.agentStore.createManagerThread("Release 0.72");
  const global = env.agentStore.getOrCreateGlobalThread();
  /** A subagent of `parent`, made as the subagent tool makes one: the
   *  child's thread for the task's id, then the task naming that thread. */
  const subagentOf = (parent: AgentThread) => {
    const taskId = newId("task");
    const child = env.agentStore.createSubagentThread(taskId);
    tasks.create({
      id: taskId, parentThreadId: parent.id, childThreadId: child.id, type: "general",
      title: "Find the retry call sites", task: "Find every call site of retryWake and list them with file and line."
    });
    return child;
  };
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  /** A tool call as the wake loop makes it: the thread's dispatcher, and its tool scope. */
  const call = (threadId: string, toolName: string, args: unknown) =>
    deps.toolDispatcherForThread(threadId).dispatch(
      { toolCallId: `call_${toolName}`, toolName, args },
      { threadId, wakeId: "wake_test", scope: deps.buildToolScope(threadId) }
    );
  /** The tools the model is offered on a step of the thread's wake. */
  const offered = (threadId: string) => Object.keys(deps.toolDispatcherForThread(threadId).registry.tools).sort();
  return { ...env, runtime, deps, sub: runtime.scopes.subagent, tasks, projectId, featureId, treeDir, worker, manager, global, subagentOf, call, offered };
}

test("a subagent is offered its parent's own working set: files, the shell, and the reads of memory and history; nothing else runs", async () => {
  const s = setup();
  expect([...SUBAGENT_TOOLS].sort()).toEqual(WORKING_SET);
  const description = (threadId: string, name: string) =>
    (s.deps.toolDispatcherForThread(threadId).registry.tools[name] as { description?: string } | undefined)?.description;
  for (const parent of [s.worker, s.manager, s.global]) {
    const child = s.subagentOf(parent);
    // Your agent has no view_image, so its subagent has none either.
    expect([parent.scope, s.offered(child.id)])
      .toEqual([parent.scope, WORKING_SET.filter((name) => name !== "web_search" && (parent.scope !== "global" || name !== "view_image"))]);
    // Each as its parent's model reads it.
    const own = s.runtime.scopes[parent.scope].toolDefinitions.find((tool) => tool.name === "chat_history_search")!;
    expect(description(child.id, "chat_history_search")).toBe(own.description);
  }
  // A worker's history search names no project; a manager's must.
  expect(description(s.subagentOf(s.worker).id, "chat_history_search"))
    .not.toBe(description(s.subagentOf(s.manager).id, "chat_history_search"));
  // What its manager has and it has not: none of it runs.
  const child = s.subagentOf(s.manager);
  const managerTools = s.runtime.scopes.manager.toolDefinitions.map((tool) => tool.name);
  for (const toolName of ["canvas_create", "schedule_wake", "feature_message_send", "memory_remember"]) {
    expect([toolName, managerTools.includes(toolName)]).toEqual([toolName, true]);
    expect(await s.call(child.id, toolName, {})).toEqual({ isError: true, error: `unknown tool: ${toolName}` });
  }
  // The scope offers nothing of its own: every subagent's tools are its parent's.
  expect([s.sub.scope, s.sub.toolDefinitions]).toEqual(["subagent", []]);
});

test("a worker's subagent reads and writes only within the worker's roots, and its shell starts in the feature's tree; a manager's or Your agent's reads anywhere", async () => {
  const s = setup();
  const ofWorker = s.subagentOf(s.worker);
  expect(s.deps.buildToolScope(ofWorker.id)).toEqual(s.deps.buildToolScope(s.worker.id));
  const notes = path.join(s.treeDir, "notes.md");
  fs.writeFileSync(notes, "retryWake is called from two places\n");
  expect((await s.call(ofWorker.id, "read", { path: notes })).result).toContain("retryWake is called from two places");
  const outside: Array<[string, Record<string, unknown>]> = [
    ["read", { path: NOWHERE }],
    ["write", { path: NOWHERE, content: "x" }],
    ["edit", { path: NOWHERE, oldString: "a", newString: "b" }]
  ];
  for (const [toolName, args] of outside) {
    const refused = await s.call(ofWorker.id, toolName, args);
    expect([toolName, refused.isError, refused.error?.startsWith("path is outside worker scope")]).toEqual([toolName, true, true]);
  }
  // Its shell, by default, in the feature's tree, and never outside the
  // roots. The tree is taken away first, so no shell ever starts here: bash
  // says where it would have run.
  fs.rmSync(s.treeDir, { recursive: true });
  expect((await s.call(ofWorker.id, "bash", { command: "pwd" })).result).toBe(`stderr:\ncwd does not exist: ${s.treeDir}\nexitCode: -1`);
  expect((await s.call(ofWorker.id, "bash", { command: "pwd", cwd: "/mandate-test-nowhere" })).result).toContain("path is outside worker scope");
  // A manager's and Your agent's work where theirs do: any path.
  for (const parent of [s.manager, s.global]) {
    const child = s.subagentOf(parent);
    expect(s.deps.buildToolScope(child.id)).toEqual(s.deps.buildToolScope(parent.id));
    expect(await s.call(child.id, "read", { path: NOWHERE })).toEqual({ result: "File does not exist." });
  }
});

test("what a subagent read is its own: it edits a file only once it has read it, whatever its parent read", async () => {
  const s = setup();
  const child = s.subagentOf(s.worker);
  const notes = path.join(s.treeDir, "notes.md");
  fs.writeFileSync(notes, "retryWake is called from two places\n");
  expect((await s.call(s.worker.id, "read", { path: notes })).isError).toBeUndefined();
  const edit = { path: notes, oldString: "two places", newString: "three places" };
  expect(await s.call(child.id, "edit", edit)).toEqual({ isError: true, error: `read must be called before editing file: ${notes}` });
  await s.call(child.id, "read", { path: notes });
  expect((await s.call(child.id, "edit", edit)).result).toEqual(expect.stringMatching(/^Updated /));
  expect(fs.readFileSync(notes, "utf8")).toBe("retryWake is called from three places\n");
});

test("each call carries its parent's context under the subagent's own thread: a worker's feature and project; a worker that is gone runs nothing", async () => {
  const env = freshStoresEnv("md-subagent-context-");
  onCleanup(env.cleanup);
  const tasks = new BackgroundTaskStore(env.store.db);
  const projectId = seedProject(env.projects, { name: "project-1" });
  const featureId = seedFeature(env.features, projectId, { name: "Retry map" });
  const seen: ToolContext[] = [];
  const recordingRead: ToolDefinition = {
    name: "read", description: "Reads.", parameters: z.object({}),
    handler: async (_args, ctx) => { seen.push(ctx); return "read"; }
  };
  const toolScope = { kind: "manager" as const, managerDir: "/mandate-test-nowhere", projectWorkingDirs: [] };
  const sub = buildSubagentScope({
    agentStore: env.agentStore, backgroundTasks: tasks, featuresStore: env.features, projectsStore: env.projects,
    toolPacks: {
      worker: toolPack("test.worker", ["subagent"], [recordingRead]),
      manager: toolPack("test.manager", ["subagent"], [recordingRead]),
      global: toolPack("test.global", ["subagent"], [recordingRead])
    },
    parentToolScope: () => toolScope
  });
  const childOf = (parent: AgentThread) => {
    const taskId = newId("task");
    const child = env.agentStore.createSubagentThread(taskId);
    tasks.create({ id: taskId, parentThreadId: parent.id, childThreadId: child.id, type: "general", title: "t", task: "x" });
    return child;
  };
  const run = (threadId: string) => sub.dispatcherForThread!(threadId).dispatch(
    { toolCallId: "c1", toolName: "read", args: {} },
    { threadId, wakeId: "w", scope: sub.buildToolScope(threadId) }
  );
  const ofWorker = childOf(env.agentStore.getOrCreateThread("worker", featureId));
  const ofManager = childOf(env.agentStore.createManagerThread("Release 0.72"));
  expect([await run(ofWorker.id), await run(ofManager.id)]).toEqual([{ result: "read" }, { result: "read" }]);
  expect(seen.map((ctx) => [ctx.threadId, ctx.feature?.id ?? null, ctx.project?.id ?? null, ctx.scope])).toStrictEqual([
    [ofWorker.id, featureId, projectId, toolScope],
    [ofManager.id, null, null, toolScope]
  ]);
  // A worker whose feature is gone: nothing runs. Its tool scope fails the
  // same way first (the wake ends there): no line for a model.
  const ofGone = childOf(env.agentStore.getOrCreateThread("worker", "feat_gone"));
  await expect(run(ofGone.id)).rejects.toThrow(`feature or project missing for the worker of subagent thread ${ofGone.id}`);
  expect(seen).toHaveLength(2);
});

test("a subagent whose task or parent is gone is offered no tools and runs nothing", async () => {
  const s = setup();
  const orphan = s.agentStore.createSubagentThread("task_without_row");
  const ofDeleted = s.agentStore.createSubagentThread("task_of_deleted");
  s.tasks.create({ id: "task_of_deleted", parentThreadId: "thr_deleted", childThreadId: ofDeleted.id, type: "general", title: "t", task: "x" });
  const scope = { kind: "manager" as const, managerDir: "", projectWorkingDirs: [] };
  for (const child of [orphan, ofDeleted]) {
    expect(s.offered(child.id)).toEqual([]);
    // The same failure as its tool scope's, which comes first in a wake.
    await expect(s.deps.toolDispatcherForThread(child.id).dispatch({ toolCallId: "c1", toolName: "read", args: { path: NOWHERE } }, { threadId: child.id, wakeId: "w", scope }))
      .rejects.toThrow(`no parent thread for subagent thread ${child.id}`);
    expect(() => s.sub.buildToolScope(child.id)).toThrow(`no parent thread for subagent thread ${child.id}`);
  }
});

test("a subagent's system prompt is the subagent prompt, whoever started it", async () => {
  const s = setup();
  for (const parent of [s.worker, s.manager, s.global]) {
    expect(await s.deps.buildSystemPrompt(s.subagentOf(parent).id)).toBe(withMessageTimes(SUBAGENT_PROMPT, localTimeZone()));
  }
});

test("a subagent's tools are its parent's own instances, picked by name, and none its parent lacks", () => {
  const tool = (name: string): ToolDefinition => ({ name, description: name, parameters: z.object({}), handler: async () => null });
  const packs = [
    toolPack("a", ["worker"], [tool("read"), tool("spawn_pane"), tool("bash")]),
    toolPack("b", ["manager"], [tool("write")]),
    toolPack("c", ["worker"], [tool("subagent"), tool("memory_search"), tool("memory_remember")])
  ];
  const picked = pickSubagentTools("worker", packs);
  expect([picked.id, picked.scopes, picked.tools.map((t) => t.name)]).toEqual(["subagent.worker", ["subagent"], ["read", "bash", "memory_search"]]);
  expect(picked.tools[0]).toBe(packs[0]!.tools[0]!);
});

test("a subagent's thread runs on the route of the thread that started it: its model, recorder and input checks", () => {
  const s = setup();
  for (const parent of [s.manager, s.worker, s.global]) {
    const child = s.subagentOf(parent);
    const own = s.deps.llmForThread!(parent.id);
    const its = s.deps.llmForThread!(child.id);
    expect(its.model).toBe(own.model);
    expect(its.llmCallRecorder).toBe(own.llmCallRecorder);
    expect(s.deps.supportsInputForThread!(child.id, "image")).toBe(s.deps.supportsInputForThread!(parent.id, "image"));
    expect(s.deps.supportsToolResultImagesForThread!(child.id)).toBe(s.deps.supportsToolResultImagesForThread!(parent.id));
  }
  // A manager's subagent is not routed as a worker.
  expect(s.deps.llmForThread!(s.subagentOf(s.manager).id).llmCallRecorder).not.toBe(s.deps.llmForThread!(s.worker.id).llmCallRecorder);
});

// Activity tells a subagent's work apart: the runtime files its steps under
// their own purpose, with the conversation it works for.
test("the runtime files a subagent's steps under subagent_step with its parent; the conversation's own steps stay agent_wake_step", () => {
  const env = freshStoresEnv("md-subagent-steps-");
  const runtime = testAgentRuntime(env);
  try {
    const thread = env.agentStore.createManagerThread("project-1 release");
    const { task } = runtime.subagents.start({ parentThreadId: thread.id, title: "project-1 retry call sites", task: "Find every call site of retryWake." });
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    expect(deps.stepRecordingForThread?.(task.childThreadId!)).toEqual({ purpose: "subagent_step", metadata: { parentThreadId: thread.id } });
    expect(deps.stepRecordingForThread?.(thread.id) ?? null).toBeNull();
  } finally {
    runtime.dispose();
    env.cleanup();
  }
});
