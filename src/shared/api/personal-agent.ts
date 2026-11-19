import type { OpenQuestion } from "../questions.js";
import type { HeldBackSignal } from "../thread-dot.js";
import type { ThreadNoticeStop } from "../thread-notice.js";

/** One thing the personal agent sent, or one wait it armed with nothing sent,
 *  and its one notice. */
export type HandoffState = "queued" | "delivered" | "waiting" | "replied" | "failed";

/** What a handoff holds as its reply when its target stopped without writing anything. */
export const NO_TEXT_REPLY = "(no text reply)";

export interface PersonalHandoffDto {
  id: string;
  /** "worker": a message to a worker, or a wait on it. "thread": work sent to a manager thread, or a wait on it. */
  kind: "worker" | "thread";
  state: HandoffState;
  text: string;
  spoken: boolean;
  workerId: string | null;
  workerName: string | null;
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

export interface PersonalAgentDto {
  threadId: string;
  /** "" until the user names it; show displayPersonalAgentName(name). */
  name: string;
  named: boolean;
  /** The conversation has a message the user has not seen. */
  unread: boolean;
  voiceConfigured: boolean;
  lastVisibleSeq: number;
  /** Where the user has read the conversation to: what comes after it is new
   *  to them when they come back. */
  seenSeq: number;
  /** What the agent asked the user and they have not answered, oldest first. */
  questions: OpenQuestion[];
  /** The tool-call review held its calls back again and again: only the
   *  user's word moves them on. */
  heldBack?: HeldBackSignal | null;
}
