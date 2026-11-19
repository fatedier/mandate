import { afterEach, expect, spyOn, test } from "bun:test";
import { answersMetadata } from "../src/shared/questions.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshStoresEnv, seedWorker, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import { loadConfig } from "../src/server/config/load-config.js";
import type { Config } from "../src/server/config/types.js";
import { buildPersonalScope, PERSONAL_REUSED_TOOLS, pickPersonalReusedTools, type PersonalScopeDeps } from "../src/server/modules/personal/personal-scope.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { StickyNotesService } from "../src/server/modules/sticky-notes/sticky-notes-service.js";
import { CalendarService } from "../src/server/modules/calendar/calendar-service.js";
import { CalendarStore } from "../src/server/modules/calendar/calendar-store.js";
import { NOTES_INDEX_MAX_CHARS, renderPersonalRuntimeContext, renderNotesIndex } from "../src/server/modules/personal/personal-context.js";
import { buildPersonalActionTools, buildPersonalArchiveTools, buildPersonalReadTools } from "../src/server/modules/personal/personal-tools.js";
import type { ThreadArchive } from "../src/server/modules/agent/thread-archive.js";
import type { HandoffService } from "../src/server/modules/personal/handoff-service.js";
import { toolPack } from "../src/server/runtime/tool-packs.js";
import { loadBuiltinSkills, loadSkillsFromDir } from "../src/server/modules/skills/skill-loader.js";
import { buildSkillTools } from "../src/server/modules/skills/tool-packs.js";
import { assertReadInScope, assertWriteInScope } from "../src/server/modules/agent/tool-scope.js";
import { createBashTool } from "../src/server/modules/agent/tools/bash.js";
import { applyAgentPatch } from "../src/server/modules/settings/config-section-patches.js";
import { normalizePersonalAgentName, displayPersonalAgentName } from "../src/shared/personal-agent-name.js";
import { modelRefForScope } from "../src/server/modules/agent/agent-routes.js";
import { AgentHistoryStore } from "../src/server/modules/agent/history-store.js";
import type { ToolContext, ToolDefinition } from "../src/server/modules/agent/tool-registry.js";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { MandateStore } from "../src/server/app/store.js";
import type { ManagerToolPackContext } from "../src/server/modules/module.js";
import type { PaneMonitorManager } from "../src/server/modules/agent/pane-monitor-manager.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import type { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { buildCommonToolPacks, buildManagerToolPacks } from "../src/server/modules/registry.js";
import { stub } from "./helpers/typed.js";
import type { AgentStore } from "../src/server/modules/agent/agent-store.js";
import type { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import type { AgentAlarmManager } from "../src/server/modules/agent/agent-alarm-manager.js";
import type { SubagentService } from "../src/server/runtime/subagents.js";
import { testShellRunner } from "./helpers/shell-runner.js";
import type { CurrentVerdict } from "../src/shared/api/thread-status.js";
import { WorkerRecordStore } from "../src/server/modules/plans/record-store.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function fakeTool(name: string): ToolDefinition {
  return { name, description: name, parameters: z.object({}), handler: async () => ({ ok: true }) };
}

function scopeEnv(name = "", memoryOf: (env: StoresEnv) => MemoryManager | null = () => null, skillRegistry = new SkillRegistry(), extra: Pick<PersonalScopeDeps, "notificationChannels" | "taskBoard" | "stickyNotes" | "calendar"> = {}) {
  env = freshStoresEnv("md-global-scope-");
  const config: Config = { ...loadConfig(env.dir) };
  config.agent = { ...config.agent, personalAgentName: name };
  const workStore = new WorkItemStore(env.store.db);
  const planStore = new PlanStore(env.store.db);
  // Every reused name plus two the personal agent must not get.
  const managerTools = [...PERSONAL_REUSED_TOOLS, "create_worker", "view_image"].map(fakeTool);
  const workDir = path.join(env.dir, "agent");
  fs.mkdirSync(path.join(workDir, "notes"), { recursive: true });
  const busy = new Set<string>();
  /** The manager stop check's verdicts that show, by thread. */
  const verdicts = new Map<string, CurrentVerdict>();
  const scope = buildPersonalScope({
    workDir,
    getConfig: () => config,
    records: new WorkerRecordStore(env.store.db),
    agentStore: env.agentStore,
    projectsStore: env.projects,
    workersStore: env.workers,
    workStore,
    planStore,
    skillRegistry,
    memory: memoryOf(env),
    toolPacks: [pickPersonalReusedTools([toolPack("manager.all", ["manager"], managerTools)])],
    isBusy: (threadId) => busy.has(threadId),
    verdictOf: (threadId) => verdicts.get(threadId) ?? null,
    ...extra
  });
  return { env, config, workStore, planStore, scope, workDir, busy, verdicts };
}

test("there is one open personal agent thread, created on first use, and it is never a manager thread", () => {
  const { env } = scopeEnv();
  expect(env.agentStore.openPersonalThread()).toBeNull();
  const first = env.agentStore.getOrCreatePersonalThread();
  expect(first.scope).toBe("personal");
  expect(first.scopeId).toBeNull();
  expect(env.agentStore.getOrCreatePersonalThread().id).toBe(first.id);
  expect(env.agentStore.getOrCreateThread("personal", null).id).toBe(first.id);
  // The partial unique index refuses a second open one written by hand.
  expect(() => env.store.db.prepare(
    "insert into agent_threads (id, scope, scope_id, created_at, updated_at) values ('thr_x', 'personal', null, 'now', 'now')"
  ).run()).toThrow(/UNIQUE constraint failed/);
  env.agentStore.appendMessage({ threadId: first.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
  expect(env.agentStore.listOpenManagerThreads().map((t) => t.id)).not.toContain(first.id);
  expect(env.agentStore.latestOpenManagerThread()).toBeNull();
});

test("the personal scope gets the manager's read tools, its shell and the projects' lifecycle, by their real names, and none of its other actions", () => {
  // The manager's real packs, as agent-scopes builds them (stubs where a pack
  // only needs a dependency to exist).
  const source = [
    ...buildCommonToolPacks({
      scope: "manager",
      store: stub<MandateStore>({ db: stub<Database>() }),
      skillRegistry: stub<SkillRegistry>(),
      paneMonitorManager: stub<PaneMonitorManager>(),
      memory: stub<MemoryManager>(),
      agentStore: stub<AgentStore>(),
      projectsStore: stub<ProjectsStore>(),
      workersStore: stub<WorkersStore>(),
      getWakeScheduler: () => stub<WakeScheduler>(),
      alarmManager: stub<AgentAlarmManager>(),
      subagents: stub<Pick<SubagentService, "start" | "stop">>()
    }),
    ...buildManagerToolPacks(stub<ManagerToolPackContext>())
  ];
  const sourceNames = source.flatMap((pack) => pack.tools.map((t) => t.name));
  // Positive control: the manager really has the actions that must stay out.
  for (const action of ["create_worker", "archive_worker", "message_worker", "view_image"]) {
    expect([action, sourceNames.includes(action)]).toEqual([action, true]);
  }
  const picked = pickPersonalReusedTools(source).tools.map((t) => t.name).sort();
  // It has a working directory of its own: `write`, `edit`
  // and its own alarms are in. The tool that returns an image is not.
  expect(picked.includes("view_image")).toBe(false);
  expect(picked).toEqual([
    // It adds a repository on this machine as a project, and archives one,
    // when the user asks.
    "archive_project",
    "bash",
    "cancel_alarm",
    "chat_history_read",
    "chat_history_search",
    "create_project",
    "edit",
    "get_worker_status",
    "list_my_alarms",
    "list_projects",
    // And sees what of it still runs: its subagents and background commands.
    "list_tasks",
    "list_workers",
    // It changes a learned skill when it is wrong, or when the user asks.
    "manage_skill",
    "memory_forget",
    "memory_read",
    "memory_remember",
    "memory_search",
    "memory_update",
    "read",
    "read_plan",
    "read_skill_reference",
    "read_thread",
    "read_worker_thread",
    // And asks for a review of finished work, to keep a skill from it.
    "request_skill_review",
    "schedule_wake",
    "skill",
    // It hands a self-contained job to a subagent, and may stop it.
    "stop_task",
    "subagent",
    "write"
  ]);
  // And the scope registers exactly what it is given under "personal".
  const { scope } = scopeEnv();
  expect(scope.toolDefinitions.map((t) => t.name).sort()).toEqual([...PERSONAL_REUSED_TOOLS].sort());
});

test("The personal agent still has read_thread, once", () => {
  env = freshStoresEnv("md-read-thread-tool-");
  const tools = buildManagerToolPacks(stub<ManagerToolPackContext>({ agentStore: env.agentStore })).flatMap((pack) => pack.tools);
  const workStore = new WorkItemStore(env!.store.db);
  const planStore = new PlanStore(env!.store.db);
  const reused = pickPersonalReusedTools([...buildCommonToolPacks(stub()), ...buildManagerToolPacks(stub<ManagerToolPackContext>({ agentStore: env!.agentStore }))]).tools;
  const own = buildPersonalReadTools({ agentStore: env!.agentStore, workersStore: env!.workers, workStore, projectsStore: env!.projects, planStore });
  expect([...reused, ...own].filter((t) => t.name === "read_thread")).toHaveLength(1);
  expect(tools.filter((t) => t.name === "read_thread")).toHaveLength(1);
});

// It answers by looking, anywhere on the machine: its file tools and its
// shell have no roots (a manager's keep theirs).
test("its tool scope reads and writes any path: an active project's, an archived one's, anything else", () => {
  const { env, scope } = scopeEnv();
  seedProject(env.projects, { name: "project-1", workingDir: "/srv/code/project-1", tmuxSessionName: "project-1" });
  const gone = seedProject(env.projects, { name: "old", workingDir: "/srv/code/old", tmuxSessionName: "old" });
  env.projects.archive(gone);
  const toolScope = scope.buildToolScope(env.agentStore.getOrCreatePersonalThread().id);
  expect(toolScope.kind).toBe("manager");
  for (const target of ["/srv/code/project-1/README.md", "/srv/code/old/README.md", "/etc/hosts"]) {
    expect(assertReadInScope(target, toolScope)).toBe(target);
    expect(assertWriteInScope(target, toolScope)).toBe(target);
  }
  // A worker's scope keeps its roots.
  const workerScope = { kind: "worker" as const, worker: { workingDir: "/srv/code/project-1" }, project: { workingDir: "/srv/code/project-1" } };
  expect(() => assertReadInScope("/etc/hosts", workerScope)).toThrow(/outside worker scope/);
});

test("its shell starts in its own working directory, which it may write to like a manager's", () => {
  const { env, scope, workDir } = scopeEnv();
  const toolScope = scope.buildToolScope(env.agentStore.getOrCreatePersonalThread().id);
  expect(toolScope.kind).toBe("manager");
  expect(toolScope.kind === "manager" && toolScope.managerDir).toBe(workDir);
  expect(assertWriteInScope(path.join(workDir, "notes", "index.md"), toolScope)).toBe(path.join(workDir, "notes", "index.md"));
});

test("its notes index is in its runtime context as it is on disk, with the directory's path", async () => {
  const { env, scope, workDir } = scopeEnv();
  fs.writeFileSync(path.join(workDir, "notes", "index.md"), "- Search timeout · thread: Search timeout · waiting on: thread · look again: 15:10\n");
  const context = (await scope.buildRuntimeContext!(env.agentStore.getOrCreatePersonalThread().id))!;
  expect(context).toContain("## Your notes");
  expect(context).toContain(`Your working directory: ${workDir}`);
  expect(context).toContain("- Search timeout · thread: Search timeout · waiting on: thread · look again: 15:10");
});

test("a missing index, a blank one, or a directory in its place reads (empty)", async () => {
  const { env, scope, workDir } = scopeEnv();
  const id = env.agentStore.getOrCreatePersonalThread().id;
  expect((await scope.buildRuntimeContext!(id))!).toContain("notes/index.md as it is now:\n\n(empty)");
  fs.writeFileSync(path.join(workDir, "notes", "index.md"), "  \n");
  expect((await scope.buildRuntimeContext!(id))!).toContain("notes/index.md as it is now:\n\n(empty)");
  fs.rmSync(path.join(workDir, "notes", "index.md"));
  fs.mkdirSync(path.join(workDir, "notes", "index.md"));
  expect((await scope.buildRuntimeContext!(id))!).toContain("notes/index.md as it is now:\n\n(empty)");
});

test("an index past 8,000 characters is cut, and says so", () => {
  const long = "x".repeat(NOTES_INDEX_MAX_CHARS + 50);
  const shown = renderNotesIndex(long);
  expect(shown.startsWith("x".repeat(NOTES_INDEX_MAX_CHARS))).toBe(true);
  expect(shown).toContain("[Cut at 8000 characters: shorten notes/index.md.]");
  expect(shown).not.toContain("x".repeat(NOTES_INDEX_MAX_CHARS + 1));
  expect(renderNotesIndex("short")).toBe("short");
});

test("a command it runs with a project's dir as cwd runs there, and so does one anywhere else", async () => {
  const { env, scope } = scopeEnv();
  // A real directory that is neither scratch nor Mandate's data: this repository's own sources.
  const projectDir = fs.realpathSync(path.resolve("src"));
  seedProject(env.projects, { name: "mandate", workingDir: projectDir, tmuxSessionName: "mandate" });
  const threadId = env.agentStore.getOrCreatePersonalThread().id;
  const ctx = { threadId, wakeId: "w1", scope: scope.buildToolScope(threadId) };
  // Never the module's own runner in a test: it captures the developer's
  // login shell and writes the snapshot into the REAL data dir, which a
  // running Mandate sources for every command (it has happened).
  // An isolated runner with a scratch HOME and snapshot dir, as tool-bash's.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "global-scope-bash-home-"));
  const bash = createBashTool({
    runner: testShellRunner(home)
  });
  try {
    const inside = await bash.handler({ command: "pwd", description: "Print the directory", cwd: projectDir }, ctx);
    expect(inside).toContain(projectDir);
    expect(inside).not.toContain("outside manager read scope");
    const outside = await bash.handler({ command: "pwd", description: "Print the directory", cwd: "/etc" }, ctx);
    expect(outside).not.toContain("outside manager read scope");
    expect(outside).toMatch(/\/(private\/)?etc/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Memory opens the personal agent's window and never changes inside it.
test("its memory is in its initial context, not its runtime context", async () => {
  const { env, scope } = scopeEnv("", (e) => {
    const memory = new MemoryManager(new LocalMemoryProvider(e.store.db));
    memory.putBrief({ scope: "user", projectId: null, content: "USER BRIEF", inputDigest: "d", builtAt: "2026-10-07T00:00:00.000Z" });
    return memory;
  });
  const personal = env.agentStore.getOrCreatePersonalThread();
  const initial = (await scope.buildInitialContext!(personal.id))!;
  expect(initial).toContain("## Memory");
  expect(initial).toContain("USER BRIEF");
  expect(await scope.buildRuntimeContext!(personal.id)).not.toContain("## Memory");
  expect(scope.buildMemorySection!(personal.id)).toContain("USER BRIEF");
});

test("The personal agent reads the user's rules for the tool-call review while the review is on", async () => {
  const { env, scope, config } = scopeEnv();
  const personal = env.agentStore.getOrCreatePersonalThread();
  const chat = { ...config.agent.decisions, provider: "gw", model: "deepseek/deepseek-flash" };
  config.agent = { ...config.agent, toolReviewEnabled: true, toolReviewRules: "Ask me before anything touches production.", decisionsEnabled: true, decisions: chat };
  expect(String(await scope.buildInitialContext!(personal.id))).toContain("## Your user's rules for risky steps\n\nAsk me before anything touches production.");
  config.agent = { ...config.agent, toolReviewEnabled: false };
  expect(String(await scope.buildInitialContext!(personal.id))).not.toContain("## Your user's rules for risky steps");
});

test("its runtime context names it and lists every thread, worker and what waits on the user", async () => {
  const { env, scope, planStore, busy } = scopeEnv("Jarvis");
  const thread = env.agentStore.createManagerThread("Docs overhaul");
  const projectId = seedProject(env.projects, { name: "mandate", workingDir: "/tmp/m", tmuxSessionName: "m" });
  const workerId = seedWorker(env.workers, projectId, { name: "release", ownerThreadId: thread.id });
  expect(planStore.update(workerId, { steps: [{ title: "Tag the release", status: "done", note: "git tag v3.21 pushed" }] })).toMatchObject({ ok: true });
  const asks = seedWorker(env.workers, projectId, { name: "evict", tmuxWindowName: "evict", ownerThreadId: thread.id });
  planStore.update(asks, { openQuestions: ["Keep the old flag as an alias?"], steps: [{ title: "Decide", status: "in_progress" }] });
  const personal = env.agentStore.getOrCreatePersonalThread();
  const context = (await scope.buildRuntimeContext!(personal.id))!;
  expect(context).toContain("Your name: Jarvis");
  expect(context).toContain("Docs overhaul");
  // A worker whose plan is done waits on nobody: no state on its line.
  expect(context).toContain("- release (mandate) · thread: Docs overhaul\n");
  // A worker's finished plan is its manager's: not among what waits on the user.
  expect(context).not.toContain("- release: ");
  // A worker that asked waits for an answer, from its manager first: it is
  // named so on its own line, and is not among what waits on the user.
  expect(context).toContain("evict (mandate) · thread: Docs overhaul · Waiting for an answer · step: Decide");
  // Its thread rests and nobody took the question up: it waits on the user, with its words.
  const waitsOnUser = async () => {
    const text = (await scope.buildRuntimeContext!(personal.id))!;
    return text.slice(text.indexOf("## Waiting on the user"), text.indexOf("## What you are waiting to hear from"));
  };
  expect(await waitsOnUser()).toBe([
    "## Waiting on the user",
    "",
    "- evict: Needs you · thread: Docs overhaul · asks: Keep the old flag as an alias?",
    "",
    ""
  ].join("\n"));
  // Its manager asked the user too; while the manager works, the worker's question is the manager's.
  env.agentStore.appendMessage({
    threadId: thread.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c1", toolName: "ask_user", result: { asked: true, questionId: "q_1", question: "Tag 3.21\ntoday?", options: [] } }
  });
  busy.add(thread.id);
  expect(await waitsOnUser()).toBe([
    "## Waiting on the user",
    "",
    "- manager: Needs you · thread: Docs overhaul · asks: Tag 3.21 today?",
    "",
    ""
  ].join("\n"));
});

test("its runtime context lists what it asked the user and has no answer to, with the id that takes each back", async () => {
  const { env, scope } = scopeEnv("Jarvis");
  const personal = env.agentStore.getOrCreatePersonalThread();
  const section = async () => {
    const context = (await scope.buildRuntimeContext!(personal.id))!;
    return context.slice(context.indexOf("## What you asked the user"), context.indexOf("## Tasks"));
  };
  expect(await section()).toBe("## What you asked the user\n\nNone.\n\n");
  env.agentStore.appendMessage({
    threadId: personal.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c1", toolName: "ask_user", result: { asked: true, questionId: "q_ab12cd", question: "Tag 3.21 today?\nThe changelog is written.", options: [] } }
  });
  expect(await section()).toBe("## What you asked the user\n\n- q_ab12cd · Tag 3.21 today? The changelog is written.\n\n");
  env.agentStore.appendMessage({ threadId: personal.id, role: "user", source: "user", content: { type: "text", text: "Yes.", metadata: answersMetadata([{ id: "q_ab12cd", question: "Tag 3.21 today?" }]) } });
  expect(await section()).toBe("## What you asked the user\n\nNone.\n\n");
});

test("an unnamed agent is called Mandate in its context; the system prompt carries no name", async () => {
  const { env, scope } = scopeEnv("");
  const personal = env.agentStore.getOrCreatePersonalThread();
  expect((await scope.buildRuntimeContext!(personal.id))!).toContain("Your name: Mandate");
  const prompt = await scope.buildSystemPrompt(personal.id);
  expect(prompt).toContain("You do no sustained work yourself.");
  expect(prompt).not.toContain("Mandate's personal agent is called");
});

// What it is for: it takes a matter as its own and
// follows it to a result. These are the sentences that decide what the model
// does; the rest of the prompt is free to move.
test("its prompt says it owns matters, keeps notes, sends without asking, waits once, and what it brings to the user", async () => {
  const { env, scope, workStore, planStore } = scopeEnv();
  const prompt = await scope.buildSystemPrompt(env.agentStore.getOrCreatePersonalThread().id);
  for (const sentence of [
    "You have a shell (`bash`) and can read files (`read`) on the user's machine, with the user's tools and accounts;",
    "A matter is something the user handed you to see through",
    "the conversation is not your memory of them. Your notes are.",
    "Send with `send_to_thread` without asking first",
    "put what they said in quotation marks, so the thread can tell their words from yours",
    // A message carries the user's request, not one the agent made of it.
    "A thread already working on the matter needs only that, and what was said or decided here that it has not seen.",
    // It stands in for the user: it carries their way of working, not a way of its own.
    "You act for the user. Learn how they work from what they ask for, what they decide and what they correct, so that over time you follow a matter and settle its questions as they would.",
    "Say what the user wants, and what you know of how they want this kind of work done (a saved preference, a decision they made before), marked as theirs. Add nothing that is only your own idea of doing it well: no steps, checks, deliverables or limits they have not asked for, here or before.",
    // It decides what the user has decided before, a high-risk step included; what nothing of theirs covers, it asks.
    "When the user has decided this kind of question before (a saved preference, or an earlier decision of theirs you can point to), decide it their way: answer the thread, quote what of theirs you went by, and tell the user in one line what you decided and on what.",
    "- A high-risk step is the user's to decide. When they have decided this kind before",
    "An approval, a rejection or a decision of the user's is passed on in their exact words, in quotation marks.",
    // It looks in on a thread that is still working, and corrects it.
    "against the matter's page and what you know of how the user works. Then do one of five things.",
    "It is still working, and not as the user would have it (on something they did not ask for, in a way they have turned down before, or round in circles): tell the thread now what is off and what the user wants, quoting what of theirs you go by. When you cannot tell whether they would mind, ask them here.",
    "It is still working and on course: say nothing, and set when you will look again.",
    "Come to the user once, and stop pushing the thread, when:",
    // It learns from what the user decides and corrects, without being told to.
    "Learn how the user works without being asked. When they decide a question a thread raised, or correct how a piece of work was done, and it shows how they want such things handled from now on, save it with `memory_remember`, their words from this conversation as `userQuote`",
    "One answer to one case is not yet their way: save what would hold the next time. Before you decide for them or send work out, look up what is saved (`memory_search`, the project's brief).",
    "the user's words as they said them, what they said counts as done, the decisions made since",
    // Notes are kept once a turn, hold what cannot be found again, and are read when the conversation no longer shows them.
    "Update your notes once in a turn in which a matter moved, as the last thing before your reply: make its page and the index true.",
    // A reply drafted in its thinking before the notes were updated was never written out.
    "- The user sees only the text you write; your thinking is not shown to them.",
    "the decisions made since, and where it stands now. It is not a log: the thread keeps what was sent and done, and your context lists what you are waiting to hear from, so copy neither into it.",
    "When a matter is no longer in the part of this conversation you can see, read its page before you act on it.",
    "A notice comes once.",
    "\"Sent\" is not done, and neither is the manager saying so",
    "the same thing is still missing after you asked for it once",
    "- Never widen what the user gave you: what they decided covers that kind, not more.",
    // A worker by itself is its manager's; a thread goes with its workers.
    "- You never start, archive or restore a worker on its own; a thread's manager does that.",
    // Archiving a thread.
    "- Archive a thread only when the user asks for that thread to be archived; never on your own, and never because its work looks finished. When `archive_thread` refuses, say what it found and wait for the user's word.\n- Label a thread only when the user asks you to, or when you open it for a task: then give it the task's labels, not the automatic ones. Your labels show as yours, and the user can remove them.\n"
  ]) expect([sentence, prompt.includes(sentence)]).toEqual([sentence, true]);
  for (const gone of [
    "propose_handoff", "confirm_handoff", "You look; you do not change.", "Only after they agree", "You never start, archive or restore workers;",
    // What made it write requirements of its own into a message.
    "for a reader who has not seen this conversation", "the goal, what counts as done, and what the user said that bears on it", "as they said them, what counts as done,",
    // What made half of its calls note-keeping: a note before each send, a page kept as a log and read every turn.
    "Write the matter into your notes before you send.", "Before you end a turn in which a matter moved", "as the last thing in a turn in which a matter moved", "what you sent and what you learned", "Read a matter's page before you act on it.",
    // The file tools refuse a change to a file not read first, and the index it is shown is cut when long.
    "without reading it again",
    // A relay of the user's words and nothing more: it is to act as they would.
    "The user's request is the whole request.", "Say what is wanted, not how to do it.", "You approve nothing yourself.", "It needs a decision that is the user's",
    "When their earlier words already answer it", "Then do one of four things.", "There is nothing to do yet", "Come to the user once, and stop pushing, when:"
  ]) {
    expect([gone, prompt.includes(gone)]).toEqual([gone, false]);
  }
  // The tool's own parameter says the same as the prompt: the model reads both.
  const sendText = (buildPersonalActionTools({ handoffs: stub<HandoffService>() }).find((tool) => tool.name === "send_to_thread")!
    .parameters as unknown as { shape: { text: { description?: string } } }).shape.text.description;
  expect(sendText).toBe("The message. Put the user's own words in quotation marks. A thread already on the matter needs only those and what it has not seen; a new one also needs what the user wants. Add no requirements of your own.");
  // Every tool the prompt tells it to use is one it is given: the manager's
  // it reuses by name, and its own as their builders make them (a name only
  // listed here would prove nothing).
  const given = new Set([
    ...PERSONAL_REUSED_TOOLS,
    ...buildPersonalReadTools({ agentStore: env.agentStore, workersStore: env.workers, workStore, projectsStore: env.projects, planStore }).map((tool) => tool.name),
    ...buildPersonalActionTools({ handoffs: stub<HandoffService>() }).map((tool) => tool.name),
    ...buildPersonalArchiveTools({ threadArchive: stub<Pick<ThreadArchive, "archive">>() }).map((tool) => tool.name)
  ]);
  for (const name of [
    "bash", "read", "list_projects", "list_threads", "read_thread", "list_workers", "get_worker_status", "read_worker_thread", "read_plan",
    "waiting_on_you", "send_to_thread", "message_worker", "await_stop", "archive_thread", "schedule_wake", "memory_read", "memory_search", "memory_remember",
    "memory_update", "memory_forget"
  ]) {
    expect([name, prompt.includes(`\`${name}\``), given.has(name)]).toEqual([name, true, true]);
  }
});

test("empty sections say None, so the model never reads an empty heading as missing data", () => {
  const text = renderPersonalRuntimeContext({ name: "Mandate", threads: [], workers: [], waiting: [], waits: [], questions: [], workDir: "/w", notesIndex: null, timeZone: "UTC" });
  expect(text.match(/None\./g)?.length).toBe(6);
});

test("its runtime context reads the workers' plans once, all together", async () => {
  const { scope, env: stores, planStore } = scopeEnv();
  const projectId = seedProject(stores.projects, { name: "m", workingDir: "/tmp/m", tmuxSessionName: "m" });
  seedWorker(stores.workers, projectId, { name: "alpha", tmuxWindowName: "alpha" });
  seedWorker(stores.workers, projectId, { name: "beta", tmuxWindowName: "beta" });
  const together = spyOn(planStore, "statesOfActive");
  const whole = spyOn(planStore, "get");
  try {
    await scope.buildRuntimeContext!(stores.agentStore.getOrCreatePersonalThread().id);
    expect([together.mock.calls.length, whole.mock.calls.length]).toEqual([1, 0]);
  } finally {
    together.mockRestore();
    whole.mockRestore();
  }
});

test("the notification channels are a section of their own, and none at all while nothing is set up", () => {
  const input = { name: "Mandate", threads: [], workers: [], waiting: [], waits: [], questions: [], workDir: "/w", notesIndex: null, timeZone: "UTC" };
  const without = renderPersonalRuntimeContext(input);
  expect(without).not.toContain("Notification channels");
  expect(without).toContain("## What you asked the user\n\nNone.\n\n## Tasks\n\nNo open tasks.\n\n## Sticky notes\n\nNone open.\n\n## Calendar\n\nNone.\n\n## Your notes");
  expect(renderPersonalRuntimeContext({ ...input, channels: [] })).toBe(without);
  const withChannels = renderPersonalRuntimeContext({
    ...input,
    channels: [
      { name: "Browser", about: "Mandate's open browser windows: a system notification where allowed, otherwise a pop-up in the page", on: true },
      { name: "Phone", about: "Telegram", on: true },
      { name: "Team", about: "Telegram", on: false }
    ]
  });
  expect(withChannels).toContain([
    "## What you asked the user",
    "",
    "None.",
    "",
    "## Tasks",
    "",
    "No open tasks.",
    "",
    "## Sticky notes",
    "",
    "None open.",
    "",
    "## Calendar",
    "",
    "None.",
    "",
    "## Notification channels",
    "",
    "- Browser · Mandate's open browser windows: a system notification where allowed, otherwise a pop-up in the page",
    "- Phone · Telegram",
    "- Team · Telegram · off",
    "",
    "## Your notes"
  ].join("\n"));
});

test("its runtime context lists the channels it can name, read when the context is built", async () => {
  let choices = [{ name: "Phone", about: "Telegram", on: true }];
  const { scope, env: stores } = scopeEnv("", () => null, new SkillRegistry(), { notificationChannels: () => choices });
  const id = stores.agentStore.getOrCreatePersonalThread().id;
  expect((await scope.buildRuntimeContext!(id))!).toContain("## Notification channels\n\n- Phone · Telegram\n");
  choices = [{ name: "Phone", about: "Telegram", on: false }];
  expect((await scope.buildRuntimeContext!(id))!).toContain("- Phone · Telegram · off\n");
});

test("the name is one trimmed line of at most 40 characters; blank means not named", () => {
  expect(normalizePersonalAgentName("  Jar\n vis ")).toBe("Jar vis");
  expect(normalizePersonalAgentName("   ")).toBe("");
  expect(normalizePersonalAgentName("x".repeat(41))).toBeNull();
  expect(displayPersonalAgentName("")).toBe("Mandate");
  const root = { agent: { preferences: "p" } } as Record<string, unknown>;
  applyAgentPatch(root as never, { personalAgentName: "  Friday " });
  expect((root.agent as Record<string, unknown>).personalAgentName).toBe("Friday");
  // Another agent setting saved later keeps it (AGENT_KEYS allowlist).
  applyAgentPatch(root as never, { preferences: "q" });
  expect((root.agent as Record<string, unknown>).personalAgentName).toBe("Friday");
  expect(() => applyAgentPatch(root as never, { personalAgentName: "x".repeat(41) })).toThrow(/at most 40/);
  expect(() => applyAgentPatch(root as never, { personalAgentName: 7 })).toThrow(/must be a string/);
});

test("a message posted to the personal agent's thread is checked against the personal agent's own model", () => {
  const { config } = scopeEnv();
  config.agent.manager = { ...config.agent.manager, modelRef: "main/vision" };
  config.agent.worker = { ...config.agent.worker, modelRef: "main/text" };
  config.agent.personal = { ...config.agent.personal, modelRef: "main/personal" };
  expect(modelRefForScope(config, "personal")).toBe("main/personal");
  expect(modelRefForScope(config, "manager")).toBe("main/vision");
  expect(modelRefForScope(config, "worker")).toBe("main/text");
});

test("the personal agent's thread's rows are in the non-project history, found and read like a manager thread's", () => {
  const { env } = scopeEnv();
  const personal = env.agentStore.getOrCreatePersonalThread();
  const manager = env.agentStore.createManagerThread("PR reviews");
  env.agentStore.appendMessage({ threadId: personal.id, role: "user", source: "user", content: { type: "text", text: "keep the android package for now" } });
  const history = new AgentHistoryStore(env.store.db);
  const found = history.search({ callerThreadId: manager.id, query: "android package" });
  const hit = found.threads.find((r) => r.id === personal.id);
  expect(hit?.kind).toBe("personal");
  const read = history.read({ callerThreadId: manager.id, threadId: personal.id, seq: hit!.hits[0]!.seq });
  expect(read.thread).toMatchObject({ id: personal.id, kind: "personal" });
});

test("an open wait is listed with what was sent, or that nothing was, since a time read as the messages' times", () => {
  const text = renderPersonalRuntimeContext({
    name: "Mandate", threads: [], workers: [], waiting: [], questions: [], workDir: "/w", notesIndex: null, timeZone: "Asia/Singapore",
    waits: [
      { target: "thread PR reviews", since: "2026-10-12T06:10:00.000Z", sent: "Check whether PR 15" },
      { target: "worker release", since: "2026-10-12T06:11:00.000Z", sent: null }
    ]
  });
  expect(text).toContain("## What you are waiting to hear from");
  expect(text).toContain('- thread PR reviews · since Mon 2026-10-12 14:10 +08:00 · "Check whether PR 15"');
  expect(text).toContain("- worker release · since Mon 2026-10-12 14:11 +08:00 · nothing sent");
  expect(text).not.toContain("Your open handoffs");
});

const YOUR_PAGE_SECTION = `## Your page

Beside this conversation the user sees a page you keep: a briefing for the long view of your matters — what moved, what waits on them, the numbers worth watching, the reports that came in. What it shows and how it is laid out are yours to choose; its colors and fonts come from Mandate (the agent-page skill says how).

- What the page draws from its data changes by itself. What you write on it by hand changes only when you change it: when the user asks, or when what you wrote has gone stale (a matter you summed up moved on, a report came in).
- When the user wants part of the page kept current on a schedule, list it in updates.json (the agent-page skill says how), and change the schedule when they ask.
- A small change you can make yourself: read the \`agent-page\` skill first, then edit the files under page/; the page is published when your turn ends. For anything larger, or while you are busy with something else, start a \`page\` subagent with what should change, and carry on.
- Do not edit page/ yourself while a page subagent is running.
- Before a change that reworks how the page looks (its layout, not what its data shows), show the user a design canvas of the new look first — with sample data, at the widths and in the themes the page is seen in — and change the page once they have chosen.
- The page holds long-term matters. What the user must decide now, ask here.
- What the user gives on the page reaches you as a note on your next turn. Treat it as anything else they tell you.
`;

// Canvases are its own to make: what the user reads at length or chooses
// from. The line is pinned word for word.
const CANVAS_LINE = "- When something is for the user to read at length or to choose from — a proposal, a comparison, a report, a design — make it a canvas yourself: load the `canvas-artifact` skill for a report or `canvas-design` for a design, say in a line what you are making, and give its link when it is done. The canvases you made are yours to change; a thread's canvas you can read, and to change it you ask its thread.";

test("its prompt says it makes canvases itself, among what it does itself", async () => {
  const { env, scope } = scopeEnv();
  const prompt = await scope.buildSystemPrompt(env.agentStore.getOrCreatePersonalThread().id);
  const at = prompt.indexOf(CANVAS_LINE);
  expect([at > prompt.indexOf("## What you do yourself"), at < prompt.indexOf("## Matters")]).toStrictEqual([true, true]);
});

test("its prompt tells it of its page, after Waiting, word for word", async () => {
  const { env, scope } = scopeEnv();
  const prompt = await scope.buildSystemPrompt(env.agentStore.getOrCreatePersonalThread().id);
  expect(prompt).toContain(YOUR_PAGE_SECTION);
  expect(prompt.indexOf("## Your page")).toBeGreaterThan(prompt.indexOf("## Waiting"));
  expect(prompt.indexOf("## Your page")).toBeLessThan(prompt.indexOf("## When you are woken"));
});

const BUILTIN_SKILLS = path.resolve(import.meta.dirname, "../src/server/modules/skills/builtins");

test("its skills are its own scope's: agent-page, Mandate's canvas skills (it makes canvases), and the user's for it or for managers, not the pane skill", async () => {
  const userSkills = fs.mkdtempSync(path.join(os.tmpdir(), "md-global-skills-"));
  fs.mkdirSync(path.join(userSkills, "my-notes"));
  fs.writeFileSync(path.join(userSkills, "my-notes", "SKILL.md"), "---\nname: my-notes\ndescription: How I keep notes.\n---\n\nBody.\n");
  fs.mkdirSync(path.join(userSkills, "release-steps"));
  fs.writeFileSync(path.join(userSkills, "release-steps", "SKILL.md"), "---\nname: release-steps\ndescription: How we release.\nscope: manager\n---\n\nBody.\n");
  try {
    const registry = new SkillRegistry([await loadBuiltinSkills(BUILTIN_SKILLS), await loadSkillsFromDir(userSkills)]);
    const { env, scope } = scopeEnv("", () => null, registry);
    const initial = (await scope.buildInitialContext!(env.agentStore.getOrCreatePersonalThread().id))!;
    expect(initial).toContain("- agent-page: The rules of your page beside the conversation. Read before you edit the page yourself.");
    expect(initial).toContain("- my-notes: How I keep notes.");
    expect(initial).toContain("- release-steps: How we release.");
    for (const canvas of ["canvas-artifact", "canvas-design"]) expect(initial).toContain(`- ${canvas}:`);
    expect(initial).not.toContain("- tmux-pane:");

    // Its skill tool reads the same scope: the manager's own instance is swapped out.
    const own = buildSkillTools(registry, "personal");
    const picked = pickPersonalReusedTools([toolPack("manager.all", ["manager"], ["skill", "read_skill_reference"].map(fakeTool))], own).tools;
    expect(picked.map((t) => t.name).sort()).toEqual(["read_skill_reference", "skill"]);
    const skill = picked.find((t) => t.name === "skill")!;
    const ctx = stub<ToolContext>();
    expect(String(await skill.handler({ name: "agent-page" }, ctx))).toContain("# The page");
    expect(String(await skill.handler({ name: "canvas-design" }, ctx))).toContain("# Design canvases");
    expect(await skill.handler({ name: "tmux-pane" }, ctx)).toEqual({ error: "Unknown skill: tmux-pane" });
  } finally {
    fs.rmSync(userSkills, { recursive: true, force: true });
  }
});

// Blue rows are Home's as much as the rest: the personal agent reads them in its
// context, by the same words; a thread that failed is said in the thread list.
test("its thread list says each thread's state as the sidebar does: a queued message is working, a blue thread its verdict, a stop its reason", async () => {
  const { env, scope, busy, verdicts } = scopeEnv("Jarvis");
  // A message waits to start a turn: no wake has run yet.
  const queued = env.agentStore.createManagerThread("Docs overhaul");
  busy.add(queued.id);
  const blue = env.agentStore.createManagerThread("Release plan");
  verdicts.set(blue.id, { verdict: "result", replySeq: 2, replyText: "The plan is written." });
  const halted = env.agentStore.createManagerThread("Search timeout");
  env.agentStore.finishWake(env.agentStore.createWake({ threadId: halted.id, reason: "user", triggerMessageId: null }).id, "stuck", "schedule_wake failed 5 times in a row");
  env.agentStore.createManagerThread("PR reviews");
  const text = (await scope.buildRuntimeContext!(env.agentStore.getOrCreatePersonalThread().id))!;
  const threads = text.slice(text.indexOf("## Threads"), text.indexOf("## Workers"));
  expect(threads).toContain("- Docs overhaul · working · 0 workers");
  expect(threads).toContain("- Release plan · result to read · 0 workers");
  expect(threads).toContain("- Search timeout · stopped: schedule_wake failed 5 times in a row · 0 workers");
  expect(threads).toContain("- PR reviews · idle · 0 workers");
});

test("its context lists a stopped thread's decision or result under what waits on the user", async () => {
  const { env, scope, verdicts } = scopeEnv("Jarvis");
  const plan = env.agentStore.createManagerThread("Release plan");
  const notes = env.agentStore.createManagerThread("Changelog");
  verdicts.set(plan.id, { verdict: "decision", replySeq: 2, replyText: "Ship Friday or wait?" });
  verdicts.set(notes.id, { verdict: "result", replySeq: 2, replyText: "The changelog is written." });
  const broken = env.agentStore.createManagerThread("Cache work");
  env.agentStore.finishWake(env.agentStore.createWake({ threadId: broken.id, reason: "user", triggerMessageId: null }).id, "error", "boom");
  const personal = env.agentStore.getOrCreatePersonalThread();
  const text = (await scope.buildRuntimeContext!(personal.id))!;
  const waiting = text.slice(text.indexOf("## Waiting on the user"), text.indexOf("## What you are waiting to hear from"));
  expect(waiting).toContain("- manager: Decision needed · thread: Release plan");
  expect(waiting).toContain("- manager: Result to read · thread: Changelog");
  expect(waiting.indexOf("Release plan")).toBeLessThan(waiting.indexOf("Changelog"));
  // The thread that failed is in the thread list, not here.
  expect(waiting).not.toContain("Cache work");
  expect(text).toContain("- Cache work · failed");
});

test("a thread's last activity reads as the messages' times do", () => {
  const text = renderPersonalRuntimeContext({
    name: "Mandate", workers: [], waiting: [], waits: [], questions: [], workDir: "/w", notesIndex: null, timeZone: "Asia/Singapore",
    threads: [{ title: "PR reviews", lastActivityAt: "2026-10-12T16:30:00.000Z", state: "idle", stopReason: null, workerCount: 1 }]
  });
  expect(text).toContain("- PR reviews · idle · 1 worker · last activity Tue 2026-10-13 00:30 +08:00");
});

test("its prompt says schedules are its own and duty threads report to it", async () => {
  const { env, scope } = scopeEnv();
  const prompt = await scope.buildSystemPrompt(env.agentStore.getOrCreatePersonalThread().id);
  expect(prompt).toContain("## Schedules");
  expect(prompt).toContain("Schedules are yours alone: you create, change, pause, resume and delete them; no thread can.");
  expect(prompt).toContain("Duty threads report to you, not to the user");
  expect(prompt).toContain("make it with `manage_schedule`");
});


// The task board: the prompt says who owns what; the runtime context lists the open tasks.
test("its prompt has the Tasks section, with its name for the @ the user writes", async () => {
  const { env, scope } = scopeEnv("Juno");
  const prompt = await scope.buildSystemPrompt(env.agentStore.getOrCreatePersonalThread().id);
  expect(prompt).toContain("## Tasks\n\nThe user keeps a list of tasks");
  expect(prompt).toContain("Managers never touch tasks: what a thread does reaches the task through you.");
  // The statuses in the agent's own words, as its tool takes them.
  for (const line of [
    "- The user creates tasks, writes their descriptions and due dates, marks them done or cancelled, and deletes them. You do none of these on your own. When the user asks you to note a task down, create it: the title, a description from what they said, and the due date they named. When the user tells you a task is done or cancelled, or to open a closed one again, set that status on that task, with a one-line note.",
    "move a task between todo, in progress and in review (each move with a one-line note)",
    "Move a task in todo to in progress when work starts.",
    "move the task to in review; the user checks it and marks it done.",
    "- Label a task only when you create it for the user or when they ask you to; your labels show as yours, and the user can remove them."
  ]) expect(prompt).toContain(line);
  expect(prompt).toContain("or writes @Juno in a task's comments");
  expect(prompt).not.toContain("{{name}}");
});

test("its runtime context lists the open tasks, or says there are none", async () => {
  const bare = scopeEnv();
  expect((await bare.scope.buildRuntimeContext!(bare.env.agentStore.getOrCreatePersonalThread().id))!).toContain("## Tasks\n\nNo open tasks.");
  bare.env.cleanup();
  env = freshStoresEnv("md-global-scope-tasks-");
  const holder: { board: TaskBoardService | null } = { board: null };
  const { env: e, scope } = scopeEnv("", () => null, new SkillRegistry(), { taskBoard: { list: () => holder.board!.list() } });
  holder.board = new TaskBoardService({ db: e.store.db, agentStore: e.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map() });
  const task = holder.board.create({ title: "Rework the loyalty card sign-up" }, "owner");
  expect((await scope.buildRuntimeContext!(e.agentStore.getOrCreatePersonalThread().id))!).toContain(`## Tasks\n\nRework the loyalty card sign-up (${task.id}) · todo`);
});

test("its runtime context lists the open sticky notes and those the user finished lately, or says none are open", async () => {
  const bare = scopeEnv();
  expect((await bare.scope.buildRuntimeContext!(bare.env.agentStore.getOrCreatePersonalThread().id))!).toContain("## Sticky notes\n\nNone open.");
  bare.env.cleanup();
  const holder: { notes: StickyNotesService | null } = { notes: null };
  const { env: e, scope } = scopeEnv("", () => null, new SkillRegistry(), {
    stickyNotes: { open: () => holder.notes!.open(), doneSince: (ms: number) => holder.notes!.doneSince(ms) }
  });
  holder.notes = new StickyNotesService({ db: e.store.db, sse: { emit: () => {} } as never, about: () => "Freezer temperature watch" });
  const thread = e.agentStore.createManagerThread("Freezer temperature watch");
  const open = holder.notes.add({ title: "The freezer alarm fired", body: "Two readings above the limit.", kind: "alert", threadId: thread.id });
  const finished = holder.notes.add({ title: "Docs merged", body: "Two docs went in.", kind: "fyi" });
  holder.notes.done(finished.id);
  const removed = holder.notes.add({ title: "Old alarm", body: "Stale.", kind: "later" });
  holder.notes.remove(removed.id, "resolved");
  const context = (await scope.buildRuntimeContext!(e.agentStore.getOrCreatePersonalThread().id))!;
  const section = context.slice(context.indexOf("## Sticky notes"));
  expect(section).toMatch(new RegExp(`^## Sticky notes\\n\\n- \`${open.id}\` Alert · "The freezer alarm fired" · thread "Freezer temperature watch" · left \\d\\d:\\d\\d · not seen yet\\nDone by the user lately: "Docs merged" \\(done \\d\\d:\\d\\d\\)\\n`));
  expect(section.includes("Old alarm")).toBe(false);
});

test("its runtime context lists its calendar after the sticky notes, or says None.", async () => {
  const bare = scopeEnv();
  expect((await bare.scope.buildRuntimeContext!(bare.env.agentStore.getOrCreatePersonalThread().id))!).toContain("## Sticky notes\n\nNone open.\n\n## Calendar\n\nNone.\n");
  bare.env.cleanup();
  const holder: { calendar: CalendarService | null } = { calendar: null };
  const { env: e, scope } = scopeEnv("", () => null, new SkillRegistry(), {
    calendar: { entries: () => holder.calendar!.entries(), userChangesSince: (ms: number) => holder.calendar!.userChangesSince(ms) }
  });
  holder.calendar = new CalendarService({ store: new CalendarStore(e.store.db), sse: { emit: () => {} } as never, timeZone: "UTC", deliver: () => () => {} });
  const weekly = holder.calendar.add({ title: "Weekly review", note: "Review every schedule's runs.", repeat: "0 9 * * 1" });
  const context = (await scope.buildRuntimeContext!(e.agentStore.getOrCreatePersonalThread().id))!;
  const section = context.slice(context.indexOf("## Calendar"));
  expect(section).toMatch(new RegExp(`^## Calendar\n\n- \`${weekly.id}\` "Weekly review" · every Monday 09:00( \\([^)]+\\))? · next \\w{3} \\d{1,2} \\w{3} \\d\\d:\\d\\d\n`));
  holder.calendar.dispose();
});

test("its system prompt carries the calendar section after Schedules, word for word", async () => {
  const { env, scope } = scopeEnv();
  const prompt = await scope.buildSystemPrompt(env.agentStore.getOrCreatePersonalThread().id);
  const section = [
    "## Calendar",
    "",
    "Your calendar holds what is planned for a time, once or on a repeat: a reminder for the user, or work you do yourself at that time. The user sees it on their Calendar page and can pause or delete entries there.",
    "",
    "- When the user asks to be reminded of something, or asks you to do something at a time or on a repeat, put it on the calendar with `calendar`: a title they understand at a glance, and a note that tells you what to do when it is due.",
    "- Each entry wakes you every time it is due. To watch for something that is usually quiet, use a schedule with a check instead. To look again at work in progress, use `schedule_wake`.",
    "- An entry the user paused or deleted stays that way: do not resume it or add it again unless they ask.",
    "- Your runtime context lists your entries and what the user changed on them lately.",
    ""
  ].join("\n");
  const at = prompt.indexOf(section);
  expect(at > prompt.indexOf("## Schedules")).toBe(true);
  expect(at < prompt.indexOf("## When you are woken")).toBe(true);
});

test("its system prompt carries the sticky notes section after Reaching the user, word for word", async () => {
  const { env, scope } = scopeEnv();
  const prompt = await scope.buildSystemPrompt(env.agentStore.getOrCreatePersonalThread().id);
  const at = prompt.indexOf("## Sticky notes\n\nThe user often comes back after a while to many messages and reads the newest, so something you told them earlier is easily missed. A sticky note stays on their Notes page until they mark it done.\n");
  expect(at > prompt.indexOf("## Reaching the user")).toBe(true);
  expect(prompt.includes("- A note the user marked done is settled: do not leave it again unless something new happens.\n- Your runtime context lists the open notes and those marked done lately.")).toBe(true);
});
