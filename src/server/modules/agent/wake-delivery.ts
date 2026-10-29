import type { AgentStore, AgentWakeReason } from "./agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { AgentMessageSource } from "../../../shared/agent-message-types.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";

export interface WakeDeliveryDeps {
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  onWake: (threadId: string, reason: AgentWakeReason, triggerMessageId: string | null) => string | null | void;
  isThreadBusy: (threadId: string) => boolean;
  /** A thread whose feature is archived: reported, so the caller can clear
   *  what it holds there. */
  isThreadRetired?: (threadId: string) => boolean;
}

interface WakeDeliveryRequest {
  threadId: string;
  reason: AgentWakeReason;
  source: AgentMessageSource;
  /** A message appended by an earlier attempt whose wake was refused. */
  messageId: string | null;
  render: () => Promise<string> | string;
  /** Checked before and after render; false abandons quietly. */
  stillWanted?: () => boolean;
  /** Called with the result the moment it is decided, before this returns:
   *  the caller acts inside that same tick. A busy thread's trigger is queued
   *  before a wake ending in between could flush an empty queue and strand
   *  it, and cleanup runs before a dispose in between could close what it
   *  writes to. */
  settle?: (result: WakeDeliveryResult) => void;
}

export type WakeDeliveryResult =
  | { status: "woken"; wakeId: string; messageId: string }
  | { status: "busy"; messageId: string | null }
  | { status: "gone" }
  | { status: "retired" }
  | { status: "abandoned" };

/** One wake for a thread, the way window watches always delivered theirs:
 *  nothing into a gone or archived thread; a retired thread is reported so the
 *  caller can clear what it holds; a busy thread waits (the caller queues and
 *  retries after the running wake ends); otherwise the message is appended and
 *  the wake requested. A refused wake keeps the message id so the retry wakes
 *  on the same message instead of appending a second one: one that throws (a
 *  write the database refused) settles busy with it before the error goes on,
 *  and so does a refused append, with no message.
 *  The caller keeps that id in memory first: a write of it may be refused too.
 *  Rendering may await (a pane capture), so everything is checked again after it. */
export async function deliverWakeMessage(deps: WakeDeliveryDeps, request: WakeDeliveryRequest): Promise<WakeDeliveryResult> {
  const done = (result: WakeDeliveryResult): WakeDeliveryResult => {
    request.settle?.(result);
    return result;
  };
  const check = (): WakeDeliveryResult | null => {
    if (request.stillWanted && !request.stillWanted()) return { status: "abandoned" };
    const thread = deps.agentStore.getThreadById(request.threadId);
    if (!thread || thread.archivedAt) return { status: "gone" };
    if (deps.isThreadRetired?.(thread.id)) return { status: "retired" };
    return null;
  };
  const early = check();
  if (early) return done(early);
  if (deps.isThreadBusy(request.threadId)) return done({ status: "busy", messageId: request.messageId });
  if (request.messageId) {
    let wakeId: string | null;
    try {
      wakeId = requestWake(deps, request.threadId, request.reason, request.messageId);
    } catch (err) {
      // Refused again: the message stays kept for the next try.
      done({ status: "busy", messageId: request.messageId });
      throw err;
    }
    return done(wakeId
      ? { status: "woken", wakeId, messageId: request.messageId }
      : { status: "busy", messageId: request.messageId });
  }

  const text = await request.render();
  const late = check();
  if (late) return done(late);
  if (deps.isThreadBusy(request.threadId)) return done({ status: "busy", messageId: null });

  let message: ReturnType<AgentStore["appendMessage"]>;
  try {
    message = deps.agentStore.appendMessage({
      threadId: request.threadId,
      role: "user",
      source: request.source,
      content: { type: "text", text }
    });
  } catch (err) {
    // Refused (another writer held the database): nothing was written, and
    // the trigger is kept for the next try, which renders it again.
    done({ status: "busy", messageId: null });
    throw err;
  }
  deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId: request.threadId, message });
  let wakeId: string | null;
  try {
    wakeId = requestWake(deps, request.threadId, request.reason, message.id);
  } catch (err) {
    // The wake's row was refused (another writer held the database): its
    // message is kept for the retry, which wakes on it instead of appending
    // a second; the error goes on to whoever retries.
    done({ status: "busy", messageId: message.id });
    throw err;
  }
  return done(wakeId ? { status: "woken", wakeId, messageId: message.id } : { status: "busy", messageId: message.id });
}

function requestWake(deps: WakeDeliveryDeps, threadId: string, reason: AgentWakeReason, messageId: string): string | null {
  const result = deps.onWake(threadId, reason, messageId);
  return typeof result === "string" && result ? result : null;
}

/** A field's value in a monitor event, on one line whatever it holds. Events
 *  are read a line at a time, `key: value` — by the agent and by the chat —
 *  so every line break any reader honours (LF, CR, VT, FF, FS/GS/RS, NEL,
 *  U+2028, U+2029) is written as a visible escape: a value cannot start a
 *  line that reads as a field. */
export function eventField(value: string): string {
  return value.replace(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g, (ch) =>
    ch === "\r\n" || ch === "\n" || ch === "\r" ? "\\n" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}
