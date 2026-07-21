import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type {
  AgentContextUsageDto,
  AgentCancelWakeResponse,
  AgentDeleteQueuedMessageResponse,
  AgentMessageDto,
  AgentPostMessageRequest,
  AgentPostMessageResponse,
  AgentSideForkResponse,
  AgentSideTransferDto,
  AgentThreadResponse
} from "@shared/api-contracts";
import { API_PATHS, API_ROUTES } from "@shared/api-contracts";
import { apiPath } from "@/lib/api-base";
import { readJson } from "@/lib/api-json";
import { api } from "@/lib/api-paths";
import { getClientId, getCurrentUiLocation } from "@/lib/ui-context";
import type { AgentChatScope } from "./agent-chat";
import { compareTimelineMessages } from "./agent-chat-utils";

const PAGE_SIZE = 50;

export function endpointBase(scope: AgentChatScope): string {
  if (scope.type === "manager") return apiPath(API_ROUTES.agentManager);
  return apiPath(API_PATHS.agentWorker(scope.featureId));
}

export async function fetchThreadPage(scope: AgentChatScope, beforeSeq?: number): Promise<{
  thread: { id: string } | null;
  messages: AgentMessageDto[];
  hasMore: boolean;
  contextUsage: AgentContextUsageDto | null;
}> {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (beforeSeq !== undefined) params.set("before", String(beforeSeq));
  const response = await fetch(`${endpointBase(scope)}/thread?${params.toString()}`);
  const body = await readJson<Exclude<AgentThreadResponse, { error: string }>>(response);
  const filtered = beforeSeq !== undefined
    ? body.messages.filter((message) => message.seq < beforeSeq)
    : body.messages;
  filtered.sort(compareTimelineMessages);
  return {
    thread: body.thread,
    messages: filtered,
    hasMore: body.hasMore ?? (filtered.length >= PAGE_SIZE),
    contextUsage: body.contextUsage ?? null
  };
}

export async function postMessage(
  scope: AgentChatScope,
  content: string,
  attachments: AgentMessageAttachment[],
  clientRequestId: string,
  workItemRef?: { itemId: string; snapshotAt: string }
): Promise<Exclude<AgentPostMessageResponse, { error: string }>> {
  const body: AgentPostMessageRequest = {
    content,
    clientRequestId,
    clientId: getClientId(),
    uiLocation: getCurrentUiLocation(),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(workItemRef ? { workItemRef } : {})
  };
  const response = await fetch(`${endpointBase(scope)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJson<Exclude<AgentPostMessageResponse, { error: string }>>(response);
}

export async function deleteQueuedMessage(
  scope: AgentChatScope,
  clientRequestId: string
): Promise<Exclude<AgentDeleteQueuedMessageResponse, { error: string }>> {
  const response = await fetch(
    `${endpointBase(scope)}/queued-messages/${encodeURIComponent(clientRequestId)}`,
    { method: "DELETE" }
  );
  return readJson<Exclude<AgentDeleteQueuedMessageResponse, { error: string }>>(response);
}

export async function cancelWake(wakeId: string): Promise<Exclude<AgentCancelWakeResponse, { error: string }>> {
  const response = await fetch(api.agentWakeCancel(wakeId), { method: "POST" });
  return readJson<Exclude<AgentCancelWakeResponse, { error: string }>>(response);
}

export async function createSideThread(parentThreadId: string) {
  const response = await fetch(apiPath(API_PATHS.agentThreadForks(parentThreadId)), { method: "POST" });
  return readJson<Exclude<AgentSideForkResponse, { error: string }>>(response);
}

export async function fetchThreadById(threadId: string, beforeSeq?: number, sinceSeq?: number) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (beforeSeq !== undefined) params.set("before", String(beforeSeq));
  if (sinceSeq !== undefined) params.set("since", String(sinceSeq));
  const response = await fetch(`${apiPath(API_PATHS.agentThread(threadId))}?${params}`);
  const body = await readJson<Exclude<AgentThreadResponse, { error: string }>>(response);
  body.messages.sort(compareTimelineMessages);
  return {
    thread: body.thread,
    messages: body.messages,
    hasMore: body.hasMore ?? false,
    contextUsage: body.contextUsage ?? null
  };
}

export async function postThreadMessage(
  threadId: string,
  content: string,
  attachments: AgentMessageAttachment[],
  clientRequestId: string
) {
  const body: AgentPostMessageRequest = {
    content,
    clientRequestId,
    clientId: getClientId(),
    uiLocation: getCurrentUiLocation(),
    ...(attachments.length > 0 ? { attachments } : {})
  };
  const response = await fetch(apiPath(API_PATHS.agentThreadMessages(threadId)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJson<Exclude<AgentPostMessageResponse, { error: string }>>(response);
}

export async function closeSideThread(threadId: string): Promise<void> {
  const response = await fetch(apiPath(API_PATHS.agentThread(threadId)), { method: "DELETE" });
  if (response.status !== 204) await readJson(response);
}

export async function deleteThreadQueuedMessage(threadId: string, clientRequestId: string): Promise<void> {
  const response = await fetch(apiPath(API_PATHS.agentThreadQueuedMessage(threadId, clientRequestId)), {
    method: "DELETE"
  });
  if (response.status !== 204) await readJson(response);
}

export async function fetchSideSummaryDraft(threadId: string): Promise<string> {
  const response = await fetch(apiPath(API_PATHS.agentThreadSummaryDraft(threadId)), { method: "POST" });
  const body = await readJson<{ content?: string }>(response);
  return body.content ?? "";
}

export async function transferSideSummary(
  threadId: string,
  content: string,
  clientRequestId: string
): Promise<{ transfer: AgentSideTransferDto; wakeId?: string | null }> {
  const response = await fetch(apiPath(API_PATHS.agentThreadTransfers(threadId)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, clientRequestId })
  });
  const body = await readJson<{
    transfer?: AgentSideTransferDto;
    wakeId?: string | null;
  }>(response);
  if (!body.transfer) throw new Error("Invalid API response: missing transfer");
  return { transfer: body.transfer, wakeId: body.wakeId };
}

export async function retargetSideSummary(
  transferId: string,
  targetThreadId: string
): Promise<{ transfer: AgentSideTransferDto; wakeId?: string | null }> {
  const response = await fetch(apiPath(API_PATHS.agentSideTransferRetarget(transferId)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetThreadId })
  });
  const body = await readJson<{
    transfer?: AgentSideTransferDto;
    wakeId?: string | null;
  }>(response);
  if (!body.transfer) throw new Error("Invalid API response: missing transfer");
  return { transfer: body.transfer, wakeId: body.wakeId };
}
