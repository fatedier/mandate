import type {
  AgentMailboxItem,
  AgentStore,
  AgentWakeStatus
} from "../modules/agent/agent-store.js";
import type { WorkersStore } from "../modules/workers/workers-store.js";
import type { UpwardInbox, UpwardPost } from "../modules/agent/upward-inbox.js";
import { cutKeepingWhole } from "../modules/agent/tool-output-spool.js";
import {
  workerMessageReplyMetadata,
  isWorkerMessageRequest,
  type WorkerReplyOutcome
} from "../../shared/worker-message.js";

const REPLY_MAX_CHARS = 20_000;

interface RelayWorkerMessageDeps {
  agentStore: AgentStore;
  workersStore: Pick<WorkersStore, "getById">;
  /** Where each reply goes in, and whose wake it asks for. */
  inbox: Pick<UpwardInbox, "post">;
}

interface RelayWorkerMessageInput {
  threadId: string;
  wakeId: string;
  status: AgentWakeStatus;
}

export function relayWorkerMessageReply(
  deps: RelayWorkerMessageDeps,
  input: RelayWorkerMessageInput
): AgentMailboxItem[] {
  const workerThread = deps.agentStore.getThreadById(input.threadId);
  if (workerThread?.scope !== "worker" || !workerThread.scopeId) return [];

  // Each caller's latest message to the turn: the one its reply is a report
  // on (a caller who wrote twice gets one reply).
  const requestOf = new Map<string, AgentMailboxItem>();
  const wake = deps.agentStore.getWakeById(input.wakeId);
  const wakeIds = [input.wakeId, ...(wake?.metadata?.recovery?.wakeIds ?? [])];
  for (const mailboxMessage of wakeIds.flatMap((id) => deps.agentStore.listMailboxMessagesDeliveredToWake(id))) {
    if (!mailboxMessage.sourceThreadId || !isWorkerMessageRequest(mailboxMessage.content))
      continue;
    const seen = requestOf.get(mailboxMessage.sourceThreadId);
    if (!seen || mailboxMessage.createdAt >= seen.createdAt) requestOf.set(mailboxMessage.sourceThreadId, mailboxMessage);
  }
  if (requestOf.size === 0) return [];

  const worker = deps.workersStore.getById(workerThread.scopeId);
  const summary = replyFor(deps.agentStore, input);
  const workerId = workerThread.scopeId;
  // Every caller's reply in one write: tried again after a refusal, none is
  // sent twice. The wakes follow it.
  const posts = deps.agentStore.transaction(() => {
    const written: UpwardPost[] = [];
    for (const [callerThreadId, request] of requestOf) {
      const targetThreadId = resolveReplyTarget(deps.agentStore, callerThreadId);
      if (!targetThreadId) continue;
      written.push(deps.inbox.post({
        to: targetThreadId,
        kind: "report",
        key: `worker-message:${request.id}`,
        source: "worker-message",
        sourceThreadId: workerThread.id,
        content: {
          type: "text",
          // Cut for its receiver, the whole saved where it can read it.
          text: cutKeepingWhole(summary.text, REPLY_MAX_CHARS, { threadId: targetThreadId }),
          metadata: workerMessageReplyMetadata({
            workerId: workerId,
            workerName: worker?.name,
            outcome: summary.outcome,
            detail: summary.detail
          })
        }
      }));
    }
    return written;
  });
  for (const post of posts) post.wake();
  return posts.flatMap((post) => (post.mailboxItem ? [post.mailboxItem] : []));
}

function resolveReplyTarget(agentStore: AgentStore, callerThreadId: string): string | null {
  const caller = agentStore.getThreadById(callerThreadId);
  if (!caller) return null;
  if (!caller.archivedAt) return caller.id;
  const current = caller.scope === "manager"
    ? agentStore.latestOpenManagerThread()
    : agentStore.getThreadByScope(caller.scope, caller.scopeId);
  return current?.id ?? null;
}

/** What the caller is told: the worker's closing words, or, when its turn
 *  left none, a sentence for the manager's model with what happened stored
 *  beside it (the thread draws that, not the sentence). */
function replyFor(
  agentStore: AgentStore,
  input: RelayWorkerMessageInput
): { text: string; outcome?: WorkerReplyOutcome; detail?: string } {
  const assistantText = latestAssistantTextForWake(agentStore, input.threadId, input.wakeId);
  if (assistantText) return { text: assistantText };
  const reason = agentStore.getWakeById(input.wakeId)?.errorMessage?.trim() || undefined;
  if (input.status === "error") {
    return { text: `The worker's turn failed: ${reason ?? "unknown error"}`, outcome: "error", detail: reason };
  }
  if (input.status === "canceled") {
    return { text: "The worker's turn was stopped before it replied.", outcome: "canceled" };
  }
  if (input.status === "stuck") {
    return { text: `The worker stopped: ${reason ?? "the same call kept failing"}`, outcome: "stuck", detail: reason };
  }
  return { text: "The worker finished its turn without a text reply.", outcome: "no_reply" };
}

export function latestAssistantTextForWake(
  agentStore: Pick<AgentStore, "latestAssistantTextOfWake">,
  threadId: string,
  wakeId: string
): string | null {
  return agentStore.latestAssistantTextOfWake(threadId, wakeId);
}

export function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
