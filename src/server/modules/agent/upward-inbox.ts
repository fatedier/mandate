import type { AgentMessageSource } from "../../../shared/agent-message-types.js";
import { SSE_EVENTS } from "../../../shared/api/sse.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { AgentMailboxItem, AgentMessage, AgentStore } from "./agent-store.js";

/**
 * The unified inbox: every message between agent levels —
 * a worker's report, its reply to its manager, a copy of what the user told
 * it, Your agent's thread notices — goes in through `post`, which decides
 * from its kind alone whether it wakes its receiver. Content is the sender's;
 * the inbox only writes and wakes.
 *
 * - request: needs an answer or a decision; wakes.
 * - report: a final answer on something the receiver asked or owns; wakes.
 * - note: information asking nothing; never wakes.
 * - lifecycle: a fact the system saw (failed, archived, stopped silent),
 *   each leaving work with no one pushing it; wakes.
 */
export type UpwardKind = "request" | "report" | "note" | "lifecycle";
export type LifecycleReason = "failed" | "archived" | "stopped_silent";

/** What a message is and the matter it belongs to: `handoff:<id>`,
 *  `feature-message:<mailbox id>`, `feature:<id>` or `thread:<id>`. The key
 *  links and groups; it never suppresses a message. */
export interface UpwardRoute {
  kind: UpwardKind;
  key: string;
  lifecycleReason?: LifecycleReason;
}

export interface UpwardMessage extends UpwardRoute {
  to: string;
  source: AgentMessageSource;
  sourceThreadId: string | null;
  content: { type: "text"; text: string; metadata?: Record<string, unknown> };
}

/** What a post wrote; `wake` runs the receiver's wake, if its kind asks for
 *  one — after the caller's transaction commits. */
export interface UpwardPost {
  mailboxItem: AgentMailboxItem | null;
  message: AgentMessage | null;
  wake: () => void;
}

export interface UpwardInbox {
  post(message: UpwardMessage): UpwardPost;
}

export function wakesReceiver(kind: UpwardKind): boolean {
  return kind !== "note";
}

export function createUpwardInbox(deps: {
  agentStore: Pick<AgentStore, "enqueueMailboxMessage" | "appendMessage">;
  sse: Pick<AgentSseEmitter, "emit">;
  /** A turn runs in the receiver: a note then waits for its next step. */
  busy: (threadId: string) => boolean;
  /** Wakes the receiver for mail from `source` (the runtime names the wake by it). */
  wake: (threadId: string, source: AgentMessageSource) => void;
}): UpwardInbox {
  return {
    post(message) {
      const inbox = { kind: message.kind, key: message.key, ...(message.lifecycleReason ? { lifecycleReason: message.lifecycleReason } : {}) };
      const content = { ...message.content, metadata: { ...message.content.metadata, inbox } };
      const mail = { threadId: message.to, role: "user" as const, source: message.source, sourceThreadId: message.sourceThreadId, content };
      if (wakesReceiver(message.kind)) {
        const mailboxItem = deps.agentStore.enqueueMailboxMessage(mail);
        return { mailboxItem, message: null, wake: () => deps.wake(message.to, message.source) };
      }
      // Asking nothing: resting, it lands now, where the user sees it;
      // mid-turn, at the turn's next step.
      if (deps.busy(message.to)) {
        return { mailboxItem: deps.agentStore.enqueueMailboxMessage({ ...mail, triggerTurn: false }), message: null, wake: () => {} };
      }
      const appended = deps.agentStore.appendMessage(mail);
      deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId: message.to, message: appended });
      return { mailboxItem: null, message: appended, wake: () => {} };
    }
  };
}
