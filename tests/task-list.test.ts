import { expect, test } from "bun:test";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { listTasksFor, tasksContext } from "../src/server/runtime/task-list.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { onCleanup } from "./helpers/cleanup.js";

// What list_tasks, get_feature_status and the context after a compaction say
// of a conversation's queued and running tasks.

test("a conversation's queued and running tasks, oldest first; a command with what it has written; nothing of another conversation or that ended", () => {
  const env = freshStoresEnv("md-task-list-");
  onCleanup(env.cleanup);
  const tasks = new BackgroundTaskStore(env.store.db);
  const parent = env.agentStore.createManagerThread("Release");
  const other = env.agentStore.createManagerThread("Docs");
  // Subagent rows take the real time; a command its start: the clock the
  // order is read on, so commands start after the subagents were asked for.
  const base = Date.now();
  const at = base + 460_000;
  const sub = tasks.create({ id: "task_sub", parentThreadId: parent.id, childThreadId: env.agentStore.createSubagentThread("task_sub").id, type: "general", title: "0.72 release notes", task: "x" });
  tasks.markRunning(sub.id, new Date(at - 72_000).toISOString());
  tasks.create({ id: "task_q", parentThreadId: parent.id, childThreadId: env.agentStore.createSubagentThread("task_q").id, type: "general", title: "Survey the logs", task: "y" });
  tasks.createCommand({ id: "task_cmd", parentThreadId: parent.id, title: "Run the e2e suite", command: "make e2e", outputPath: "/out/task_cmd.log", pid: null, startedAt: new Date(at - 453_000).toISOString() });
  const ended = tasks.createCommand({ id: "task_done", parentThreadId: parent.id, title: "Lint", command: "make lint", outputPath: "/out/task_done.log", pid: null, startedAt: new Date(at).toISOString() });
  tasks.finishCommand(ended.id, { status: "finished", exitCode: 0, reply: null, error: null, at: new Date(at).toISOString() });
  tasks.createCommand({ id: "task_other", parentThreadId: other.id, title: "Elsewhere", command: "true", outputPath: "/out/o.log", pid: null, startedAt: new Date(at).toISOString() });
  const items = listTasksFor({ tasks, stats: (id) => (id === "task_cmd" ? { bytes: 217088, lines: 1284, lastLine: "ok" } : null), now: () => at }, parent.id);
  expect(items).toEqual([
    { taskId: "task_sub", kind: "subagent", title: "0.72 release notes", status: "running", runningFor: "1m 12s" },
    { taskId: "task_q", kind: "subagent", title: "Survey the logs", status: "queued", runningFor: "" },
    { taskId: "task_cmd", kind: "command", title: "Run the e2e suite", status: "running", runningFor: "7m 33s", command: "make e2e", outputPath: "/out/task_cmd.log", outputBytes: 217088, outputLines: 1284 }
  ]);
  expect(tasksContext(items)).toBe([
    "Background tasks running when this conversation was compacted (list_tasks shows them as they are now):",
    "- task_sub · Subagent · 0.72 release notes · running 1m 12s",
    "- task_q · Subagent · Survey the logs · queued",
    "- task_cmd · Command · Run the e2e suite · `make e2e` · running 7m 33s"
  ].join("\n"));
  expect(tasksContext([])).toBeNull();
});
