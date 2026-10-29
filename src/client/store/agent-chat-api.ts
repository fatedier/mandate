import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type { Mention } from "@shared/mentions";
import type {
  AgentActiveWakeDto,
  AgentContextUsageDto,
  AgentMonitorsRevision,
  AgentPendingMonitorDto,
  AgentCancelWakeResponse,
  AgentCommandDto,
  AgentCommandsResponse,
  AgentDeleteQueuedMessageResponse,
  AgentMessageDto,
  AgentPostMessageRequest,
  AgentPostMessageResponse,
  AgentRetryWakeResponse,
  AgentRunCommandRequest,
  AgentRunCommandResponse,
  AgentThreadResponse
} from "@shared/api-contracts";
import { API_PATHS } from "@shared/api-contracts";
import { apiPath } from "@/lib/api-base";
import { readJson } from "@/lib/api-json";
import { api } from "@/lib/api-paths";
import type { AgentChatScope, ChatThreadScope } from "./agent-chat-types";
import { compareTimelineMessages } from "./agent-chat-utils";
import { beginWakeModelRead, noteActiveWakeModel, type WakeModelReadMark } from "./wake-models";

/** A read's running wake, its model noted for the composer as it is read
 *  (`since`: the stream's count as the read began). */
function withActiveWakeModel(activeWake: AgentActiveWakeDto | null | undefined, at: WakeModelReadMark): AgentActiveWakeDto | null {
  noteActiveWakeModel(activeWake, at);
  return activeWake ?? null;
}

const PAGE_SIZE = 50;
/** A subagent's conversation takes nothing from the page, no message and no
 *  command: its agent answers the agent that started it. */
export const SUBAGENT_READ_ONLY = "A subagent's conversation is read only.";

type WorkerScope = Extract<AgentChatScope, { type: "worker" }>;

/** A worker's conversation routes. A manager thread is addressed by its id. */
function endpointBase(scope: WorkerScope): string {
  return apiPath(API_PATHS.agentWorker(scope.featureId));
}

export async function fetchThreadPage(scope: WorkerScope, beforeSeq?: number): Promise<{
  thread: { id: string } | null;
  messages: AgentMessageDto[];
  hasMore: boolean;
  contextUsage: AgentContextUsageDto | null;
  activeWake: AgentActiveWakeDto | null;
  monitors: AgentPendingMonitorDto[] | null;
  monitorsRevision: AgentMonitorsRevision | null;
  /** A compaction started by hand is in flight; absent when the server did not say. */
  compacting?: boolean;
  readAt: string | null;
}> {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (beforeSeq !== undefined) params.set("before", String(beforeSeq));
  const toldBefore = beginWakeModelRead();
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
    contextUsage: body.contextUsage ?? null,
    activeWake: withActiveWakeModel(body.activeWake, toldBefore),
    monitors: body.monitors ?? null,
    monitorsRevision: body.monitorsRevision ?? null,
    compacting: body.compacting,
    readAt: body.readAt ?? null
  };
}

export async function postMessage(
  scope: WorkerScope,
  content: string,
  attachments: AgentMessageAttachment[],
  clientRequestId: string
): Promise<Exclude<AgentPostMessageResponse, { error: string }>> {
  const body: AgentPostMessageRequest = {
    content,
    clientRequestId,
    ...(attachments.length > 0 ? { attachments } : {})
  };
  const response = await fetch(`${endpointBase(scope)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJson<Exclude<AgentPostMessageResponse, { error: string }>>(response);
}

export async function deleteQueuedMessage(
  scope: WorkerScope,
  clientRequestId: string
): Promise<Exclude<AgentDeleteQueuedMessageResponse, { error: string }>> {
  const response = await fetch(
    `${endpointBase(scope)}/queued-messages/${encodeURIComponent(clientRequestId)}`,
    { method: "DELETE" }
  );
  return readJson<Exclude<AgentDeleteQueuedMessageResponse, { error: string }>>(response);
}

export async function retryWake(wakeId: string): Promise<void> {
  const response = await fetch(api.agentWakeRetry(wakeId), { method: "POST" });
  await readJson<Exclude<AgentRetryWakeResponse, { error: string }>>(response);
}

export async function cancelWake(wakeId: string): Promise<Exclude<AgentCancelWakeResponse, { error: string }>> {
  const response = await fetch(api.agentWakeCancel(wakeId), { method: "POST" });
  return readJson<Exclude<AgentCancelWakeResponse, { error: string }>>(response);
}

export async function fetchThreadById(threadId: string, beforeSeq?: number, sinceSeq?: number) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (beforeSeq !== undefined) params.set("before", String(beforeSeq));
  if (sinceSeq !== undefined) params.set("since", String(sinceSeq));
  const toldBefore = beginWakeModelRead();
  const response = await fetch(`${apiPath(API_PATHS.agentThread(threadId))}?${params}`);
  const body = await readJson<Exclude<AgentThreadResponse, { error: string }>>(response);
  body.messages.sort(compareTimelineMessages);
  return {
    thread: body.thread,
    messages: body.messages,
    hasMore: body.hasMore ?? false,
    contextUsage: body.contextUsage ?? null,
    activeWake: withActiveWakeModel(body.activeWake, toldBefore),
    monitors: body.monitors ?? null,
    monitorsRevision: body.monitorsRevision ?? null,
    compacting: body.compacting,
    readAt: body.readAt ?? null
  };
}

/** What a message of the user's says of itself, beyond its words: the
 *  questions a pick answers, or the control that sent it (Continue), which
 *  answers none. A manager thread's or the agent's: a worker's chat has no
 *  questions of this kind. */
export interface MessageMark { answers?: string[]; control?: "continue" }

export async function postThreadMessage(
  threadId: string,
  content: string,
  attachments: AgentMessageAttachment[],
  clientRequestId: string,
  mark?: MessageMark,
  mentions?: Mention[]
) {
  const body: AgentPostMessageRequest = {
    content,
    clientRequestId,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(mark?.answers && mark.answers.length > 0 ? { answers: mark.answers } : {}),
    ...(mark?.control ? { control: mark.control } : {}),
    ...(mentions && mentions.length > 0 ? { mentions } : {})
  };
  const response = await fetch(apiPath(API_PATHS.agentThreadMessages(threadId)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJson<Exclude<AgentPostMessageResponse, { error: string }>>(response);
}

/** Skips an open question of a manager thread or of the global agent. */
export async function skipThreadQuestion(threadId: string, questionId: string): Promise<void> {
  const response = await fetch(apiPath(API_PATHS.agentThreadQuestionSkip(threadId, questionId)), { method: "POST" });
  await readJson(response);
}

export async function deleteThreadQueuedMessage(threadId: string, clientRequestId: string): Promise<void> {
  const response = await fetch(apiPath(API_PATHS.agentThreadQueuedMessage(threadId, clientRequestId)), {
    method: "DELETE"
  });
  if (response.status !== 204) await readJson(response);
}

// ---------------------------------------------------------------------------
// One conversation, whichever endpoint family serves it: a worker's by its
// feature, a manager thread or the global agent's by its id. The store calls only these, so it
// never has to know which kind it is holding.

export async function fetchScopePage(scope: ChatThreadScope, beforeSeq?: number) {
  if (scope.type === "worker") return fetchThreadPage(scope, beforeSeq);
  const page = await fetchThreadById(scope.threadId, beforeSeq);
  // Same guard as the worker path: a page asked for "before N" never repeats N.
  return beforeSeq === undefined
    ? page
    : { ...page, messages: page.messages.filter((message) => message.seq < beforeSeq) };
}

/** Messages after `since`, or null when the server answered with an error. */
export async function fetchScopeSince(scope: ChatThreadScope, since: number): Promise<{
  thread: { id: string } | null;
  messages: AgentMessageDto[];
  contextUsage: AgentContextUsageDto | null;
  activeWake: AgentActiveWakeDto | null;
  monitors: AgentPendingMonitorDto[] | null;
  monitorsRevision: AgentMonitorsRevision | null;
  /** A compaction started by hand is in flight; absent when the server did not say. */
  compacting?: boolean;
  readAt: string | null;
} | null> {
  if (scope.type !== "worker") return fetchThreadById(scope.threadId, undefined, since).catch(() => null);
  const toldBefore = beginWakeModelRead();
  const response = await fetch(`${endpointBase(scope)}/thread?since=${since}`);
  if (!response.ok) return null;
  const body = await response.json() as AgentThreadResponse;
  if ("error" in body) return null;
  return { thread: body.thread, messages: body.messages, contextUsage: body.contextUsage ?? null, activeWake: withActiveWakeModel(body.activeWake, toldBefore), monitors: body.monitors ?? null, monitorsRevision: body.monitorsRevision ?? null, compacting: body.compacting, readAt: body.readAt ?? null };
}

export function postScopeMessage(
  scope: ChatThreadScope,
  content: string,
  attachments: AgentMessageAttachment[],
  clientRequestId: string,
  mark?: MessageMark,
  mentions?: Mention[]
) {
  if (scope.type === "subagent") return Promise.reject(new Error(SUBAGENT_READ_ONLY));
  // A worker's chat names no threads: only a thread's or Your agent's route takes mentions.
  return scope.type !== "worker"
    ? postThreadMessage(scope.threadId, content, attachments, clientRequestId, mark, mentions)
    : postMessage(scope, content, attachments, clientRequestId);
}

export async function deleteScopeQueuedMessage(scope: ChatThreadScope, clientRequestId: string): Promise<void> {
  if (scope.type === "subagent") throw new Error(SUBAGENT_READ_ONLY);
  if (scope.type !== "worker") await deleteThreadQueuedMessage(scope.threadId, clientRequestId);
  else await deleteQueuedMessage(scope, clientRequestId);
}

/** A conversation's command routes, beside its message routes. */
function commandsUrl(scope: ChatThreadScope): string {
  if (scope.type === "subagent") throw new Error(SUBAGENT_READ_ONLY);
  return scope.type !== "worker"
    ? apiPath(API_PATHS.agentThreadCommands(scope.threadId))
    : `${endpointBase(scope)}/commands`;
}

export async function fetchScopeCommands(scope: ChatThreadScope): Promise<AgentCommandDto[]> {
  const body = await readJson<Exclude<AgentCommandsResponse, { error: string }>>(await fetch(commandsUrl(scope)));
  return Array.isArray(body.commands) ? body.commands : [];
}

/** Hands the server a draft whose first word is a command. */
export async function runScopeCommand(scope: ChatThreadScope, text: string, attachments: number): Promise<AgentRunCommandResponse> {
  const body: AgentRunCommandRequest = { text, attachments };
  const response = await fetch(commandsUrl(scope), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJson<AgentRunCommandResponse>(response);
}
