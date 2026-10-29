import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { SubagentService } from "../../../runtime/subagents.js";
import type { BackgroundCommandService } from "../../../runtime/background-commands.js";
import type { TaskList, TaskListItem } from "../../../runtime/task-list.js";
import { SUBAGENT_LIMITS, type BackgroundTaskDto } from "../../../../shared/api-contracts.js";

/** What the model reads of `subagent`: what it is for, how to brief it, and
 *  how to wait for its result. */
const SUBAGENT_DESCRIPTION = [
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
  `While it runs, carry on with other work. You know nothing of its result until its message arrives: do not report, assume or describe it before then, and if the user asks, say it is still running. Its answer says what it meant to do, not necessarily what it did: check what you rely on. At most ${SUBAGENT_LIMITS.perThread} of this conversation's subagents run at once; more wait their turn and start by themselves.`
].join("\n");

/** Your agent's `subagent` alone: its page subagent. */
const PAGE_TYPE_DESCRIPTION = [
  "type picks the kind of subagent:",
  "- general (the default): the job described above.",
  "- page: changes your page. Put in task what should change and what it should say, with what it needs to know: it knows the page and its rules, not this conversation. It writes only the page. Its result reaches you as a note: it wakes you when you started it while answering the user, or when it fails; otherwise you read it on your next turn. Page subagents run one at a time, in the order started."
].join("\n");

const STOP_TASK_DESCRIPTION =
  "Stop a background task this conversation started — a subagent or a background command — by the taskId it returned: when it is no longer needed, or it went wrong (for a subagent whose brief was wrong, start a new one with a better brief). A queued subagent never starts; a command is killed with what it started. Files already changed stay as they are.";

const LIST_TASKS_DESCRIPTION =
  "List the background tasks this conversation has running or queued — subagents and background commands — with each one's taskId and how long it has run; for a command, what it runs, how much output it has written, and its outputPath (read it for the latest lines). Use it to decide what to stop or keep. Do not call it in a loop to wait for one to end: you are woken when it does.";

const UNTIL_IT_ARRIVES =
  "Until then you know nothing of what it did: do not report, assume or predict it. Carry on with other work or answer the user meanwhile, and do not work on the same files or the same question yourself.";

const subagentParams = z.object({
  title: z.string().trim().min(1).max(120).describe("A short name for this job, 3 to 6 words, shown to the user: for example \"Find the retry call sites\"."),
  task: z.string().describe("Everything the subagent needs, in full. It sees nothing else of this conversation.")
});

const globalSubagentParams = subagentParams.extend({
  type: z.enum(["general", "page"]).optional().describe("'general' (the default) for a job as described above; 'page' for a change to your page.")
});

const stopTaskParams = z.object({
  taskId: z.string().trim().min(1).describe("The taskId the call that started it returned.")
});

type SubagentResult = { taskId: string; status: "started" | "queued"; message: string } | { error: string };
type StopTaskResult = { stopped: true; message: string } | { error: string };

const listTasksParams = z.object({}).strict();

interface SubagentToolDeps {
  service: Pick<SubagentService, "start" | "stop">;
  /** A subagent's own thread: it starts none. */
  isSubagentThread(threadId: string): boolean;
  /** Background commands: stop_task stops them too. */
  commands?: Pick<BackgroundCommandService, "stop">;
  /** Which kind a task is: each is stopped by its own service. */
  kindOf?: TaskList["kindOf"];
  /** What list_tasks lists. */
  listTasks?: TaskList["list"];
}

export function buildSubagentTools(deps: SubagentToolDeps): ToolDefinition[] {
  return [buildSubagentTool(deps), buildStopTaskTool(deps), buildListTasksTool(deps)];
}

function buildSubagentTool(deps: SubagentToolDeps): ToolDefinition<z.infer<typeof subagentParams>, SubagentResult> {
  return {
    name: "subagent",
    description: SUBAGENT_DESCRIPTION,
    parameters: subagentParams,
    handler: async (args, ctx) => {
      if (deps.isSubagentThread(ctx.threadId)) return { error: "A subagent cannot start another subagent. Do the job yourself." };
      const task = args.task.trim();
      if (!task) return { error: "Write the task: the subagent sees nothing else." };
      // Shown on one line wherever it is named: the strip, the list, the result.
      const title = args.title.replace(/\s+/g, " ").trim();
      const started = deps.service.start({ parentThreadId: ctx.threadId, title, task });
      return { taskId: started.task.id, status: started.status, message: startedMessage(started.task, started.status) };
    }
  };
}

/** Your agent's `subagent`: the same tool, with the page subagent beside the
 *  general one. Managers and workers keep theirs (buildSubagentTools). */
export function buildGlobalSubagentTool(deps: Pick<SubagentToolDeps, "service" | "isSubagentThread"> & {
  /** Its turn answers the user: a page subagent started now wakes it at its end. */
  answeringUser?: (threadId: string) => boolean;
}): ToolDefinition<z.infer<typeof globalSubagentParams>, SubagentResult> {
  const general = buildSubagentTool(deps);
  return {
    name: general.name,
    description: `${SUBAGENT_DESCRIPTION}\n\n${PAGE_TYPE_DESCRIPTION}`,
    parameters: globalSubagentParams,
    handler: async (args, ctx) => {
      if (args.type !== "page") return general.handler(args, ctx);
      if (deps.isSubagentThread(ctx.threadId)) return { error: "A subagent cannot start another subagent. Do the job yourself." };
      const task = args.task.trim();
      if (!task) return { error: "Write the task: the subagent sees nothing else." };
      const title = args.title.replace(/\s+/g, " ").trim();
      const answering = deps.answeringUser?.(ctx.threadId) ?? false;
      const started = deps.service.start({ parentThreadId: ctx.threadId, title, task, type: "page", wakeWhenDone: answering });
      return { taskId: started.task.id, status: started.status, message: pageStartedMessage(started.task, started.status, answering) };
    }
  };
}

function buildStopTaskTool(deps: SubagentToolDeps): ToolDefinition<z.infer<typeof stopTaskParams>, StopTaskResult> {
  return {
    name: "stop_task",
    description: STOP_TASK_DESCRIPTION,
    parameters: stopTaskParams,
    handler: async ({ taskId }, ctx) => {
      const command = deps.commands && deps.kindOf?.(taskId) === "command";
      const stopped = command ? deps.commands!.stop(taskId, "agent", ctx.threadId) : deps.service.stop(taskId, "agent", ctx.threadId);
      if (!stopped) return { error: `No running task ${taskId} of this conversation.` };
      return { stopped: true, message: command ? `Stopped the background command “${stopped.title}”.` : `Stopped the subagent “${stopped.title}”.` };
    }
  };
}

function buildListTasksTool(deps: SubagentToolDeps): ToolDefinition<z.infer<typeof listTasksParams>, { tasks: TaskListItem[] }> {
  return {
    name: "list_tasks",
    description: LIST_TASKS_DESCRIPTION,
    parameters: listTasksParams,
    handler: async (_args, ctx) => ({ tasks: deps.listTasks?.(ctx.threadId) ?? [] })
  };
}

/** Its result is a note: started while answering the user, it wakes Your
 *  agent to tell them; otherwise only a failure does. */
function pageStartedMessage(task: BackgroundTaskDto, status: "started" | "queued", answering: boolean): string {
  const after = answering
    ? "When it ends, its result reaches you as a note and wakes you, so you can tell the user. Until then do not edit page/ yourself."
    : "Its result reaches you as a note on your next turn; it wakes you only if it fails. Until then do not edit page/ yourself.";
  return status === "started"
    ? `Started the page subagent “${task.title}”. ${after}`
    : `Queued the page subagent “${task.title}”: another page subagent is running, and this one starts by itself when it ends. ${after}`;
}

function startedMessage(task: BackgroundTaskDto, status: "started" | "queued"): string {
  return status === "started"
    ? `Started the subagent “${task.title}”. Its result arrives as a message in this conversation when it finishes. ${UNTIL_IT_ARRIVES}`
    : `Queued the subagent “${task.title}”: ${SUBAGENT_LIMITS.perThread} of this conversation's subagents are already running, and it starts by itself when one of them finishes. Its result arrives as a message in this conversation. ${UNTIL_IT_ARRIVES}`;
}
