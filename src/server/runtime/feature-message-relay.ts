import type {
  AgentMailboxItem,
  AgentMessage,
  AgentStore,
  AgentWakeStatus
} from "../modules/agent/agent-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { AgentWakeReason } from "../../shared/api/agents.js";
import {
  featureMessageReplyMetadata,
  isFeatureMessageRequest
} from "../../shared/feature-message.js";

const REPLY_MAX_CHARS = 20_000;

interface RelayFeatureMessageDeps {
  agentStore: AgentStore;
  featuresStore: Pick<FeaturesStore, "getById">;
  wakeScheduler: {
    wake: (
      threadId: string,
      reason: AgentWakeReason,
      triggerMessageId: string | null
    ) => string | null;
  };
  markPendingMailboxWake?: (threadId: string) => void;
}

interface RelayFeatureMessageInput {
  threadId: string;
  wakeId: string;
  status: AgentWakeStatus;
}

export function relayFeatureMessageReply(
  deps: RelayFeatureMessageDeps,
  input: RelayFeatureMessageInput
): AgentMailboxItem[] {
  const featureThread = deps.agentStore.getThreadById(input.threadId);
  if (featureThread?.scope !== "worker" || !featureThread.scopeId) return [];

  const callerThreadIds = new Set<string>();
  const wake = deps.agentStore.getWakeById(input.wakeId);
  const wakeIds = [input.wakeId, ...(wake?.metadata?.recovery?.wakeIds ?? [])];
  for (const mailboxMessage of wakeIds.flatMap((id) => deps.agentStore.listMailboxMessagesDeliveredToWake(id))) {
    if (!mailboxMessage.sourceThreadId || !isFeatureMessageRequest(mailboxMessage.content))
      continue;
    callerThreadIds.add(mailboxMessage.sourceThreadId);
  }
  if (callerThreadIds.size === 0) return [];

  const feature = deps.featuresStore.getById(featureThread.scopeId);
  const summary = replyText(deps.agentStore, input);
  const replies: AgentMailboxItem[] = [];

  for (const callerThreadId of callerThreadIds) {
    const targetThreadId = resolveReplyTarget(deps.agentStore, callerThreadId);
    if (!targetThreadId) continue;
    const reply = deps.agentStore.enqueueMailboxMessage({
      threadId: targetThreadId,
      role: "user",
      source: "feature-message",
      sourceThreadId: featureThread.id,
      content: {
        type: "text",
        text: summary,
        metadata: featureMessageReplyMetadata({
          featureId: featureThread.scopeId,
          featureName: feature?.name
        })
      }
    });
    const wakeId = deps.wakeScheduler.wake(targetThreadId, "user", null);
    if (!wakeId) deps.markPendingMailboxWake?.(targetThreadId);
    replies.push(reply);
  }
  return replies;
}

function resolveReplyTarget(agentStore: AgentStore, callerThreadId: string): string | null {
  const caller = agentStore.getThreadById(callerThreadId);
  if (!caller) return null;
  if (!caller.archivedAt && !caller.closedAt) return caller.id;
  if (caller.kind === "side" && caller.parentThreadId) {
    const parent = agentStore.getThreadById(caller.parentThreadId);
    if (parent && !parent.archivedAt && !parent.closedAt) return parent.id;
  }
  const current = agentStore.getThreadByScope(caller.scope, caller.scopeId);
  return current && !current.closedAt ? current.id : null;
}

function replyText(agentStore: AgentStore, input: RelayFeatureMessageInput): string {
  const assistantText = latestAssistantTextForWake(agentStore, input.threadId, input.wakeId);
  if (assistantText) return limitText(assistantText, REPLY_MAX_CHARS);
  const wake = agentStore.getWakeById(input.wakeId);
  if (input.status === "error") {
    return `Feature conversation failed: ${wake?.errorMessage ?? "unknown error"}`;
  }
  if (input.status === "canceled")
    return "Feature conversation was canceled before a reply was produced.";
  if (input.status === "limit_reached") {
    return "Feature agent reached its step budget before producing a text reply.";
  }
  return "Feature agent completed the conversation without a text reply.";
}

function latestAssistantTextForWake(
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
  return text || null;
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
