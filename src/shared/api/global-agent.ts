import type { OpenQuestion } from "../questions.js";
import type { ThreadNoticeStop } from "../thread-notice.js";

/** One thing the global agent sent, or one wait it armed with nothing sent,
 *  and its one notice. */
export type HandoffState = "queued" | "delivered" | "waiting" | "replied" | "failed";

/** What a handoff holds as its reply when its target stopped without writing anything. */
export const NO_TEXT_REPLY = "(no text reply)";

export interface GlobalHandoffDto {
  id: string;
  /** "feature": a message to a worker, or a wait on it. "thread": work sent to a manager thread, or a wait on it. */
  kind: "feature" | "thread";
  state: HandoffState;
  text: string;
  spoken: boolean;
  featureId: string | null;
  featureName: string | null;
  /** The thread that owns the worker ("Sent to release · in Docs overhaul"). */
  ownerThreadTitle: string | null;
  /** The worker's own chat, or the manager thread it went to. */
  threadId: string | null;
  threadTitle: string | null;
  /** The title of the thread this send opened; null when it went to one that existed. */
  newThreadTitle: string | null;
  reply: string | null;
  reason: string | null;
  /** How the target stopped, once it has. */
  stop: ThreadNoticeStop | null;
  createdAt: string;
  updatedAt: string;
  repliedAt: string | null;
}

export interface GlobalAgentDto {
  threadId: string;
  /** "" until the user names it; show displayGlobalAgentName(name). */
  name: string;
  named: boolean;
  /** The conversation has a message the user has not seen. */
  unread: boolean;
  voiceConfigured: boolean;
  lastVisibleSeq: number;
  /** What the agent asked the user and they have not answered, oldest first. */
  questions: OpenQuestion[];
}
