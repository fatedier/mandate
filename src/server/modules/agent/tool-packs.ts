import type { AgentScope, AgentStore } from "./agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import {
  buildFeatureTaskSendTool,
  buildFeatureTaskTools
} from "./tools/feature-task-tools.js";
import { buildFeatureMessageSendTool } from "./tools/feature-message-tools.js";
import { buildUpdateFeatureDigestTool } from "./tools/feature-digest.js";
import { buildFeatureWorkItemTool } from "./tools/feature-work-item-tools.js";
import { bashTool } from "./tools/bash.js";
import { editFileTool } from "./tools/edit-file.js";
import { readFileTool } from "./tools/read-file.js";
import { buildViewImageTool } from "./tools/view-image.js";
import { writeFileTool } from "./tools/write-file.js";
import { buildWatchWindowTool } from "./tools/watch-window.js";
import { buildCancelWatchTool, buildListMyWatchesTool } from "./tools/watch-tools.js";
import { buildAlarmTools } from "./tools/alarm-tools.js";
import { buildSweepTools, type SweepController } from "./tools/sweep-tools.js";
import type { WakeScheduler } from "./wake-loop.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { WorkItemStore } from "./work-item-store.js";
import type { WindowWatchManager } from "./window-watch-manager.js";
import type { AgentAlarmManager } from "./agent-alarm-manager.js";
import type { AgentUserMessageQueue } from "./user-message-queue.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { ModelInputType } from "../../../shared/agent-message-types.js";
import type { ToolDefinition } from "./tool-registry.js";

export function buildFileToolPacks(
  scope: AgentScope,
  input: {
    supportsInputForScope?: (scope: AgentScope, input: ModelInputType) => boolean;
    supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
    supportsToolResultImagesForThread?: (threadId: string) => boolean;
  } = {}
): ToolPack[] {
  const tools: ToolDefinition[] = [bashTool, readFileTool, writeFileTool, editFileTool];
  tools.push(buildViewImageTool({
    supportsImages: ({ threadId }) => input.supportsInputForThread?.(threadId, "image") ?? true,
    supportsToolResultImages: ({ threadId }) => input.supportsToolResultImagesForThread?.(threadId) ?? true
  }));
  return [
    toolPack("agent.files", [scope], tools)
  ];
}

export function buildWatchToolPacks(input: {
  scope: AgentScope;
  watchManager: WindowWatchManager;
  projectsStore?: ProjectsStore;
  featuresStore?: FeaturesStore;
}): ToolPack[] {
  return [
    toolPack("agent.watch", [input.scope], [
      buildWatchWindowTool({
        watchManager: input.watchManager,
        scope: input.scope,
        projectsStore: input.projectsStore,
        featuresStore: input.featuresStore
      }),
      buildListMyWatchesTool(input.watchManager),
      buildCancelWatchTool(input.watchManager)
    ])
  ];
}

export function buildAlarmToolPacks(input: {
  scope: AgentScope;
  alarmManager: AgentAlarmManager;
}): ToolPack[] {
  return [
    toolPack("agent.alarms", [input.scope], buildAlarmTools(input.alarmManager))
  ];
}

export function buildFeatureTaskToolPacks(input: {
  scope: AgentScope;
  agentStore: AgentStore;
  projectsStore?: ProjectsStore;
  featuresStore: FeaturesStore;
  workStore?: WorkItemStore;
  sse: AgentSseEmitter;
  getWakeScheduler: () => WakeScheduler;
  userMessageQueue?: Pick<AgentUserMessageQueue, "submitThreadUserMessage">;
  markPendingTaskWake?: (threadId: string) => void;
  markPendingMailboxWake?: (threadId: string) => void;
}): ToolPack[] {
  const deps = {
    projectsStore: input.projectsStore,
    agentStore: input.agentStore,
    featuresStore: input.featuresStore,
    workStore: input.workStore,
    sse: input.sse,
    wakeScheduler: {
      wake: (
        threadId: string,
        reason: Parameters<WakeScheduler["wake"]>[1],
        triggerMessageId: string | null,
        metadata?: Parameters<WakeScheduler["wake"]>[3]
      ) => input.getWakeScheduler().wake(threadId, reason, triggerMessageId, metadata),
      getRunningWakeForThread: (threadId: string) =>
        input.getWakeScheduler().getRunningWakeForThread(threadId)
    },
    userMessageQueue: input.userMessageQueue,
    markPendingTaskWake: input.markPendingTaskWake,
    markPendingMailboxWake: input.markPendingMailboxWake
  };
  return input.scope === "manager"
    ? [toolPack("agent.feature-dispatch", ["manager"], [
        buildFeatureTaskSendTool(deps),
        buildFeatureMessageSendTool(deps)
      ])]
    : [toolPack("agent.feature-tasks", ["worker"], buildFeatureTaskTools(deps))];
}

export function buildSweepToolPacks(input: {
  scope: AgentScope;
  sweepController?: SweepController;
}): ToolPack[] {
  // Overview only: it is the thread the sweep wakes, and the only one holding
  // the cross-feature view the decision needs.
  if (input.scope !== "manager" || !input.sweepController) return [];
  return [
    toolPack("agent.sweep", ["manager"], buildSweepTools(input.sweepController))
  ];
}

export function buildFeatureDigestToolPacks(input: {
  scope: AgentScope;
  agentStore: AgentStore;
}): ToolPack[] {
  if (input.scope !== "worker") return [];
  return [
    toolPack("agent.feature-digest", ["worker"], [
      buildUpdateFeatureDigestTool({ agentStore: input.agentStore })
    ])
  ];
}

export function buildFeatureWorkItemToolPacks(input: {
  scope: AgentScope;
  agentStore: AgentStore;
  workStore: WorkItemStore;
  sse: AgentSseEmitter;
}): ToolPack[] {
  if (input.scope !== "worker") return [];
  return [
    toolPack("agent.feature-work-item", ["worker"], [
      buildFeatureWorkItemTool({
        workStore: input.workStore,
        sse: input.sse,
        resolveFeatureId: (ctx) => {
          const t = input.agentStore.getThreadById(ctx.threadId);
          return t && t.scope === "worker" ? t.scopeId : null;
        }
      })
    ])
  ];
}
