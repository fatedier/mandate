import type { AgentScope, AgentStore } from "./agent-store.js";
import { buildWorkerMessageSendTool } from "./tools/worker-message-tools.js";
import { createBashTool } from "./tools/bash.js";
import { editFileTool } from "./tools/edit-file.js";
import { readFileTool } from "./tools/read-file.js";
import { buildViewImageTool } from "./tools/view-image.js";
import { writeFileTool } from "./tools/write-file.js";
import { buildMonitorTools } from "./tools/monitor.js";
import { buildAlarmTools } from "./tools/alarm-tools.js";
import { buildSweepTools, type SweepController } from "./tools/sweep-tools.js";
import type { WakeScheduler } from "./wake-loop.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { PaneMonitorManager } from "./pane-monitor-manager.js";
import type { CommandMonitorManager } from "./command-monitor-manager.js";
import type { AgentAlarmManager } from "./agent-alarm-manager.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { ModelInputType } from "../../../shared/agent-message-types.js";
import type { ToolDefinition } from "./tool-registry.js";
import { buildSubagentTools } from "./tools/subagent-tools.js";
import type { SubagentService } from "../../runtime/subagents.js";
import type { BackgroundCommandService } from "../../runtime/background-commands.js";
import type { TaskList } from "../../runtime/task-list.js";
import type { ShellCommandRunner } from "../../platform/process/shell-command-runner.js";
import type { ConversationScope } from "../../../shared/api/agents.js";

export function buildFileToolPacks(
  scope: AgentScope,
  input: {
    supportsInputForScope?: (scope: ConversationScope, input: ModelInputType) => boolean;
    supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
    supportsToolResultImagesForThread?: (threadId: string) => boolean;
    /** What runs bash's commands; the login-shell runner unless a test's. */
    shellRunner?: ShellCommandRunner;
    /** Background commands: bash's run_in_background and its move at a timeout. */
    commands?: Pick<BackgroundCommandService, "start" | "adopt" | "stop">;
  } = {}
): ToolPack[] {
  const bash = createBashTool({ ...(input.shellRunner ? { runner: input.shellRunner } : {}), commands: input.commands ?? null });
  const tools: ToolDefinition[] = [bash as ToolDefinition, readFileTool, writeFileTool, editFileTool];
  tools.push(buildViewImageTool({
    supportsImages: ({ threadId }) => input.supportsInputForThread?.(threadId, "image") ?? true,
    supportsToolResultImages: ({ threadId }) => input.supportsToolResultImagesForThread?.(threadId) ?? true
  }));
  return [
    toolPack("agent.files", [scope], tools)
  ];
}

export function buildMonitorToolPacks(input: {
  scope: AgentScope;
  paneMonitorManager: PaneMonitorManager;
  commandMonitorManager?: CommandMonitorManager;
  projectsStore?: ProjectsStore;
  workersStore?: WorkersStore;
}): ToolPack[] {
  return [toolPack("agent.monitor", [input.scope], buildMonitorTools(input))];
}

export function buildAlarmToolPacks(input: {
  scope: AgentScope;
  alarmManager: AgentAlarmManager;
}): ToolPack[] {
  return [
    toolPack("agent.alarms", [input.scope], buildAlarmTools(input.alarmManager))
  ];
}

/** The manager's one way to give a worker work: a message. Workers get no
 *  dispatch pack — the task queue is gone. */
export function buildWorkerDispatchToolPacks(input: {
  scope: AgentScope;
  agentStore: AgentStore;
  workersStore: WorkersStore;
  getWakeScheduler: () => WakeScheduler;
}): ToolPack[] {
  if (input.scope !== "manager") return [];
  return [toolPack("agent.worker-dispatch", ["manager"], [
    buildWorkerMessageSendTool({
      agentStore: input.agentStore,
      workersStore: input.workersStore,
      // Its message is mail: a refused wake for it is tried again, and the
      // send reads as queued.
      wakeScheduler: {
        wake: (threadId, reason) => input.getWakeScheduler().wakeForMail(threadId, reason)
      }
    })
  ])];
}

/** `subagent`, `stop_task` and `list_tasks`: a worker's and a manager's, and
 *  the personal agent's by name (PERSONAL_REUSED_TOOLS). A subagent's own scope never
 *  gets them. */
export function buildSubagentToolPacks(input: {
  scope: AgentScope;
  agentStore: AgentStore;
  subagents: Pick<SubagentService, "start" | "stop">;
  commands?: Pick<BackgroundCommandService, "stop">;
  taskList?: TaskList;
}): ToolPack[] {
  if (input.scope !== "worker" && input.scope !== "manager") return [];
  return [toolPack("agent.subagents", [input.scope], buildSubagentTools({
    service: input.subagents,
    isSubagentThread: (threadId) => input.agentStore.getThreadById(threadId)?.scope === "subagent",
    ...(input.commands ? { commands: input.commands } : {}),
    ...(input.taskList ? { kindOf: (taskId: string) => input.taskList!.kindOf(taskId), listTasks: (threadId: string) => input.taskList!.list(threadId) } : {})
  }))];
}

export function buildSweepToolPacks(input: {
  scope: AgentScope;
  sweepController?: SweepController;
}): ToolPack[] {
  // Managers only: theirs is the thread the sweep wakes, and the only one holding
  // the cross-worker view the decision needs.
  if (input.scope !== "manager" || !input.sweepController) return [];
  return [
    toolPack("agent.sweep", ["manager"], buildSweepTools(input.sweepController))
  ];
}
