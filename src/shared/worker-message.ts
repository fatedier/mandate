import type { AgentMessageContent } from "./agent-message-types.js";

const WORKER_MESSAGE_METADATA_KEY = "workerMessage";

/** How a worker's turn ended when it left no words for its manager. */
const REPLY_OUTCOMES = ["error", "canceled", "stuck", "no_reply"] as const;
export type WorkerReplyOutcome = (typeof REPLY_OUTCOMES)[number];

interface WorkerMessageMetadata {
  /** A manager's request, a worker's reply, or a note to the manager of
   *  what the user told its worker directly. */
  direction: "request" | "reply" | "note";
  workerId?: string;
  workerName?: string;
  /** A note's: who wrote (the user, or the user through their agent), what,
   *  and how many attachments stayed with the worker. */
  by?: "user" | "agent";
  text?: string;
  attachments?: number;
  /** A reply's, when the turn ended with no text: what happened, and the
   *  reason a failure or a repeated failing call gave. A reply with words
   *  has neither, as has every reply stored before the fields existed. */
  outcome?: WorkerReplyOutcome;
  detail?: string;
}

export function workerMessageRequestMetadata(): Record<string, unknown> {
  return {
    [WORKER_MESSAGE_METADATA_KEY]: { direction: "request" }
  };
}

export function workerMessageReplyMetadata(input: {
  workerId: string;
  workerName?: string | null;
  outcome?: WorkerReplyOutcome;
  detail?: string;
}): Record<string, unknown> {
  return {
    [WORKER_MESSAGE_METADATA_KEY]: {
      direction: "reply",
      workerId: input.workerId,
      ...(input.workerName?.trim() ? { workerName: input.workerName.trim() } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.outcome && input.detail ? { detail: input.detail } : {})
    }
  };
}

export function workerMessageNoteMetadata(input: {
  workerId: string;
  workerName: string;
  by: "user" | "agent";
  text: string;
  attachments: number;
}): Record<string, unknown> {
  return { [WORKER_MESSAGE_METADATA_KEY]: { direction: "note", ...input } };
}

export function workerMessageMetadata(
  content: AgentMessageContent
): WorkerMessageMetadata | null {
  if (content.type !== "text") return null;
  const value = content.metadata?.[WORKER_MESSAGE_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (metadata.direction !== "request" && metadata.direction !== "reply" && metadata.direction !== "note") return null;
  const outcome = REPLY_OUTCOMES.find((known) => known === metadata.outcome);
  return {
    direction: metadata.direction,
    ...(typeof metadata.workerId === "string" ? { workerId: metadata.workerId } : {}),
    ...(typeof metadata.workerName === "string" ? { workerName: metadata.workerName } : {}),
    ...(metadata.by === "user" || metadata.by === "agent" ? { by: metadata.by } : {}),
    ...(typeof metadata.text === "string" ? { text: metadata.text } : {}),
    ...(typeof metadata.attachments === "number" ? { attachments: metadata.attachments } : {}),
    ...(outcome ? { outcome } : {}),
    ...(outcome && typeof metadata.detail === "string" ? { detail: metadata.detail } : {})
  };
}

export function isWorkerMessageRequest(content: AgentMessageContent): boolean {
  return workerMessageMetadata(content)?.direction === "request";
}
