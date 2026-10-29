import type {
  AgentStore, AgentWakeReason, AgentMessage, AgentMessageAttachment
} from "./agent-store.js";
import type { AgentMessageSource, RelayMarker } from "../../../shared/agent-message-types.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import {
  answersMetadata, controlMetadata, landedAfterWaiting, openWhenWrittenMetadata, skippedContent,
  type AnsweredQuestion, type OpenQuestion, type QuestionSettlement, type QueuedAnswer
} from "../../../shared/questions.js";
import { mentionsMetadata, type Mention } from "../../../shared/mentions.js";

interface QueuedUserMessage {
  content: string;
  attachments: AgentMessageAttachment[];
  source: AgentMessageSource;
  sourceThreadId: string | null;
  clientRequestId?: string | null;
  relay?: RelayMarker | null;
  /** The questions this message was picked for; none when it was typed. */
  answers: AnsweredQuestion[];
  /** A control sent it for the user (Continue): not their answer to anything. */
  control: "continue" | null;
  /** Once it waits behind a running turn: the questions open when it was
   *  taken in, the ones it can answer when it lands. */
  openWhenWritten?: string[];
  /** What its `@<label>` words name, checked by the route. */
  mentions: Mention[];
  /** Once it waits behind a running turn: when it was taken in, the time
   *  the model reads on it when it lands. */
  arrivedAt?: string;
}

interface UserMessageQueueDeps {
  agentStore: AgentStore;
  sse?: Pick<AgentSseEmitter, "emit">;
  wakeScheduler: {
    wake: (threadId: string, reason: AgentWakeReason, triggerMessageId: string | null) => string | null;
    isThreadBusy?: (threadId: string) => boolean;
    getRunningWakeForThread?: (threadId: string) => unknown;
    /** A message sent to an idle thread is written, and its wake refused (a
     *  write the database refused): the thread's follow-up, whose flush wakes
     *  on it, is tried again. Without it the sender hears the refusal. */
    retryFollowUp?: (threadId: string, who: string, err: unknown) => void;
  };
  /** Every message the queue appends, as it lands (now or flushed later). */
  onMessageAppended?: (threadId: string, message: AgentMessage) => void;
  /** What a conversation holds behind its running turn changed: a message
   *  was taken in, taken back, or dropped. One that lands is an appended
   *  message, said by its own event. */
  onQueueChanged?: (threadId: string) => void;
  /** The user settled a question themselves, at the moment it was taken in:
   *  answered it (their own answer, not one their agent passed on), or
   *  skipped it. */
  onQuestionSettled?: (threadId: string, question: AnsweredQuestion, settled: QuestionSettlement) => void;
}

/** A message to a worker, addressed by its feature. A manager thread is
 *  addressed by id (submitThreadUserMessage). */
interface SubmitUserMessageInput {
  scope: "worker";
  scopeId: string;
  content: string;
  attachments?: AgentMessageAttachment[];
  clientRequestId?: string | null;
  relay?: RelayMarker | null;
}

interface SubmitThreadUserMessageInput {
  threadId: string;
  content: string;
  source: AgentMessageSource;
  sourceThreadId?: string | null;
  attachments?: AgentMessageAttachment[];
  clientRequestId?: string | null;
  relay?: RelayMarker | null;
  queueWhenBusy?: boolean;
  /** The open questions this message answers by a pick (the caller checked
   *  they are open). Absent or empty: the message was typed. */
  answers?: AnsweredQuestion[];
  /** The Continue control sent it: it answers no question. */
  control?: "continue" | null;
  /** What its `@<label>` words name (the caller checked them). */
  mentions?: Mention[];
}

interface SubmitUserMessageResult {
  threadId: string;
  messageId: string | null;
  wakeId: string | null;
  queued: boolean;
  queuedReason?: "running_wake";
}

export class AgentUserMessageQueue {
  private readonly pendingByThread = new Map<string, QueuedUserMessage[]>();
  /** Per thread, the last message a flush wrote whose wake was refused, and
   *  the thread's newest wake when it was written: a wake since read it. */
  private readonly unwokenByThread = new Map<string, { messageId: string; latestWakeId: string | null }>();

  constructor(private readonly deps: UserMessageQueueDeps) {}

  submitUserMessage(input: SubmitUserMessageInput): SubmitUserMessageResult {
    const thread = this.deps.agentStore.getOrCreateThread(input.scope, input.scopeId);
    return this.submitThreadUserMessage({
      threadId: thread.id,
      content: input.content,
      source: "user",
      sourceThreadId: null,
      attachments: input.attachments,
      clientRequestId: input.clientRequestId,
      relay: input.relay
    });
  }

  submitThreadUserMessage(input: SubmitThreadUserMessageInput): SubmitUserMessageResult {
    const queued: QueuedUserMessage = {
      content: input.content,
      attachments: input.attachments ?? [],
      source: input.source,
      sourceThreadId: input.sourceThreadId ?? null,
      clientRequestId: normalizeClientRequestId(input.clientRequestId),
      relay: input.relay ?? null,
      answers: input.control ? [] : input.answers ?? [],
      control: input.control ?? null,
      mentions: input.mentions ?? []
    };

    const queuedReason = this.queuedReason(input.threadId);
    if (queuedReason) {
      if (input.queueWhenBusy !== false) {
        this.enqueue(input.threadId, queued);
        this.noteSettled(input.threadId, queued);
      }
      return { threadId: input.threadId, messageId: null, wakeId: null, queued: true, queuedReason };
    }

    // Messages a refused flush kept go first, so this one lands after them;
    // refused again, this one is not written and the caller hears why. Each
    // counts as unwoken once written, as a flush's do.
    const latestWakeId = this.deps.agentStore.getLatestWakeForThread(input.threadId)?.id ?? null;
    const unwoken = (written: AgentMessage) => this.unwokenByThread.set(input.threadId, { messageId: written.id, latestWakeId });
    let message: AgentMessage;
    try {
      this.drainQueuedIntoThread(input.threadId, unwoken);
      message = this.appendAndBroadcast(input.threadId, queued, unwoken);
    } catch (err) {
      // What it did write is woken on when the thread's follow-up is tried again.
      if (this.unwokenByThread.has(input.threadId)) this.deps.wakeScheduler.retryFollowUp?.(input.threadId, `user message to ${input.threadId}`, err);
      throw err;
    }
    let wakeId: string | null;
    try {
      wakeId = this.deps.wakeScheduler.wake(input.threadId, "user", message.id);
      this.unwokenByThread.delete(input.threadId);
    } catch (err) {
      // Written, its wake refused (another writer held the database): the
      // thread's follow-up, which wakes on it, is tried again, and the
      // sender hears it was sent, not to send it again.
      if (!this.deps.wakeScheduler.retryFollowUp) throw err;
      this.deps.wakeScheduler.retryFollowUp(input.threadId, `user message ${message.id}`, err);
      wakeId = null;
    }
    // Others hear after: telling them cannot hold back this conversation's turn.
    this.noteSettled(input.threadId, queued);
    return { threadId: input.threadId, messageId: message.id, wakeId, queued: false };
  }

  /** The questions the user's own answer names are settled; their agent's,
   *  passed on for them, it already knows of. */
  private noteSettled(threadId: string, queued: QueuedUserMessage): void {
    if (queued.relay) return;
    for (const question of queued.answers) this.deps.onQuestionSettled?.(threadId, question, { how: "answered", answer: queued.content });
  }

  /** The user skipped an open question (the caller checked it is): it
   *  closes now, and its asker reads that it was skipped when it next looks.
   *  Nobody is woken. With the asker idle the row lands now; mid-turn it
   *  waits in the mailbox for the turn's next step, never between a tool
   *  call and its result, and the question counts as closed meanwhile. */
  skipQuestion(threadId: string, question: Pick<OpenQuestion, "id" | "question">): void {
    const content = skippedContent(question);
    if (this.isBusy(threadId)) {
      this.deps.agentStore.enqueueMailboxMessage({ threadId, role: "user", source: "question-skip", content, triggerTurn: false });
      this.deps.onQueueChanged?.(threadId);
    } else {
      const message = this.deps.agentStore.appendMessage({ threadId, role: "user", source: "question-skip", content });
      this.deps.sse?.emit(SSE_EVENTS.agentMessageAppended, { threadId, message });
      this.deps.onMessageAppended?.(threadId, message);
    }
    this.deps.onQuestionSettled?.(threadId, { id: question.id, question: question.question }, { how: "skipped" });
  }

  /** Writes what waited and wakes on the last of it. Messages written whose
   *  wake was refused (another writer held the database) are woken on at
   *  the next flush, unless a wake started since, which read them. */
  flushIfIdle(threadId: string): string | null {
    if (this.isBusy(threadId)) return null;
    const unwoken = this.unwokenByThread.get(threadId);
    if (!unwoken && this.pendingCount(threadId) === 0) return null;
    const latestWakeId = this.deps.agentStore.getLatestWakeForThread(threadId)?.id ?? null;
    if (unwoken && unwoken.latestWakeId !== latestWakeId) this.unwokenByThread.delete(threadId);
    // Each one counts as unwoken the moment it is written: a write after it
    // can be refused too.
    this.drainQueuedIntoThread(threadId, (message) => this.unwokenByThread.set(threadId, { messageId: message.id, latestWakeId }));
    const trigger = this.unwokenByThread.get(threadId);
    if (!trigger) return null;
    const wakeId = this.deps.wakeScheduler.wake(threadId, "user", trigger.messageId);
    this.unwokenByThread.delete(threadId);
    return wakeId;
  }

  flushQueuedIntoThread(threadId: string): AgentMessage[] {
    return this.drainQueuedIntoThread(threadId);
  }

  isFlushBlocked(threadId: string): boolean {
    return this.isBusy(threadId);
  }

  /** Writes the queued messages in order, each leaving the queue the moment
   *  it is written (before what follows a write, which can fail too): one the
   *  database refuses stays queued with the ones after it, for the next
   *  flush, and none is written twice. */
  private drainQueuedIntoThread(threadId: string, onWritten?: (message: AgentMessage) => void): AgentMessage[] {
    const queued = this.pendingByThread.get(threadId);
    if (!queued || queued.length === 0) return [];
    const written: AgentMessage[] = [];
    while (queued.length > 0) {
      written.push(this.appendAndBroadcast(threadId, queued[0]!, (message) => {
        queued.shift();
        onWritten?.(message);
      }));
    }
    this.pendingByThread.delete(threadId);
    return written;
  }

  pendingCount(threadId: string): number {
    return this.pendingByThread.get(threadId)?.length ?? 0;
  }

  /** What the user said to a conversation whose turn is running, not yet a
   *  row there: each such message answers the questions it names, or every
   *  one when it names none. Only their own words (typed, spoken, or sent by
   *  their agent for them): nothing else answers a question. */
  queuedAnswers(threadId: string): QueuedAnswer[] {
    return (this.pendingByThread.get(threadId) ?? [])
      .filter((message) => (message.source === "user" || message.source === "voice") && !message.control)
      .map((message) => ({ answers: message.answers, ...(message.openWhenWritten ? { openWhenWritten: message.openWhenWritten } : {}) }));
  }

  removeQueuedMessage(threadId: string, clientRequestId: string): boolean {
    const normalized = normalizeClientRequestId(clientRequestId);
    if (!normalized) return false;
    const pending = this.pendingByThread.get(threadId);
    if (!pending || pending.length === 0) return false;
    const next = pending.filter((message) => message.clientRequestId !== normalized);
    if (next.length === pending.length) return false;
    if (next.length === 0) this.pendingByThread.delete(threadId);
    else this.pendingByThread.set(threadId, next);
    this.deps.onQueueChanged?.(threadId);
    return true;
  }

  clearThread(threadId: string): number {
    const count = this.pendingByThread.get(threadId)?.length ?? 0;
    this.pendingByThread.delete(threadId);
    this.unwokenByThread.delete(threadId);
    if (count > 0) this.deps.onQueueChanged?.(threadId);
    return count;
  }

  private enqueue(threadId: string, message: QueuedUserMessage): void {
    // What the user wrote will land after whatever the running turn does
    // next, a new question among it: it answers what is open now.
    if ((message.source === "user" || message.source === "voice") && message.answers.length === 0 && !message.control) {
      message.openWhenWritten = this.deps.agentStore.openQuestions(threadId).map((question) => question.id);
    }
    message.arrivedAt = new Date().toISOString();
    const pending = this.pendingByThread.get(threadId) ?? [];
    pending.push(message);
    this.pendingByThread.set(threadId, pending);
    this.deps.onQueueChanged?.(threadId);
  }

  private isBusy(threadId: string): boolean {
    return this.queuedReason(threadId) !== null;
  }

  private queuedReason(threadId: string): "running_wake" | null {
    if (this.deps.wakeScheduler.getRunningWakeForThread?.(threadId)) return "running_wake";
    if (this.deps.wakeScheduler.isThreadBusy?.(threadId)) return "running_wake";
    return null;
  }

  /** `onWritten` runs once the message is written, before the broadcast and
   *  the follow-ups. */
  private appendAndBroadcast(threadId: string, queued: QueuedUserMessage, onWritten?: (message: AgentMessage) => void): AgentMessage {
    const metadata = {
      ...(queued.answers.length > 0 ? answersMetadata(queued.answers) : {}),
      ...(queued.control ? controlMetadata(queued.control) : {}),
      ...(queued.mentions.length > 0 ? mentionsMetadata(queued.mentions) : {}),
      // One that waited says what stood when it was written.
      ...(queued.openWhenWritten ? openWhenWrittenMetadata(queued.openWhenWritten) : {})
    };
    const content: AgentMessage["content"] = {
      type: "text",
      text: queued.content,
      ...(queued.attachments.length > 0 ? { attachments: queued.attachments } : {}),
      ...(queued.clientRequestId ? { clientRequestId: queued.clientRequestId } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(queued.relay ? { relay: queued.relay } : {}),
      ...(queued.arrivedAt ? { arrivedAt: queued.arrivedAt } : {})
    };
    const message = this.deps.agentStore.appendMessage({
      threadId,
      role: "user",
      source: queued.source,
      sourceThreadId: queued.sourceThreadId,
      // And, landing now, which questions were asked since: the asker reads
      // these words right after them.
      content: landedAfterWaiting(content, (stood) => this.deps.agentStore.questionsAskedSince(threadId, stood))
    });
    onWritten?.(message);
    this.deps.sse?.emit(SSE_EVENTS.agentMessageAppended, { threadId, message });
    this.deps.onMessageAppended?.(threadId, message);
    return message;
  }
}

function normalizeClientRequestId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}
