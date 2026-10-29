import type { Database } from "bun:sqlite";
import type { AgentMessage, AgentStore } from "../agent/agent-store.js";
import type { RelayMarker } from "../../../shared/agent-message-types.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { AgentUserMessageQueue } from "../agent/user-message-queue.js";
import { NO_TEXT_REPLY, type GlobalHandoffDto, type HandoffState } from "../../../shared/api/global-agent.js";
import { questionInOneLine, type AnsweredQuestion, type OpenQuestion, type QuestionSettlement } from "../../../shared/questions.js";
import type { StopVerdict, ThreadStop } from "../../../shared/thread-dot.js";
import type { ThreadNotice, ThreadNoticeStop } from "../../../shared/thread-notice.js";
import type { UpwardRoute } from "../agent/upward-inbox.js";
import { cutKeepingWhole } from "../agent/tool-output-spool.js";
import { normalizeThreadTitle, threadDisplayTitle } from "../agent/manager-threads.js";
import { HandoffStore, type HandoffRow } from "./handoff-store.js";
import { logError } from "../../platform/logger.js";

/** The wake id the voice coordinator dispatches tool calls with: a call
 *  made with it was spoken. */
export const VOICE_TOOL_WAKE_ID = "voice-session";
const REPLY_MAX_CHARS = 20_000;
/** What the agent's model is given of the last reply, as a row from read_thread is cut. */
const NOTICE_REPLY_MAX_CHARS = 4000;
/** What the agent's model is given of the reply a quiet notice tells of. */
const QUIET_REPLY_MAX_CHARS = 1500;
/** How recently the agent must have sent a thread a request to hear quietly of what it leaves the user. */
const QUIET_FOLLOW_MS = 7 * 86_400_000;
/** How much of each request a `done` or `cannot` notice repeats. */
const NOTICE_REQUEST_MAX_CHARS = 300;
const OPEN: readonly HandoffState[] = ["queued", "delivered", "waiting"];
/** A wait that is open: its message is in, or it never had one. */
const AWAITING: readonly HandoffState[] = ["delivered", "waiting"];

/** The matter a notice is about: the first wait it ends or was told to,
 *  else the worker or the thread. */
export function noticeKey(notice: ThreadNotice): string {
  if (notice.handoffIds.length > 0) return `handoff:${notice.handoffIds[0]}`;
  if (notice.kind === "feature" && notice.featureId) return `feature:${notice.featureId}`;
  return `thread:${notice.targetThreadId}`;
}

/** A wait's end, by how its target stopped: needing the
 *  user is a request; failed or gone, a lifecycle event; any other stop
 *  answers the request, a report. */
export function endedWaitRoute(notice: ThreadNotice): UpwardRoute {
  const key = noticeKey(notice);
  // In the user's own round the question is theirs: a note.
  if (notice.stop === "needs_you") return { kind: notice.direct ? "note" : "request", key };
  if (notice.stop === "failed" || notice.stop === "archived") return { kind: "lifecycle", key, lifecycleReason: notice.stop };
  return { kind: "report", key };
}

interface HandoffServiceDeps {
  db: Database;
  agentStore: AgentStore;
  featuresStore: Pick<FeaturesStore, "getById">;
  queue: Pick<AgentUserMessageQueue, "submitUserMessage" | "submitThreadUserMessage">;
  emit?: (handoff: GlobalHandoffDto) => void;
  /** The agent's display name now, stamped on what it sends. */
  agentName?: () => string;
  /** How a target has stopped, null while it has not. */
  stopOf?: (threadId: string) => ThreadStop | null;
  /** Tells the agent, as `route` says: a note is news that asks nothing of
   *  it, read at its next step; any other kind wakes it. */
  notify?: (globalThreadId: string, notice: ThreadNotice, lastReply: string | null, route: UpwardRoute) => void;
  /** A notice that wakes told in two steps: the notice is written (inside
   *  the transaction that ends the wait), and the returned function asks for
   *  the wake once that has committed. Without it, `notify` tells it. */
  recordNotice?: (globalThreadId: string, notice: ThreadNotice, lastReply: string | null, route: UpwardRoute) => () => void;
  /** The manager stop check's verdict on a stopped thread's latest reply, for its
   *  notice to say: a promise that resolves (null when none came in time),
   *  or null when there is nothing to wait for (the check off). */
  stopVerdict?: (threadId: string) => Promise<StopVerdict | null> | null;
  /** Runs a step no caller tries again (the end of a notice that waited for
   *  a verdict), trying it again itself when it fails. Without it, a
   *  failure is logged and the waits end at the thread's next settle. */
  later?: (who: string, step: () => void) => void;
}

/** What the global agent sends for the user, and the one notice each send
 *  is answered with when its target stops. */
export class HandoffService {

  private readonly store: HandoffStore;
  /** Handoffs being sent now, and whether their message went in yet: told in
   *  memory before the row is marked delivered, which the database can refuse. */
  private readonly sending = new Map<string, { wentIn: boolean }>();
  /** Threads whose stop notice waits for the manager stop check's verdict. */
  private readonly awaitingVerdict = new Set<string>();
  /** Each thread's latest such wait: only its end may end the thread's waits,
   *  so an older one's retry gives way to the wait that replaced it. */
  private readonly latestVerdictWait = new Map<string, number>();
  private verdictWaits = 0;

  constructor(private readonly deps: HandoffServiceDeps) {
    this.store = new HandoffStore(deps.db);
  }

  sendToFeature(input: { globalThreadId: string; featureId: string; text: string; spoken: boolean }): GlobalHandoffDto {
    const feature = this.deps.featuresStore.getById(input.featureId);
    if (!feature) throw new Error(`worker not found: ${input.featureId}`);
    if (feature.archivedAt) throw new Error(`worker is archived: ${feature.name}`);
    const row = this.store.insert({
      globalThreadId: input.globalThreadId, kind: "feature", state: "queued", text: input.text,
      spoken: input.spoken, featureId: input.featureId, targetThreadId: null, newThreadTitle: null
    });
    const result = this.untilSent(row, () => this.deps.queue.submitUserMessage({
      scope: "worker", scopeId: input.featureId, content: input.text,
      relay: this.relay(row)
    }));
    // noteAppended already moved it to delivered when the message went in now.
    this.store.transition(row.id, ["queued", "delivered"], { targetThreadId: result.threadId });
    return this.publish(row.id);
  }

  /** Work sent to a thread at once, or to a new one opened for it. With
   *  `answers`, the message answers that question of the thread's manager to
   *  the user, found by its words: the manager reads it as the answer, and
   *  only that question closes. */
  sendToThread(input: { globalThreadId: string; threadId?: string; newThreadTitle?: string; text: string; spoken: boolean; answers?: string }): GlobalHandoffDto {
    if (Boolean(input.threadId) === (input.newThreadTitle !== undefined)) throw new Error("give exactly one of threadId and newThreadTitle");
    const title = input.newThreadTitle === undefined ? null : normalizeThreadTitle(input.newThreadTitle);
    if (input.newThreadTitle !== undefined && !title) throw new Error("newThreadTitle must be 1-80 characters on one line");
    if (input.threadId && !this.isOpenManagerThread(input.threadId)) throw new Error(`thread not found: ${input.threadId}`);
    // Checked before anything is sent or opened: a new thread has asked nothing.
    const answers = input.answers === undefined ? [] : [this.answered(input.threadId ? this.deps.agentStore.openQuestions(input.threadId) : [], input.answers)];
    const threadId = input.threadId ?? this.deps.agentStore.createManagerThread(title!).id;
    const row = this.store.insert({
      globalThreadId: input.globalThreadId, kind: "thread", state: "queued", text: input.text,
      spoken: input.spoken, featureId: null, targetThreadId: threadId, newThreadTitle: title
    });
    // noteAppended moves it to delivered when the message goes in now.
    this.untilSent(row, () => this.deps.queue.submitThreadUserMessage({
      threadId, content: input.text, source: "user", sourceThreadId: null,
      relay: this.relay(row),
      answers
    }));
    return this.publish(row.id);
  }

  /** Whether `threadId` has a question open that an answer could name; a
   *  thread not given (a new one) has asked nothing. */
  asksNow(threadId: string | undefined): boolean {
    return threadId !== undefined && this.deps.agentStore.openQuestions(threadId).length > 0;
  }

  /** Sends a handoff's message. One the database refused before it went in
   *  leaves no handoff: the agent hears the error from its call and waits on
   *  nothing (a row left queued would read as a wait until a restart). One
   *  that went in stays, whatever failed after it — marking it delivered
   *  included (noteAppended tells `sending` first). */
  private untilSent<T>(row: HandoffRow, send: () => T): T {
    const sent = { wentIn: false };
    this.sending.set(row.id, sent);
    try {
      return send();
    } catch (error) {
      if (!sent.wentIn) {
        try {
          this.store.deleteQueued(row.id);
        } catch {
          // Refused too: it stays queued, and a restart fails it.
        }
      }
      throw error;
    } finally {
      this.sending.delete(row.id);
    }
  }

  /** The open question the agent's words name, as the thread's manager asked
   *  it: matched on one line, as the agent was told it (cut when long). */
  private answered(open: readonly OpenQuestion[], words: string): AnsweredQuestion {
    const named = questionInOneLine(words);
    const question = open.find((q) => questionInOneLine(q.question) === named);
    if (question) return { id: question.id, question: question.question };
    const there = open.length > 0
      ? `Open there now: ${open.map((q) => `"${questionInOneLine(q.question)}"`).join(", ")}.`
      : "It has no open question now.";
    throw new Error(`Not an open question of that thread: "${named}". ${there}`);
  }

  /** The mark on a message the agent sent: who it is, so the receiving model
   *  can be told as the page's "via <name>" tells a person. */
  private relay(row: HandoffRow): RelayMarker {
    const name = this.deps.agentName?.();
    return { by: "global", spoken: row.spoken, handoffId: row.id, ...(name ? { name } : {}) };
  }

  /** A wait with nothing sent: on a thread, or on a worker's own chat.
   *  One that has already stopped arms nothing and says how. */
  awaitStop(input: { globalThreadId: string; threadId?: string; featureId?: string }): { stopped: ThreadStop } | { handoff: GlobalHandoffDto } {
    if (Boolean(input.threadId) === Boolean(input.featureId)) throw new Error("give exactly one of threadId and featureId");
    let targetThreadId: string;
    if (input.featureId) {
      const feature = this.deps.featuresStore.getById(input.featureId);
      if (!feature) throw new Error(`worker not found: ${input.featureId}`);
      if (feature.archivedAt) throw new Error(`worker is archived: ${feature.name}`);
      const chat = this.deps.agentStore.getThreadByScope("worker", input.featureId);
      if (!chat) throw new Error(`worker has no chat yet: ${feature.name}`);
      targetThreadId = chat.id;
    } else {
      if (!this.isOpenManagerThread(input.threadId!)) throw new Error(`thread not found: ${input.threadId}`);
      targetThreadId = input.threadId!;
    }
    const stopped = this.deps.stopOf?.(targetThreadId) ?? null;
    if (stopped) return { stopped };
    const row = this.store.insert({
      globalThreadId: input.globalThreadId, kind: input.featureId ? "feature" : "thread", state: "waiting", text: "",
      spoken: false, featureId: input.featureId ?? null, targetThreadId, newThreadTitle: null
    });
    return { handoff: this.publish(row.id) };
  }

  /** The queue appended a message: if it carries a handoff, that handoff is delivered. */
  noteAppended(threadId: string, message: AgentMessage): void {
    if (message.content.type !== "text" || !message.content.relay) return;
    const id = message.content.relay.handoffId;
    const sent = this.sending.get(id);
    if (sent) sent.wentIn = true;
    if (this.store.transition(id, ["queued"], { state: "delivered", targetThreadId: threadId, messageId: message.id, messageSeq: message.seq })) {
      this.publish(id);
    }
  }

  /** A thread's turn ended and what was queued behind it has started: the
   *  waits on it end if it has stopped, and so do the waits on the thread
   *  that owns it when it is a worker's chat. */
  noteSettled(threadId: string): void {
    this.checkTarget(threadId);
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (thread?.scope === "worker" && thread.scopeId) {
      const owner = this.deps.featuresStore.getById(thread.scopeId)?.ownerThreadId;
      if (owner) this.checkTarget(owner);
    }
  }

  /** Ends every open wait on `threadId`, if that target has stopped or is
   *  gone. A thread that stopped (nothing in it asks or failed) waits first
   *  for the manager stop check's verdict, for its notice to say; meanwhile another
   *  check of it does nothing. */
  checkTarget(threadId: string): void {
    if (this.awaitingVerdict.has(threadId)) return;
    const open = this.store.listByTarget(threadId, AWAITING);
    if (open.length === 0) return;
    // One target: gone for one of its waits is gone for all.
    const gone = this.goneReason(open[0]!);
    if (gone) {
      this.endWaits(open, "archived", gone);
      return;
    }
    const stop = this.deps.stopOf?.(threadId) ?? null;
    if (!stop) return;
    // A worker's stop is its own: the manager stop check speaks for threads.
    const verdict = stop === "stopped" && open[0]!.kind === "thread" ? this.deps.stopVerdict?.(threadId) ?? null : null;
    if (!verdict) {
      this.endWaits(open, stop, null);
      return;
    }
    this.awaitingVerdict.add(threadId);
    const wait = ++this.verdictWaits;
    this.latestVerdictWait.set(threadId, wait);
    // The reply the verdict is about: a newer one by the time it lands has its own.
    const judgedSeq = this.deps.agentStore.latestReply(threadId)?.seq ?? null;
    void verdict.then((found) => found, () => null).then((found) => {
      this.awaitingVerdict.delete(threadId);
      const who = `the stop notice of thread ${threadId}`;
      const step = () => this.endAfterVerdict(threadId, found, judgedSeq, wait);
      if (this.deps.later) {
        this.deps.later(who, step);
        return;
      }
      try {
        step();
      } catch (err) {
        logError(who, err);
      }
    });
  }

  /** The verdict is in (or none came in time): the waits end as the thread
   *  stands now. Working again, they stay open, and its next stop tells it;
   *  stopped on a newer reply, that reply's verdict is waited for. */
  private endAfterVerdict(threadId: string, verdict: StopVerdict | null, judgedSeq: number | null, wait: number): void {
    // A newer wait started meanwhile (it may have ended already): it ends them.
    if (this.awaitingVerdict.has(threadId) || this.latestVerdictWait.get(threadId) !== wait) return;
    this.latestVerdictWait.delete(threadId);
    try {
      this.endAfterVerdictNow(threadId, verdict, judgedSeq);
    } catch (err) {
      // Refused: tried again as this wait, still the latest.
      this.latestVerdictWait.set(threadId, wait);
      throw err;
    }
  }

  private endAfterVerdictNow(threadId: string, verdict: StopVerdict | null, judgedSeq: number | null): void {
    const open = this.store.listByTarget(threadId, AWAITING);
    if (open.length === 0) return;
    const gone = this.goneReason(open[0]!);
    if (gone) {
      this.endWaits(open, "archived", gone);
      return;
    }
    const stop = this.deps.stopOf?.(threadId) ?? null;
    if (!stop) return;
    // A newer reply, or a word sent after the judged one (its turn may have
    // written nothing): the verdict is about a reply the matter moved past.
    // Checked again, the newer reply is judged, or nothing is.
    if (stop === "stopped" && ((this.deps.agentStore.latestReply(threadId)?.seq ?? null) !== judgedSeq
      || this.deps.agentStore.latestPersonMessageSeq(threadId) > (judgedSeq ?? 0))) {
      this.checkTarget(threadId);
      return;
    }
    this.endWaits(open, stop, null, undefined, stop === "stopped" ? verdict ?? undefined : undefined);
  }

  /** The waits manager request check judges on `threadId`: sends to a thread that
   *  went in and carry words. A wait with nothing sent, a send still queued
   *  and a worker's are left to the thread's stop. */
  openRequestWaits(threadId: string): HandoffRow[] {
    return this.store.listByTarget(threadId, AWAITING)
      .filter((row) => row.kind === "thread" && row.text.trim() !== "" && row.messageSeq !== null);
  }

  /** Whether a question of `threadId` is open that a conversation was told
   *  of: the agent then knows the work waits for the user. */
  questionToldOpen(threadId: string): boolean {
    return this.deps.agentStore.openQuestions(threadId)
      .some((question) => this.store.toldOfQuestion(threadId, question.id).length > 0);
  }

  /** The thread works on, but its manager said these requests are done (or
   *  cannot go on): their waits end, told in one notice naming each request,
   *  with the reply that said so. One already ended is left alone: the ids
   *  are of those it ended. */
  endJudged(rows: HandoffRow[], outcome: "done" | "cannot", reply: string): string[] {
    return this.endWaits(rows, outcome, null, { reply });
  }

  /** A thread asked the user a question: each conversation that waits on it
   *  is told now, once, and goes on waiting. The thread works on; when it
   *  stops, its waits end as they always do. A send it has not read yet is no
   *  wait on what it does now. */
  noteQuestion(threadId: string, question: OpenQuestion): void {
    const waiting = new Map<string, HandoffRow[]>();
    for (const row of this.store.listByTarget(threadId, AWAITING)) {
      waiting.set(row.globalThreadId, [...(waiting.get(row.globalThreadId) ?? []), row]);
    }
    // Whose round it is: the user's own when they started it — they
    // have the question in front of them: a note. Else Your agent is woken.
    const turn = this.deps.agentStore.getLatestWakeForThread(threadId);
    const own = this.usersOwnRound(threadId, Number.MAX_SAFE_INTEGER, turn?.id ?? null);
    for (const [globalThreadId, rows] of waiting) {
      const first = rows[0]!;
      const notice: ThreadNotice = {
        handoffIds: rows.map((row) => row.id),
        kind: first.kind,
        targetThreadId: first.targetThreadId,
        featureId: first.featureId,
        title: this.titleOf(first),
        stop: "asked",
        reason: null,
        question: { id: question.id, text: question.question, options: question.options },
        ...(own ? { direct: true } : {})
      };
      this.deps.notify?.(globalThreadId, notice, null, { kind: own ? "note" : "request", key: noticeKey(notice) });
    }
  }

  /** A question a conversation was told of was settled in its thread
   *  without the agent: the user answered or skipped it there, or its manager
   *  took it back. Each conversation told of it hears so, once; it is woken
   *  only while it has a question of its own open, which may be this one. */
  noteQuestionSettled(threadId: string, question: AnsweredQuestion, settled: QuestionSettlement): void {
    const told = this.store.toldOfQuestion(threadId, question.id);
    if (told.length === 0) return;
    for (const globalThreadId of told) {
      const said = settled.how === "answered"
        ? { how: settled.how, answer: cutKeepingWhole(settled.answer, NOTICE_REPLY_MAX_CHARS, { threadId: globalThreadId }) }
        : settled;
      const notice: ThreadNotice = {
        handoffIds: [],
        kind: "thread",
        targetThreadId: threadId,
        featureId: null,
        title: threadDisplayTitle(this.deps.agentStore, threadId),
        stop: "settled",
        reason: null,
        question: { id: question.id, text: question.question, options: [] },
        settled: said
      };
      const kind = this.deps.agentStore.openQuestions(globalThreadId).length > 0 ? "request" : "note";
      this.deps.notify?.(globalThreadId, notice, null, { kind, key: noticeKey(notice) });
    }
  }

  /** The manager stop check judged `threadId`'s latest reply. When it leaves the
   *  user a result or a decision, each conversation that sent the thread a
   *  request this week hears so: as a round the user drove directly, or as
   *  what came after the thread answered its request. A result is told
   *  without a wake, and so is the user's own round; a decision after the
   *  request wakes it, to tell the user now. A wait of
   *  its own still open tells it with its notice; a wait that ended telling
   *  of this reply told it already. */
  noteVerdict(threadId: string, judged: { replySeq: number; outcome: StopVerdict }): void {
    const outcome = judged.outcome;
    if (outcome === "nothing" || !this.isOpenManagerThread(threadId)) return;
    if (this.deps.stopOf?.(threadId) !== "stopped") return;
    // Still where the thread stands: its latest reply, nothing sent since.
    const reply = this.deps.agentStore.latestReply(threadId);
    if (!reply || reply.seq !== judged.replySeq || this.deps.agentStore.latestPersonMessageSeq(threadId) > reply.seq) return;
    // Whose round: one the user started, or what came after a request
    // relayed — a round anything else woke (a worker, an alarm) included.
    if (!this.deps.agentStore.latestPersonMessageBefore(threadId, reply.seq)) return;
    const after = !this.usersOwnRound(threadId, reply.seq, reply.wakeId ?? null);
    const text = reply.content.type === "assistant" ? reply.content.text?.trim() ?? "" : "";
    // Written together: refused part way (a notice in, its read-back not),
    // nothing stays, and trying again writes each notice once. The wakes
    // come after the commit.
    const wakes = this.deps.db.transaction(() => this.tellOfVerdict(threadId, outcome, reply, text, after)).immediate();
    for (const wake of wakes) wake();
  }

  /** The notices of a judged reply; the wakes they ask for, to run once written. */
  private tellOfVerdict(threadId: string, outcome: Exclude<StopVerdict, "nothing">, reply: Pick<AgentMessage, "seq" | "createdAt">, text: string, after: boolean): Array<() => void> {
    const replyAt = reply.createdAt;
    // The user's own round: what they said, not the reply they have.
    const said = after ? null : this.deps.agentStore.userWordsInRound(threadId, reply.seq).join("\n\n");
    const wakes: Array<() => void> = [];
    const since = new Date(Date.now() - QUIET_FOLLOW_MS).toISOString();
    const open = this.store.listByTarget(threadId, OPEN);
    for (const sender of this.store.sendersTo(threadId)) {
      if (sender.lastSentAt < since) continue;
      if (open.some((row) => row.globalThreadId === sender.globalThreadId)) continue;
      // Told by a wait that ended since, as the wait kept it (a manager request check
      // ending one late tells of the reply it judged, maybe an older one).
      if (this.store.repliesToldAfter(sender.globalThreadId, threadId, replyAt).some((kept) => kept === limit(text))) continue;
      const conversation = this.deps.agentStore.getThreadById(sender.globalThreadId);
      if (!conversation || conversation.archivedAt) continue;
      const notice: ThreadNotice = {
        handoffIds: [],
        kind: "thread",
        targetThreadId: threadId,
        featureId: null,
        title: threadDisplayTitle(this.deps.agentStore, threadId),
        stop: "stopped",
        reason: null,
        verdict: outcome,
        ...(after ? { after: true } : { direct: true })
      };
      const body = after ? text : said ?? "";
      const lastReply = body ? cutKeepingWhole(body, QUIET_REPLY_MAX_CHARS, { threadId: sender.globalThreadId }) : null;
      // A decision after the agent's request is the user's to make: the agent
      // is woken to tell them. In the user's own round they have it in front
      // of them: told quietly, the agent's to judge.
      const key = noticeKey(notice);
      if (outcome !== "decision" || !after) this.deps.notify?.(sender.globalThreadId, notice, lastReply, { kind: "note", key });
      else if (this.deps.recordNotice) wakes.push(this.deps.recordNotice(sender.globalThreadId, notice, lastReply, { kind: "request", key }));
      else this.deps.notify?.(sender.globalThreadId, notice, lastReply, { kind: "request", key });
    }
    return wakes;
  }

  /** Whether the user started the round before `beforeSeq` of the turn
   *  `wakeId`: they spoke since the thread's previous turn,
   *  typed or spoken, and Your agent relayed nothing after them. */
  private usersOwnRound(threadId: string, beforeSeq: number, wakeId: string | null): boolean {
    const latest = this.deps.agentStore.latestPersonMessageBefore(threadId, beforeSeq);
    if (!latest || (latest.content.type === "text" && latest.content.relay)) return false;
    return latest.seq > this.deps.agentStore.roundStartSeq(threadId, beforeSeq, wakeId);
  }

  /** What a wait's target is called: the worker's name, or the thread's title. */
  private titleOf(row: HandoffRow): string {
    const dto = this.dtoOf(row);
    return row.kind === "feature" ? dto.featureName ?? "a worker" : dto.threadTitle ?? dto.newThreadTitle ?? "a thread";
  }

  /** Ends these waits one way, and tells each waiting conversation once per
   *  target: rows for several targets may end together (at start-up). */
  /** The ids of the waits it ended: one ended already is left as it is. */
  private endWaits(rows: HandoffRow[], stop: ThreadNoticeStop, reason: string | null, judged?: { reply: string }, verdict?: StopVerdict): string[] {
    const now = new Date().toISOString();
    const told = new Map<string, { rows: HandoffRow[]; reply: string | null }>();
    const ended: string[] = [];
    const wakes: Array<() => void> = [];
    // The waits' ends and their notices are written together: apart, a
    // database refusing the notice left a wait ended that nobody heard of,
    // and the next try found nothing open to tell. Refused, nothing is
    // written, and the next try does it all. The wakes come after the commit.
    this.deps.db.transaction(() => {
      for (const row of rows) {
        // Kept trimmed, as what the target last said is: a quiet notice
        // matches a reply by it, cut where the reply it reads is cut.
        const reply = judged ? judged.reply.trim() : this.replySince(row);
        const failed = stop === "failed" || stop === "archived";
        const changed = this.store.transition(row.id, OPEN, failed
          ? { state: "failed", stop, reason: reason ?? "It failed.", reply: reply ? limit(reply) : null, repliedAt: now }
          : { state: "replied", stop, reply: limit(reply ?? NO_TEXT_REPLY), repliedAt: now });
        if (!changed) continue;
        ended.push(row.id);
        const key = `${row.globalThreadId}\n${row.kind}:${row.featureId ?? row.targetThreadId ?? row.id}`;
        const group = told.get(key) ?? { rows: [], reply: null };
        group.rows.push(row);
        // Oldest first: the newest wait's view of what was last said wins.
        if (reply) group.reply = reply;
        told.set(key, group);
      }
      for (const group of told.values()) {
        const first = group.rows[0]!;
        // A thread that stopped needing the user in a round they started:
        // the question is in front of them.
        const own = stop === "needs_you" && first.targetThreadId !== null
          && this.usersOwnRound(first.targetThreadId, Number.MAX_SAFE_INTEGER, this.deps.agentStore.getLatestWakeForThread(first.targetThreadId)?.id ?? null);
        const notice: ThreadNotice = {
          handoffIds: group.rows.map((row) => row.id),
          kind: first.kind,
          targetThreadId: first.targetThreadId,
          featureId: first.featureId,
          title: this.titleOf(first),
          stop,
          reason,
          ...(judged ? { requests: group.rows.map((row) => row.text.slice(0, NOTICE_REQUEST_MAX_CHARS)) } : {}),
          ...(verdict ? { verdict } : {}),
          ...(own ? { direct: true } : {})
        };
        const lastReply = group.reply ? cutKeepingWhole(group.reply, NOTICE_REPLY_MAX_CHARS, { threadId: first.globalThreadId }) : null;
        const route = endedWaitRoute(notice);
        if (this.deps.recordNotice) wakes.push(this.deps.recordNotice(first.globalThreadId, notice, lastReply, route));
        else this.deps.notify?.(first.globalThreadId, notice, lastReply, route);
      }
    }).immediate();
    for (const id of ended) this.publish(id);
    for (const wake of wakes) wake();
    return ended;
  }

  /** What the target last said since this wait began. */
  private replySince(row: HandoffRow): string | null {
    if (!row.targetThreadId) return null;
    const messages = this.deps.agentStore.getMessages(row.targetThreadId);
    return latestText(row.messageSeq !== null
      ? messages.filter((m) => m.seq > row.messageSeq!)
      : messages.filter((m) => m.createdAt >= row.createdAt));
  }

  /** The target is gone (archived): every wait on it ends, and the agent is told. */
  failOpenForThread(threadId: string, reason: string): void {
    this.endWaits(this.store.listByTarget(threadId, OPEN), "archived", reason);
  }

  /** At start-up, once the wakes for queued mail have started. The
   *  user-message queue lives in memory: what it held is gone. Every other
   *  open wait is judged now: its target may have stopped while the server
   *  was down. */
  cleanupAtStartup(): void {
    this.endWaits(this.store.listByState(["queued"]), "failed", "Mandate restarted before it was delivered");
    this.failGone();
    const targets = new Set(this.store.listByState(AWAITING).flatMap((h) => (h.targetThreadId ? [h.targetThreadId] : [])));
    for (const threadId of targets) this.checkTarget(threadId);
  }

  /** Fails what is open toward a target that is gone. Archive paths with a
   *  hook fail theirs at once (failOpenForThread); this catches any other — a
   *  project archive — wherever handoffs are read, as
   *  retired-threads.ts checks at wake time rather than on every archive path. */
  private failGone(): void {
    // Together by reason, so the waits on one target end in one notice.
    const gone = new Map<string, HandoffRow[]>();
    for (const handoff of this.store.listByState(OPEN)) {
      const reason = this.goneReason(handoff);
      if (reason) gone.set(reason, [...(gone.get(reason) ?? []), handoff]);
    }
    for (const [reason, rows] of gone) this.endWaits(rows, "archived", reason);
  }

  private goneReason(handoff: HandoffRow): string | null {
    if (handoff.featureId) {
      const feature = this.deps.featuresStore.getById(handoff.featureId);
      if (!feature || feature.archivedAt) return "the worker was archived";
    }
    if (!handoff.targetThreadId) return null;
    const thread = this.deps.agentStore.getThreadById(handoff.targetThreadId);
    if (thread && !thread.archivedAt) return null;
    return "the thread was archived";
  }

  /** For the agent's runtime context: what it waits to hear from, oldest first. */
  listOpenForContext(globalThreadId: string): Array<{ target: string; since: string; sent: string | null }> {
    this.failGone();
    return this.store.listByState(OPEN).filter((h) => h.globalThreadId === globalThreadId).map((h) => {
      const dto = this.dtoOf(h);
      const target = h.kind === "feature" ? `worker ${dto.featureName ?? h.featureId}` : `thread ${dto.threadTitle ?? dto.newThreadTitle ?? "(new)"}`;
      return { target, since: h.createdAt, sent: h.text.trim() ? h.text : null };
    });
  }

  /** The handoffs a page shows, as they stand now (a target gone since is failed first). */
  byIds(globalThreadId: string, ids: readonly string[]): GlobalHandoffDto[] {
    this.failGone();
    return this.store.listByIds(globalThreadId, ids).map((h) => this.dtoOf(h));
  }

  dto(id: string): GlobalHandoffDto | null {
    const row = this.store.get(id);
    return row ? this.dtoOf(row) : null;
  }

  private dtoOf(row: HandoffRow): GlobalHandoffDto {
    const feature = row.featureId ? this.deps.featuresStore.getById(row.featureId) : null;
    const thread = row.targetThreadId ? this.deps.agentStore.getThreadById(row.targetThreadId) : null;
    return {
      id: row.id, kind: row.kind, state: row.state, text: row.text, spoken: row.spoken,
      featureId: row.featureId, featureName: feature?.name ?? null,
      ownerThreadTitle: feature?.ownerThreadId ? threadDisplayTitle(this.deps.agentStore, feature.ownerThreadId) : null,
      threadId: row.targetThreadId,
      threadTitle: thread?.scope === "manager" ? threadDisplayTitle(this.deps.agentStore, thread.id) : null,
      newThreadTitle: row.newThreadTitle, reply: row.reply, reason: row.reason, stop: row.stop,
      createdAt: row.createdAt, updatedAt: row.updatedAt, repliedAt: row.repliedAt
    };
  }

  private publish(id: string): GlobalHandoffDto {
    const dto = this.dto(id)!;
    this.deps.emit?.(dto);
    return dto;
  }

  private isOpenManagerThread(threadId: string): boolean {
    const thread = this.deps.agentStore.getThreadById(threadId);
    return Boolean(thread && thread.scope === "manager" && !thread.archivedAt);
  }
}

function latestText(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.content.type === "assistant" && m.content.text?.trim()) return m.content.text.trim();
  }
  return null;
}

function limit(text: string, max = REPLY_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
