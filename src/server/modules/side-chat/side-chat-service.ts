import { toUserFacingError } from "../../platform/errors.js";
import { logError } from "../../platform/logger.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { SideChatDto } from "../../../shared/api/side-chat.js";
import type { AgentMessage, AgentStore } from "../agent/agent-store.js";
import type { BackgroundTaskStore } from "../agent/background-task-store.js";
import type { AgentUserMessageQueue } from "../agent/user-message-queue.js";
import type { StepPrompt } from "../agent/wake-loop.js";
import type { ThreadDeletion } from "../agent/thread-delete.js";
import { normalizeThreadTitle, untitledFallback } from "../agent/manager-threads.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { runLlmCandidates } from "../llm/run-candidates.js";
import { writeSideChatArchive } from "./side-chat-archive.js";
import type { SideChatSendStore, WaitingSend } from "./side-chat-sends.js";
import type { SideChatModelCall } from "./side-chat-model.js";
import { SIDE_CHAT_BOUNDARY, sideChatHandoffMessage, sideChatHandoffRequest } from "./side-chat-texts.js";

/** What a side chat is called before it has a first line of its own. */
export const UNTITLED_SIDE_CHAT = "New side chat";

/** How long an end waits for the side chat's work to stop: a turn's stop
 *  and a command's kill settle well within it. */
const STOP_WAIT_MS = 10_000;
/** How long it waits while a compaction of it is under way (one it cannot
 *  stop): a compaction ends within its own call's time. */
const COMPACTION_WAIT_MS = 120_000;
const STOP_POLL_MS = 50;

export type SideChatResult<T> = T | { error: string; status: 400 | 404 | 409 | 502 };

export interface SideChatServiceDeps {
  agentStore: AgentStore;
  backgroundTasks: Pick<BackgroundTaskStore, "countRunning">;
  /** The conversations' queue: a side chat's messages still waiting behind
   *  its turn are written into it before an end (so the file Send keeps has
   *  them), and the hand-over goes to the main conversation through it, in
   *  order with what the user writes there. */
  queue: Pick<AgentUserMessageQueue, "flushQueuedIntoThread" | "submitThreadUserMessage">;
  /** Sends whose message waits behind the main conversation's turn, kept in
   *  the database until it is in: a restart delivers them then. */
  sends: Pick<SideChatSendStore, "add" | "remove" | "list">;
  /** A compaction of it is under way. */
  compacting?: (threadId: string) => boolean;
  deletion: Pick<ThreadDeletion, "deleteSideChat" | "sideChatStillWorking">;
  sse: Pick<AgentSseEmitter, "emit">;
  /** A turn holds the thread, or its wake's row still runs. */
  turnRunning: (threadId: string) => boolean;
  /** Its running turn is stopped, and everything it holds released
   *  (commands, queued messages, monitors, alarms). */
  stopWork: (threadId: string) => void;
  /** The side chat's next step's prompt, as its turn would send it. */
  stepPrompt: (threadId: string) => Promise<StepPrompt>;
  callModel: SideChatModelCall;
  /** Where the side chats sent are kept, for the main conversation to read. */
  archiveDir: () => string;
  timeZone: string;
  now: () => Date;
  /** How a wait (a retry, the stop's poll) waits; a plain timer unless a test's. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Side chats: the personal agent's conversation forked, as it stands, into a
 * thread of its own (AgentStore.copyConversation), then talked in as any
 * thread is. One ends by Send, a summary into the main conversation through
 * its queue (its canvases pass there too), or by Discard; either stops its
 * work first, and then nothing of it is left but, for Send, that message
 * and the file it names.
 */
export class SideChatService {
  /** Sends whose message waits behind the main conversation's turn, by the
   *  message's request id: the side chat (archived, hidden) goes when its
   *  message is in. Kept in the database too (deps.sends), so a restart
   *  meanwhile delivers it then (recoverAtStartup). */
  private readonly waitingSends = new Map<string, WaitingSend>();

  constructor(private readonly deps: SideChatServiceDeps) {}

  open(): SideChatDto {
    const store = this.deps.agentStore;
    const id = store.transaction(() => {
      const personal = store.getOrCreatePersonalThread();
      const side = store.createSideChatThread();
      // The model the agent runs on now: the cached prefix is that model's.
      const model = store.threadModelOverride(personal.id);
      if (model) store.setThreadModelOverride(side.id, model);
      store.copyConversation(personal.id, side.id);
      const boundary = store.appendMessage({
        threadId: side.id, role: "user", source: "side-chat-boundary",
        content: { type: "text", text: SIDE_CHAT_BOUNDARY }
      });
      // What it starts with was read in the main conversation.
      store.markThreadSeen(side.id, boundary.seq);
      return side.id;
    });
    return this.publish(id)!;
  }

  list(): SideChatDto[] {
    return this.deps.agentStore.listOpenSideChatThreads()
      .map((t) => this.dto(t.id))
      .filter((d): d is SideChatDto => d !== null)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  dto(id: string): SideChatDto | null {
    const store = this.deps.agentStore;
    const t = store.getThreadById(id);
    // One being ended is archived until it is gone: nothing more is done to it.
    if (!t || t.scope !== "side_chat" || t.archivedAt) return null;
    const start = store.sideChatStartSeq(id) ?? 0;
    return {
      id: t.id,
      title: t.title ?? untitledFallback(store.firstUserLine(id, start)) ?? UNTITLED_SIDE_CHAT,
      named: t.title !== null,
      createdAt: t.createdAt,
      lastActivityAt: store.lastActivityAt(id) ?? t.createdAt,
      lastVisibleSeq: store.lastVisibleSeq(id),
      seenSeq: t.seenSeq,
      // As a thread's row shows it: its wake's row runs (the turn's end is
      // announced once that row has ended, before the turn lets go of the
      // thread), or a command of its is open.
      working: Boolean(store.getRunningWakeForThread(id)) || this.commandsOpen(id)
    };
  }

  rename(id: string, raw: unknown): SideChatResult<SideChatDto> {
    if (!this.dto(id)) return NOT_FOUND;
    const title = normalizeThreadTitle(raw);
    if (!title) return { error: "title must be 1-80 characters on one line", status: 400 };
    this.deps.agentStore.setThreadTitle(id, title);
    return this.publish(id)!;
  }

  markSeen(id: string, seq: unknown): SideChatResult<SideChatDto> {
    if (!this.dto(id)) return NOT_FOUND;
    if (typeof seq !== "number" || !Number.isFinite(seq)) return { error: "seq must be a number", status: 400 };
    this.deps.agentStore.markThreadSeen(id, seq);
    return this.publish(id)!;
  }

  /** Its summary for the main conversation, from its own context: one call
   *  on its next step's prompt, the request after it. Kept nowhere. */
  async summary(id: string, signal?: AbortSignal): Promise<SideChatResult<{ summary: string }>> {
    if (!this.dto(id)) return NOT_FOUND;
    try {
      const prompt = await this.deps.stepPrompt(id);
      const request = { role: "user" as const, content: sideChatHandoffRequest("") };
      const abort = signal ?? new AbortController().signal;
      const reply = await runLlmCandidates({
        candidates: prompt.candidates,
        signal: abort,
        ...(this.deps.wait ? { wait: this.deps.wait } : {}),
        attempt: (candidate, at) => this.deps.callModel({
          candidate, prompt, threadId: id, signal: abort, at,
          messages: [...prompt.messagesFor(candidate), request]
        })
      });
      if (reply.cutOff) return { error: "Cut off at the output token limit.", status: 502 };
      const summary = reply.text.trim();
      return summary ? { summary } : { error: "Finished without a reply", status: 502 };
    } catch (error) {
      return { error: toUserFacingError(error, "LLM call failed").message, status: 502 };
    }
  }

  /** Sent to the main conversation: its work stops (what was still queued in
   *  it written in first), the whole side chat is kept in a file, one message
   *  goes into the main conversation through its queue (now when it rests,
   *  else behind its turn, in order with what the user writes there), and
   *  the side chat ends, its canvases passed on, once that message is in. */
  async send(id: string, input: { summary: unknown; note: unknown }): Promise<SideChatResult<{ ok: true }>> {
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!summary) return { error: "a summary is required", status: 400 };
    if (!this.dto(id)) return NOT_FOUND;
    const stopped = await this.stop(id, { keepQueued: true });
    if (stopped) return stopped;
    const store = this.deps.agentStore;
    const start = store.sideChatStartSeq(id) ?? 0;
    const rows = store.getMessagesSince(id, start);
    const file = writeSideChatArchive(this.deps.archiveDir(), rows, this.deps.now(), this.deps.timeZone);
    const personal = store.getOrCreatePersonalThread();
    const send: WaitingSend = {
      sideChatId: id, personalThreadId: personal.id, requestId: `side-chat-${id}`,
      text: sideChatHandoffMessage({ summary, file, note }), part: { summary, note, file }
    };
    if (this.deliver(send)) return this.finish(send);
    // Waiting behind the main conversation's turn: gone from every window's
    // list now, deleted once its message is in.
    this.deps.sse.emit(SSE_EVENTS.sideChatDeleted, { id });
    return { ok: true };
  }

  /** A message just written into a conversation: a Send's that waited ends
   *  its side chat now. */
  landed(message: AgentMessage): void {
    const requestId = message.content.type === "text" ? message.content.clientRequestId : undefined;
    const waiting = requestId ? this.waitingSends.get(requestId) : undefined;
    if (!waiting) return;
    const removed = this.finish(waiting);
    if ("error" in removed) logError("side chat", new Error(removed.error), `side chat ${waiting.sideChatId} sent but not removed`);
  }

  /** At the server's start: each Send a restart caught waiting is delivered
   *  now (its side chat was kept hidden: AgentStore.reopenSideChatsBeingEnded). */
  recoverAtStartup(): void {
    const store = this.deps.agentStore;
    const waiting = this.deps.sends.list().filter((send) => {
      if (store.getThreadById(send.sideChatId)?.scope === "side_chat") return true;
      this.deps.sends.remove(send.sideChatId);
      return false;
    });
    // To the main conversation open now (it may have been replaced).
    const personal = store.getOrCreatePersonalThread();
    for (const send of waiting) {
      const now = { ...send, personalThreadId: personal.id };
      if (this.deliver(now)) this.finish(now);
    }
  }

  /** Into the main conversation's queue, kept until it is in. True when it
   *  was written at once. */
  private deliver(send: WaitingSend): boolean {
    this.waitingSends.set(send.requestId, send);
    this.deps.sends.add(send);
    const result = this.deps.queue.submitThreadUserMessage({
      threadId: send.personalThreadId, content: send.text, source: "user", clientRequestId: send.requestId, sideChat: send.part
    });
    return !result.queued;
  }

  /** Its message is in: the side chat goes, its canvases to the main
   *  conversation. Once only (the queue's hook may have done it already). */
  private finish(send: WaitingSend): SideChatResult<{ ok: true }> {
    if (!this.waitingSends.delete(send.requestId)) return { ok: true };
    this.deps.sends.remove(send.sideChatId);
    return this.remove(send.sideChatId, send.personalThreadId);
  }

  /** Discarded: its work stops, and it goes with its canvases. */
  async discard(id: string): Promise<SideChatResult<{ ok: true }>> {
    if (!this.dto(id)) return NOT_FOUND;
    const stopped = await this.stop(id);
    if (stopped) return stopped;
    return this.remove(id, null);
  }

  publish(id: string): SideChatDto | null {
    const dto = this.dto(id);
    if (dto) this.deps.sse.emit(SSE_EVENTS.sideChatUpdated, { sideChat: dto });
    return dto;
  }

  private commandsOpen(id: string): boolean {
    return this.deps.backgroundTasks.countRunning(id, "command") > 0;
  }

  /** Still busy for an end: a turn holds it, a command of its is open, or
   *  anything its delete would wait for (a model call still recorded as
   *  running: a cache seal goes out minutes after its last step). */
  private busy(id: string): boolean {
    return this.deps.turnRunning(id) || this.commandsOpen(id) || this.deps.deletion.sideChatStillWorking(id);
  }

  /** Its turn stopped and its commands killed, and waited for: what still
   *  ran would write into rows about to go. It is archived meanwhile, so
   *  nothing starts a turn of its own (mail waiting behind the stopped turn,
   *  a message from another window); refused, it is open again as it was. */
  private async stop(id: string, opts: { keepQueued?: boolean } = {}): Promise<{ error: string; status: 409 } | null> {
    this.deps.agentStore.archiveThread(id);
    if (opts.keepQueued) this.deps.queue.flushQueuedIntoThread(id);
    this.deps.stopWork(id);
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let waited = 0; this.busy(id); waited += STOP_POLL_MS) {
      const limit = this.deps.compacting?.(id) ? COMPACTION_WAIT_MS : STOP_WAIT_MS;
      if (waited >= limit) {
        this.deps.agentStore.unarchiveThread(id);
        this.publish(id);
        return { error: "Its work is still stopping. Try again in a moment.", status: 409 };
      }
      await wait(STOP_POLL_MS);
    }
    return null;
  }

  private remove(id: string, canvasesTo: string | null): SideChatResult<{ ok: true }> {
    const removed = this.deps.deletion.deleteSideChat(id, { canvasesTo });
    if (!removed.ok) return { error: removed.error, status: removed.status };
    this.deps.sse.emit(SSE_EVENTS.sideChatDeleted, { id });
    return { ok: true };
  }
}

const NOT_FOUND = { error: "side chat not found", status: 404 as const };

/**
 * Each side chat's row in the list follows its work: a message, one deleted
 * (an unnamed chat's title is its first message), a turn starting or ending,
 * a command starting or ending republishes it (once per tick, however many
 * arrived).
 */
export function startSideChatBroadcast(input: {
  sse: Pick<AgentSseEmitter, "addSink">;
  service: Pick<SideChatService, "publish">;
  agentStore: Pick<AgentStore, "getThreadById">;
}): () => void {
  const pending = new Set<string>();
  return input.sse.addSink((e) => {
    let threadId: string | undefined;
    if (e.event === SSE_EVENTS.agentMessageAppended || e.event === SSE_EVENTS.agentMessageDeleted || e.event === SSE_EVENTS.agentWakeStarted || e.event === SSE_EVENTS.agentWakeFinished) {
      const data = e.data as { threadId: string; scope?: string };
      if (data.scope && data.scope !== "side_chat") return;
      threadId = data.threadId;
    } else if (e.event === SSE_EVENTS.backgroundTaskChanged) {
      threadId = (e.data as { task?: { parentThreadId?: string } }).task?.parentThreadId;
    } else {
      return;
    }
    if (!threadId || pending.has(threadId)) return;
    if (input.agentStore.getThreadById(threadId)?.scope !== "side_chat") return;
    pending.add(threadId);
    queueMicrotask(() => {
      pending.delete(threadId);
      try {
        input.service.publish(threadId);
      } catch (err) {
        logError("side chat broadcast", err);
      }
    });
  });
}
