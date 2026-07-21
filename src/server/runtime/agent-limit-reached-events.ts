import type {
  AgentMessage,
  AgentStore
} from "../modules/agent/agent-store.js";
import type { WorkItemStore } from "../modules/agent/work-item-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { AgentWakeMetadata, AgentWakeReason } from "../../shared/api/agents.js";
import type { FeatureEventContent } from "../../shared/agent-message-types.js";
import { buildFeatureEventSourceSnapshot } from "../modules/agent/feature-event-source-snapshot.js";

const LIMIT_REACHED_SUMMARY_MAX_CHARS = 4000;

interface EnqueueLimitReachedDeps {
  agentStore: AgentStore;
  projectsStore?: Pick<ProjectsStore, "getById">;
  featuresStore?: Pick<FeaturesStore, "getById">;
  workStore?: Pick<WorkItemStore, "getByFeature">;
}

export interface EnqueueLimitReachedInput {
  threadId: string;
  wakeId: string;
  stepCount: number;
}

type EnqueueLimitReachedResult =
  | { enqueued: false }
  | { enqueued: true; overviewThreadId: string; featureEvent: FeatureEventContent };

interface WakeLimitReachedDeps {
  wakeScheduler: {
    wake: (
      threadId: string,
      reason: AgentWakeReason,
      triggerMessageId: string | null,
      metadata?: AgentWakeMetadata | null
    ) => string | null;
  };
  markPendingMailboxWake?: (threadId: string) => void;
}

export function enqueueManagerLimitReachedEvent(
  deps: EnqueueLimitReachedDeps,
  input: EnqueueLimitReachedInput
): EnqueueLimitReachedResult {
  const thread = deps.agentStore.getThreadById(input.threadId);
  if (thread?.scope !== "worker") return { enqueued: false };
  if (!thread.scopeId) return { enqueued: false };

  const overviewThread = deps.agentStore.getThreadByScope("manager", null);
  if (!overviewThread) return { enqueued: false };
  if (!deps.agentStore.hasOpenTasksForThread(input.threadId)) return { enqueued: false };
  if (wakeCompletedCallerVisibleTask(deps.agentStore, input.threadId, input.wakeId)) {
    return { enqueued: false };
  }

  const summary = latestAssistantSummaryForWake(deps.agentStore, input.threadId, input.wakeId)
    ?? "Feature agent reached its step budget before completing this wake.";
  const workItem = deps.workStore?.getByFeature(thread.scopeId) ?? null;
  const source = buildFeatureEventSourceSnapshot(deps, thread.scopeId);

  const featureEvent: FeatureEventContent = {
    type: "feature_event",
    kind: "limit_reached",
    featureId: thread.scopeId,
    workItemId: workItem?.id ?? null,
    source,
    label: workItem?.title ?? "Feature wake limit reached",
    summary: limitText(summary, LIMIT_REACHED_SUMMARY_MAX_CHARS),
    stepCount: input.stepCount
  };

  deps.agentStore.enqueueMailboxEvent({
    threadId: overviewThread.id,
    role: "user",
    source: "feature-event",
    sourceThreadId: input.threadId,
    content: featureEvent
  });

  return {
    enqueued: true,
    overviewThreadId: overviewThread.id,
    featureEvent
  };
}

export function wakeManagerForLimitReached(
  deps: WakeLimitReachedDeps,
  input: EnqueueLimitReachedResult
): string | null {
  if (!input.enqueued) return null;
  const wakeId = deps.wakeScheduler.wake(input.overviewThreadId, "feature-event", null, {
    featureEvents: [input.featureEvent]
  });
  if (!wakeId) deps.markPendingMailboxWake?.(input.overviewThreadId);
  return wakeId;
}

function latestAssistantSummaryForWake(
  agentStore: AgentStore,
  threadId: string,
  wakeId: string
): string | null {
  const messages = agentStore.getMessages(threadId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.wakeId !== wakeId || message.role !== "assistant") continue;
    const text = assistantText(message);
    if (text) return text;
  }
  return null;
}

function assistantText(message: AgentMessage): string | null {
  if (message.content.type !== "assistant") return null;
  const text = message.content.text?.trim();
  return text ? text : null;
}

function wakeCompletedCallerVisibleTask(
  agentStore: AgentStore,
  threadId: string,
  wakeId: string
): boolean {
  return agentStore.getMessages(threadId).some((message) => {
    if (message.wakeId !== wakeId || message.content.type !== "tool_result") return false;
    if (message.content.toolName !== "task_complete" || message.content.isError) return false;
    const result = message.content.result;
    return Boolean(
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      (result as { ok?: unknown; notifiedCaller?: unknown }).ok === true &&
      (result as { ok?: unknown; notifiedCaller?: unknown }).notifiedCaller === true
    );
  });
}

function limitText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
