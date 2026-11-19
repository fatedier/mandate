import type { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { AgentStore } from "../../agent/agent-store.js";
import { localTimeZone } from "../../../platform/time/agent-time.js";
import type { TaskStatus } from "../../../../shared/api/task-board.js";
import { TASK_STATUSES } from "../../../../shared/task-board.js";
import { TaskBoardRefusal, type TaskBoardService } from "../task-board-service.js";
import { renderTaskBlock, renderTaskLine, renderTasksSection, TASK_STATUS_WORD, type TaskTextClock } from "../task-text.js";
import { taskBoardParams } from "./task-board-tools-schema.js";

/** The board's status for each word the agent may set. */
const STATUS_OF_WORD = new Map(TASK_STATUSES.map((status) => [TASK_STATUS_WORD[status], status]));

const DESCRIPTION = [
  "The user's task board. Actions:",
  "- list: the open tasks (includeClosed adds backlog, done and cancelled).",
  "- read: one task: its description, Result, linked threads and comments, the unanswered ones marked.",
  "- create: a task, only when the user asks you to note one down (title, description, optional due date and time).",
  "- set_status: backlog, todo, in progress, in review, done or cancelled, with a one-line note that becomes your comment. backlog, done and cancelled, and moving a task out of them, only when the user tells you to for that task.",
  "- write_result: the task's Result in Markdown — what came out, where to see it, what is left — replacing the one before.",
  "- comment: a comment on the task.",
  "- add_label / remove_label: a label on the task (`label`), a word or two. Reuse the board's labels; add one only when you create the task for the user or they ask.",
  "- link_thread / unlink_thread: connect a manager thread to the task or take it off. send_to_thread with taskId links the thread it sends to."
].join("\n");

const NOTE_REQUIRED = "Say in one line why it moves: the note is your comment on the task.";
const MANAGER_ONLY = "Only a manager thread can be linked to a task.";
const noSuchTask = (id: string) => `No such task: ${id}.`;

/** A value the model gave, or undefined for a blank or null one. */
const given = (value: string | null | undefined): string | undefined => (value?.trim() ? value.trim() : undefined);

export interface TaskBoardToolDeps {
  taskBoard: TaskBoardService;
  agentStore: Pick<AgentStore, "getThreadById">;
  agentName: () => string;
  timeZone?: () => string;
  now?: () => number;
}

/** The personal agent's one task tool. Managers have none: what a thread
 *  does reaches a task through the personal agent. */
export function buildTaskBoardTools(deps: TaskBoardToolDeps): ToolDefinition[] {
  const clock = (): TaskTextClock => ({ timeZone: deps.timeZone?.() ?? localTimeZone(), now: deps.now?.() ?? Date.now() });
  const board = deps.taskBoard;
  const live = (id: string | undefined) => {
    const task = id ? board.detail(id) : null;
    if (!task || task.deletedAt) throw new TaskBoardRefusal(noSuchTask(id ?? ""), 404);
    return task;
  };
  const line = (id: string) => renderTaskLine(live(id), clock());

  const tool: ToolDefinition<z.infer<typeof taskBoardParams>, unknown> = {
    name: "task_board",
    description: DESCRIPTION,
    parameters: taskBoardParams,
    handler: async (args) => {
      const taskId = given(args.taskId);
      try {
        switch (args.action) {
          case "list":
            return args.includeClosed
              ? board.list().map((t) => renderTaskLine(t, clock())).join("\n") || "No open tasks."
              : renderTasksSection(board.list(), clock());
          case "read":
            return renderTaskBlock(live(taskId), "personal", { ...clock(), agentName: deps.agentName() });
          case "create": {
            const task = board.create({ title: given(args.title) ?? "", description: args.description ?? "", dueDate: given(args.dueDate) ?? null, dueTime: given(args.dueTime) ?? null }, "agent");
            return renderTaskLine(task, clock());
          }
          case "set_status": {
            const status = args.status ? STATUS_OF_WORD.get(args.status) : undefined;
            const task = live(taskId);
            if (!status) throw new TaskBoardRefusal("status is backlog, todo, in progress, in review, done or cancelled");
            if (task.status !== status && !given(args.note)) return { error: NOTE_REQUIRED };
            board.setStatus(task.id, status as TaskStatus, "agent", given(args.note));
            return line(task.id);
          }
          case "write_result":
            board.writeResult(live(taskId).id, args.result ?? "");
            return line(taskId!);
          case "comment":
            board.comment(live(taskId).id, args.text ?? "", "agent");
            return line(taskId!);
          case "add_label":
            board.addLabel(live(taskId).id, args.label ?? "", "agent");
            return line(taskId!);
          case "remove_label":
            board.removeLabel(live(taskId).id, args.label ?? "");
            return line(taskId!);
          case "link_thread":
          case "unlink_thread": {
            const task = live(taskId);
            const threadId = given(args.threadId);
            const thread = threadId ? deps.agentStore.getThreadById(threadId) : null;
            if (!thread || thread.scope !== "manager") return { error: MANAGER_ONLY };
            if (args.action === "link_thread") board.link(task.id, thread.id);
            else board.unlink(task.id, thread.id);
            return line(task.id);
          }
        }
      } catch (err) {
        if (err instanceof TaskBoardRefusal) return { error: err.message };
        throw err;
      }
    }
  };
  return [tool as ToolDefinition];
}
