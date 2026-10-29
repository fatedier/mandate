import type { BackgroundTaskDto } from "../../src/shared/api-contracts.js";
import type { AgentMessageDto } from "../../src/shared/api/agents.js";
import { useBackgroundTasksStore } from "../../src/client/store/background-tasks.js";
import { agentMessage } from "./typed.js";

/**
 * Client fixtures for background tasks: a task as the server lists it, and
 * the page a subagent's conversation reads as.
 */

/** Empties what the background-tasks store holds: every conversation's tasks,
 *  counts and pages, and the details and tasks read by their id. */
export function resetBackgroundTasksStore() {
  useBackgroundTasksStore.setState({ byThread: new Map(), pages: new Map(), details: new Map(), loose: new Map(), liveLines: new Map() });
}

export function backgroundTask(over: Partial<BackgroundTaskDto> = {}): BackgroundTaskDto {
  return {
    id: "task_1",
    kind: "subagent",
    parentThreadId: "thr_m",
    childThreadId: "thr_child",
    type: "general",
    title: "0.72 release notes",
    status: "running",
    stoppedBy: null,
    error: null,
    createdAt: "2026-10-18T09:00:00.000Z",
    startedAt: "2026-10-18T09:00:01.000Z",
    finishedAt: null,
    // A later change takes a greater number: queued, running, ended.
    seq: over.status === "queued" ? 1 : over.status === undefined || over.status === "running" ? 2 : 3,
    exitCode: null,
    command: null,
    outputPath: null,
    ...over
  };
}

const at = (time: string) => `2026-10-18T${time}.000Z`;

/** A subagent's conversation as GET agentThread answers it. "waiting": its
 *  task alone (it has not started). "on": one read done and a second under
 *  way in its running wake. "done": both reads done, a command run, and its
 *  reply; its wake over. */
export function subagentPage(threadId: string, stage: "waiting" | "on" | "done") {
  const message = (seq: number, fields: Omit<Parameters<typeof agentMessage>[0], "id" | "threadId" | "seq">) =>
    agentMessage({ id: `${threadId}-${seq}`, threadId, seq, ...fields });
  const messages: AgentMessageDto[] = [
    message(1, { role: "user", source: "subagent-task", createdAt: at("09:00:01"), content: { type: "text", text: "Summarise what changed in 0.72 from the material below." } })
  ];
  if (stage !== "waiting") {
    messages.push(
      message(2, { role: "assistant", source: "self", wakeId: "w_child", createdAt: at("09:00:02"), content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "k1", toolName: "read", args: { path: "/repo/CHANGELOG.md" } }] } }),
      message(3, { role: "tool", source: "self", wakeId: "w_child", createdAt: at("09:00:05"), content: { type: "tool_result", toolCallId: "k1", toolName: "read", result: "## 0.72.0" } }),
      message(4, { role: "assistant", source: "self", wakeId: "w_child", createdAt: at("09:00:06"), content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "k2", toolName: "read", args: { path: "/repo/.notes/release-0.72.md" } }] } })
    );
  }
  if (stage === "done") {
    messages.push(
      message(5, { role: "tool", source: "self", wakeId: "w_child", createdAt: at("09:00:09"), content: { type: "tool_result", toolCallId: "k2", toolName: "read", result: "Highlights" } }),
      message(6, { role: "assistant", source: "self", wakeId: "w_child", createdAt: at("09:00:10"), content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "k3", toolName: "bash", args: { command: "git log --oneline v0.71.0..HEAD", description: "List the commits since 0.71" } }] } }),
      message(7, { role: "tool", source: "self", wakeId: "w_child", createdAt: at("09:04:12"), content: { type: "tool_result", toolCallId: "k3", toolName: "bash", result: "stdout:\nab12cd3 Retry a failed wake once\nexitCode: 0" } }),
      message(8, { role: "assistant", source: "self", wakeId: "w_child", createdAt: at("09:04:13"), content: { type: "assistant", text: "0.72 changes the retry policy and drops the legacy cache flag." } })
    );
  }
  return {
    thread: { id: threadId },
    messages,
    hasMore: false,
    contextUsage: null,
    activeWake: stage === "on" ? { wakeId: "w_child", startedAt: at("09:00:01") } : null,
    readAt: null
  };
}

/** A task's detail as GET agentTask answers it: its brief, its reply (none
 *  while it runs), and how many calls it made. */
export function taskDetail(task: BackgroundTaskDto, { brief = "Summarise what changed in 0.72 from the material below.", reply = null, stepCount = 0 }: { brief?: string; reply?: string | null; stepCount?: number } = {}) {
  return { task, brief, reply, stepCount };
}
