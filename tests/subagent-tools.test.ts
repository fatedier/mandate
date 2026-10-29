import { expect, test } from "bun:test";
import { z } from "zod";
import { buildGlobalSubagentTool, buildSubagentTools } from "../src/server/modules/agent/tools/subagent-tools.js";
import type { SubagentService } from "../src/server/runtime/subagents.js";
import type { BackgroundTaskDto } from "../src/shared/api-contracts.js";
import { toolContext } from "./helpers/typed.js";
import type { TaskListItem } from "../src/server/runtime/task-list.js";

// The two tools as the model reads them, word for word, and what each hands
// the service and says back.

function taskDto(fields: Partial<BackgroundTaskDto> = {}): BackgroundTaskDto {
  return {
    id: "task_1", kind: "subagent", parentThreadId: "thr_test", childThreadId: "thr_child", type: "general",
    title: "Find the retry call sites", status: "running", stoppedBy: null, error: null,
    createdAt: "2000-01-01T00:00:00.000Z", startedAt: "2000-01-01T00:00:00.000Z", finishedAt: null, seq: 1, exitCode: null, command: null, outputPath: null,
    ...fields
  };
}

function tools(options: { status?: "started" | "queued"; stopped?: BackgroundTaskDto | null; subagentThreads?: string[]; commandIds?: string[]; listed?: TaskListItem[] } = {}) {
  const started: Array<Parameters<SubagentService["start"]>[0]> = [];
  const stops: Array<Parameters<SubagentService["stop"]>> = [];
  const commandStops: Array<[string, string, string | undefined]> = [];
  const listedFor: string[] = [];
  const [subagent, stopTask, listTasks, ...others] = buildSubagentTools({
    commands: {
      stop: (taskId, by, requesterThreadId) => {
        commandStops.push([taskId, by, requesterThreadId]);
        return taskDto({ id: taskId, kind: "command", childThreadId: null, title: "Run the e2e suite", command: "make e2e", outputPath: "/out/x.log" });
      }
    },
    kindOf: (taskId) => ((options.commandIds ?? []).includes(taskId) ? "command" : "subagent"),
    listTasks: (threadId) => { listedFor.push(threadId); return options.listed ?? []; },
    service: {
      start: (input) => {
        started.push(input);
        return { task: taskDto({ title: input.title }), status: options.status ?? "started" };
      },
      stop: (...args) => {
        stops.push(args);
        return options.stopped === undefined ? taskDto() : options.stopped;
      }
    },
    isSubagentThread: (threadId) => (options.subagentThreads ?? []).includes(threadId)
  });
  return { subagent: subagent!, stopTask: stopTask!, listTasks: listTasks!, others, started, stops, commandStops, listedFor };
}

const UNTIL_IT_ARRIVES = "Until then you know nothing of what it did: do not report, assume or predict it. Carry on with other work or answer the user meanwhile, and do not work on the same files or the same question yourself.";

test("what the model reads of subagent and stop_task, word for word", () => {
  const { subagent, stopTask, listTasks, others } = tools();
  expect([subagent.name, stopTask.name, listTasks.name, others]).toEqual(["subagent", "stop_task", "list_tasks", []]);
  expect(subagent.description).toBe([
    "Start a subagent: a separate agent that does one self-contained job in the background and reports back. This call returns at once; its result arrives later as a message in this conversation. The user can watch it run and stop it.",
    "",
    "It works with files and the shell as you do (read, write, edit, bash). Use it for work whose steps would crowd your context — tracking down how something works, checking a hypothesis across many files, surveying options, reviewing a change, a self-contained change — or to do several such things at once. Not for a lookup you can do in a step or two, or for work that needs back-and-forth.",
    "",
    "A subagent starts with no context. It has not seen this conversation; it knows your task text and what it reads, nothing else. Brief it like a capable colleague who just walked in:",
    "- what you are trying to accomplish, and why;",
    "- what you already know or have ruled out, with paths and names;",
    "- whether it should change files or only look: it does not know your intent;",
    "- what to hand back, and how short (\"under 200 words\", \"a list of the call sites\").",
    "Do the understanding yourself: write a brief that shows you understood (paths, line numbers, what to change), never \"based on your findings, fix it\".",
    "",
    "While it runs, carry on with other work. You know nothing of its result until its message arrives: do not report, assume or describe it before then, and if the user asks, say it is still running. Its answer says what it meant to do, not necessarily what it did: check what you rely on. At most 6 of this conversation's subagents run at once; more wait their turn and start by themselves."
  ].join("\n"));
  expect(stopTask.description).toBe(
    "Stop a background task this conversation started — a subagent or a background command — by the taskId it returned: when it is no longer needed, or it went wrong (for a subagent whose brief was wrong, start a new one with a better brief). A queued subagent never starts; a command is killed with what it started. Files already changed stay as they are."
  );
  expect(listTasks.description).toBe(
    "List the background tasks this conversation has running or queued — subagents and background commands — with each one's taskId and how long it has run; for a command, what it runs, how much output it has written, and its outputPath (read it for the latest lines). Use it to decide what to stop or keep. Do not call it in a loop to wait for one to end: you are woken when it does."
  );
  expect((z.toJSONSchema(listTasks.parameters) as { properties: Record<string, unknown> }).properties).toEqual({});
  const params = z.toJSONSchema(subagent.parameters) as { properties: Record<string, { description?: string }>; required?: string[] };
  expect(Object.fromEntries(Object.entries(params.properties).map(([name, p]) => [name, p.description]))).toEqual({
    title: "A short name for this job, 3 to 6 words, shown to the user: for example \"Find the retry call sites\".",
    task: "Everything the subagent needs, in full. It sees nothing else of this conversation."
  });
  expect(params.required).toEqual(["title", "task"]);
  const stopParams = z.toJSONSchema(stopTask.parameters) as { properties: Record<string, { description?: string }>; required?: string[] };
  expect([stopParams.properties.taskId?.description, stopParams.required]).toEqual(["The taskId the call that started it returned.", ["taskId"]]);
});

test("a call starts the run for its own conversation and returns at once with what the model must know", async () => {
  const t = tools();
  const result = await t.subagent.handler(
    { title: "Find the retry call sites", task: "  Find every call site of retryWake under src and list them with file and line.  " },
    toolContext({ threadId: "thr_test" })
  );
  expect(t.started).toStrictEqual([{ parentThreadId: "thr_test", title: "Find the retry call sites", task: "Find every call site of retryWake under src and list them with file and line." }]);
  expect(result).toEqual({
    taskId: "task_1",
    status: "started",
    message: `Started the subagent “Find the retry call sites”. Its result arrives as a message in this conversation when it finishes. ${UNTIL_IT_ARRIVES}`
  });
});

test("with six of this conversation's running it is queued, and the model is told it starts by itself", async () => {
  const t = tools({ status: "queued" });
  expect(await t.subagent.handler({ title: "Map the cache layer", task: "Map it." }, toolContext())).toEqual({
    taskId: "task_1",
    status: "queued",
    message: `Queued the subagent “Map the cache layer”: 6 of this conversation's subagents are already running, and it starts by itself when one of them finishes. Its result arrives as a message in this conversation. ${UNTIL_IT_ARRIVES}`
  });
});

test("a subagent cannot start one, and an empty task is refused; neither starts anything", async () => {
  const t = tools({ subagentThreads: ["thr_child"] });
  expect(await t.subagent.handler({ title: "Nested", task: "Do it." }, toolContext({ threadId: "thr_child" })))
    .toEqual({ error: "A subagent cannot start another subagent. Do the job yourself." });
  expect(await t.subagent.handler({ title: "Empty", task: " \n " }, toolContext()))
    .toEqual({ error: "Write the task: the subagent sees nothing else." });
  expect(t.started).toStrictEqual([]);
});

test("a title written on several lines is kept on one", async () => {
  const t = tools();
  await t.subagent.handler({ title: "  Find the\nretry   call sites ", task: "Find them." }, toolContext());
  expect(t.started[0]!.title).toBe("Find the retry call sites");
});

test("stop_task stops a task of its own conversation, as its agent", async () => {
  const t = tools();
  expect(await t.stopTask.handler({ taskId: "task_1" }, toolContext({ threadId: "thr_test" })))
    .toEqual({ stopped: true, message: "Stopped the subagent “Find the retry call sites”." });
  expect(t.stops).toStrictEqual([["task_1", "agent", "thr_test"]]);
});

test("a task of another conversation, or one already ended, is not this conversation's to stop", async () => {
  const t = tools({ stopped: null });
  expect(await t.stopTask.handler({ taskId: "task_9" }, toolContext())).toEqual({ error: "No running task task_9 of this conversation." });
});

test("stop_task stops a background command of its own conversation, as its agent, and says so", async () => {
  const t = tools({ commandIds: ["task_cmd"] });
  expect(await t.stopTask.handler({ taskId: "task_cmd" }, toolContext({ threadId: "thr_test" })))
    .toEqual({ stopped: true, message: "Stopped the background command “Run the e2e suite”." });
  expect([t.commandStops, t.stops]).toEqual([[["task_cmd", "agent", "thr_test"]], []]);
});

test("list_tasks lists this conversation's running and queued tasks", async () => {
  const listed: TaskListItem[] = [
    { taskId: "task_sub", kind: "subagent", title: "0.72 release notes", status: "running", runningFor: "1m 12s" },
    { taskId: "task_cmd", kind: "command", title: "Run the e2e suite", status: "running", runningFor: "7m 33s", command: "make e2e", outputPath: "/out/task_cmd.log", outputBytes: 217088, outputLines: 1284 }
  ];
  const t = tools({ listed });
  expect(await t.listTasks.handler({}, toolContext({ threadId: "thr_test" }))).toEqual({ tasks: listed });
  expect(t.listedFor).toStrictEqual(["thr_test"]);
});

const PAGE_TYPE_TEXT = [
  "type picks the kind of subagent:",
  "- general (the default): the job described above.",
  "- page: changes your page. Put in task what should change and what it should say, with what it needs to know: it knows the page and its rules, not this conversation. It writes only the page. Its result reaches you as a note: it wakes you when you started it while answering the user, or when it fails; otherwise you read it on your next turn. Page subagents run one at a time, in the order started."
].join("\n");

function globalTool(status: "started" | "queued" = "started", answering = false) {
  const started: Array<Parameters<SubagentService["start"]>[0]> = [];
  const tool = buildGlobalSubagentTool({
    service: {
      start: (input) => { started.push(input); return { task: taskDto({ title: input.title, type: input.type ?? "general" }), status }; },
      stop: () => null
    },
    isSubagentThread: (threadId) => threadId === "thr_child",
    answeringUser: () => answering
  });
  return { tool, started };
}

test("Your agent's subagent tool offers the page type, word for word; managers' and workers' tools are unchanged", async () => {
  const { subagent: managers } = tools();
  const { tool, started } = globalTool();
  expect(tool.name).toBe("subagent");
  expect(tool.description).toBe(`${managers.description}\n\n${PAGE_TYPE_TEXT}`);
  const params = z.toJSONSchema(tool.parameters) as { properties: Record<string, { description?: string; enum?: string[] }>; required?: string[] };
  expect(params.properties.type).toMatchObject({ enum: ["general", "page"], description: "'general' (the default) for a job as described above; 'page' for a change to your page." });
  expect(params.required).toEqual(["title", "task"]);
  // A manager's and a worker's: no type, and one given is dropped.
  const managerParams = z.toJSONSchema(managers.parameters) as { properties: Record<string, unknown> };
  expect(Object.keys(managerParams.properties)).toEqual(["title", "task"]);
  expect(managers.parameters.parse({ title: "A", task: "B", type: "page" })).toEqual({ title: "A", task: "B" });

  // A general job reads as a manager's does; a page one started on its own
  // says its result is a quiet note unless it fails.
  expect(await tool.handler({ title: "Look it up", task: "Look it up." }, toolContext({ threadId: "thr_g" }))).toEqual({
    taskId: "task_1", status: "started",
    message: `Started the subagent “Look it up”. Its result arrives as a message in this conversation when it finishes. ${UNTIL_IT_ARRIVES}`
  });
  expect(await tool.handler({ title: "Put  usage\nfirst", task: " Move the usage chart to the top. ", type: "page" }, toolContext({ threadId: "thr_g" }))).toEqual({
    taskId: "task_1", status: "started",
    message: "Started the page subagent “Put usage first”. Its result reaches you as a note on your next turn; it wakes you only if it fails. Until then do not edit page/ yourself."
  });
  expect(started).toStrictEqual([
    { parentThreadId: "thr_g", title: "Look it up", task: "Look it up." },
    { parentThreadId: "thr_g", title: "Put usage first", task: "Move the usage chart to the top.", type: "page", wakeWhenDone: false }
  ]);
  const queued = globalTool("queued");
  expect(await queued.tool.handler({ title: "Next", task: "Do it.", type: "page" }, toolContext({ threadId: "thr_g" }))).toMatchObject({
    status: "queued",
    message: "Queued the page subagent “Next”: another page subagent is running, and this one starts by itself when it ends. Its result reaches you as a note on your next turn; it wakes you only if it fails. Until then do not edit page/ yourself."
  });
  // Started while answering the user: its end wakes Your agent to tell them.
  const answering = globalTool("started", true);
  expect(await answering.tool.handler({ title: "Usage first", task: "Do it.", type: "page" }, toolContext({ threadId: "thr_g" }))).toMatchObject({
    message: "Started the page subagent “Usage first”. When it ends, its result reaches you as a note and wakes you, so you can tell the user. Until then do not edit page/ yourself."
  });
  expect(answering.started.at(-1)).toMatchObject({ type: "page", wakeWhenDone: true });
  const answeringQueued = globalTool("queued", true);
  expect(await answeringQueued.tool.handler({ title: "Next", task: "Do it.", type: "page" }, toolContext({ threadId: "thr_g" }))).toMatchObject({
    message: "Queued the page subagent “Next”: another page subagent is running, and this one starts by itself when it ends. When it ends, its result reaches you as a note and wakes you, so you can tell the user. Until then do not edit page/ yourself."
  });
  // Refused as the general one is: from a subagent, or with no task.
  expect(await tool.handler({ title: "Nested", task: "Do it.", type: "page" }, toolContext({ threadId: "thr_child" })))
    .toEqual({ error: "A subagent cannot start another subagent. Do the job yourself." });
  expect(await tool.handler({ title: "Empty", task: " ", type: "page" }, toolContext({ threadId: "thr_g" })))
    .toEqual({ error: "Write the task: the subagent sees nothing else." });
});
