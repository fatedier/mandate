import type { AgentStore } from "../../agent/agent-store.js";
import type { FeaturesStore } from "../../features/features-store.js";
import type { StopVerdict, ThreadStop } from "../../../../shared/thread-dot.js";
import type { CurrentVerdict } from "../../../../shared/api/thread-status.js";
import { logError } from "../../../platform/logger.js";
import { judgeChoice, type Judged, type JudgementCandidate, type JudgementChoice, type JudgementInput } from "../judge.js";
import type { ReplyJudgementSubjectDto } from "../../../../shared/api/activity.js";
import { renderJudgementContext, threadEventsExcept } from "../context.js";
import { STOP_OPTIONS, stopOutcomeFromDecision } from "./answer.js";
import type { ManagerStopCheckStore } from "./store.js";
import promptPath from "../prompts/manager-stop-check.md" with { type: "file" };

/** The manager stop check: what a stopped thread's latest reply leaves the user. */
export const MANAGER_STOP_CHOICE: JudgementChoice<StopVerdict> = {
  purpose: "manager_stop_check",
  promptPath,
  options: STOP_OPTIONS,
  fromDecision: stopOutcomeFromDecision
};

/** The verdict, or null when no model gave one (none set, or all failed). */
export function judgeManagerStop(
  candidates: readonly JudgementCandidate[],
  input: JudgementInput<ReplyJudgementSubjectDto>,
  opts: { timeoutMs?: number } = {}
): Promise<Judged<StopVerdict> | null> {
  return judgeChoice(candidates, input, MANAGER_STOP_CHOICE, opts);
}

const HEAD_LABEL = "Latest message to the thread from the user, or the agent acting for them";
/** A verdict's reply as Home's row shows it. */
const REPLY_TEXT_MAX = 600;
/** How many threads current() keeps what it read of before it drops the
 *  ones no longer open (archived or gone); open ones stay, every snapshot
 *  reads them. */
const KEPT_MAX = 1000;

interface Reply {
  seq: number;
  text: string;
  at: string;
}

/** What the judge reads: the latest message the user or Your agent sent to
 *  the thread, everything since (what came after the reply too: a turn that
 *  wrote no words leaves it latest), and the reply. A thread nobody wrote to
 *  is read from its start. */
export function managerStopCheckContext(agentStore: AgentStore, threadId: string, reply: Reply): string {
  const person = agentStore.latestPersonMessageBefore(threadId, Number.MAX_SAFE_INTEGER) ?? undefined;
  const personSeq = person?.seq ?? 0;
  const head = person
    ? { label: HEAD_LABEL, text: person.content.type === "text" ? person.content.text : "", at: person.createdAt }
    : null;
  return renderJudgementContext({
    head,
    events: threadEventsExcept(agentStore, threadId, person ? personSeq : 0, reply.seq),
    latest: { text: reply.text, at: reply.at }
  });
}

/** Judges a manager thread's latest reply once it has stopped (`stopped`:
 *  a failed or asking thread already shows red or yellow), once per reply,
 *  in the background, and keeps the verdict. A verdict is current while
 *  that reply is the latest, unread, and nothing from the user or Your agent
 *  came to the thread after it; whether the thread is still stopped is the
 *  reader's to add (the status snapshot reads its stop). */
export function createManagerStopCheck(deps: {
  agentStore: AgentStore;
  featuresStore: Pick<FeaturesStore, "getById">;
  store: ManagerStopCheckStore;
  stopOf: (threadId: string) => ThreadStop | null;
  /** The route's models now; none, the manager stop check is off. */
  candidates: () => JudgementCandidate[];
  judge?: (candidates: readonly JudgementCandidate[], input: JudgementInput<ReplyJudgementSubjectDto>) => Promise<Judged<StopVerdict> | null>;
  /** A verdict was stored: what was judged, and what was found. */
  onVerdict?: (threadId: string, verdict: { replySeq: number; outcome: StopVerdict }) => void;
  /** Whether the manager stop check is on and has a model now, read cheaply on every
   *  snapshot: off, a verdict stored while it was on does not show. Absent: on. */
  on?: () => boolean;
  now?: () => Date;
}) {
  const judge = deps.judge ?? ((candidates, input) => judgeManagerStop(candidates, input));
  const now = deps.now ?? (() => new Date());
  /** The judgement running for each thread, and the reply it is about. */
  const inFlight = new Map<string, { seq: number; promise: Promise<StopVerdict | null> }>();
  /** How many judgements of each thread are running, an older reply's
   *  included: each still writes its call's row. */
  const runningFor = new Map<string, number>();
  const running = new Set<Promise<unknown>>();
  /** What current() read of each thread's history, while nothing was added
   *  to it since: it runs on every status snapshot. */
  const replyFacts = new Map<string, { key: string; text: string | null }>();
  /** The size past which closed threads are dropped next. */
  let pruneAt = KEPT_MAX;

  /** The manager thread a settling thread speaks for: itself, or a worker's owner. */
  const managerOf = (threadId: string): string | null => {
    const thread = deps.agentStore.getThreadById(threadId);
    if (!thread || thread.archivedAt) return null;
    if (thread.scope === "manager") return thread.id;
    if (thread.scope !== "worker" || !thread.scopeId) return null;
    const owner = deps.featuresStore.getById(thread.scopeId)?.ownerThreadId ?? null;
    return owner && !deps.agentStore.getThreadById(owner)?.archivedAt ? owner : null;
  };

  /** The reply a manager stop check is about: the thread's latest, unless a message
   *  from the user or Your agent came after it (the matter was taken up). */
  const replyOf = (threadId: string): Reply | null => {
    const latest = deps.agentStore.latestReply(threadId);
    if (!latest || latest.content.type !== "assistant") return null;
    if (deps.agentStore.latestPersonMessageSeq(threadId) > latest.seq) return null;
    return { seq: latest.seq, text: latest.content.text ?? "", at: latest.createdAt };
  };

  const start = (threadId: string, reply: Reply, candidates: JudgementCandidate[]): Promise<StopVerdict | null> => {
    const judged = (async () => {
      const judged = await judge(candidates, {
        threadId,
        context: managerStopCheckContext(deps.agentStore, threadId, reply),
        subject: { replySeq: reply.seq, replyAt: reply.at }
      });
      if (!judged) return null;
      const outcome = judged.answer;
      // Archived or deleted meanwhile: nothing is kept for it.
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread || thread.archivedAt) {
        judged.notUsed("archived");
        return outcome;
      }
      // A later reply's verdict, stored meanwhile, is not replaced by this one.
      if ((deps.store.get(threadId)?.replySeq ?? -1) > reply.seq) {
        judged.notUsed("newer_verdict");
        return outcome;
      }
      deps.store.set(threadId, { replySeq: reply.seq, outcome, judgedAt: now().toISOString() });
      deps.onVerdict?.(threadId, { replySeq: reply.seq, outcome });
      return outcome;
    })();
    const promise: Promise<StopVerdict | null> = judged
      .catch((err) => {
        logError(`manager stop check for thread ${threadId}`, err);
        return null;
      })
      .finally(() => {
        if (inFlight.get(threadId)?.promise === promise) inFlight.delete(threadId);
        const left = (runningFor.get(threadId) ?? 1) - 1;
        if (left > 0) runningFor.set(threadId, left);
        else runningFor.delete(threadId);
        running.delete(promise);
      });
    inFlight.set(threadId, { seq: reply.seq, promise });
    runningFor.set(threadId, (runningFor.get(threadId) ?? 0) + 1);
    running.add(promise);
    return promise;
  };

  return {
    /** A thread's turn ended, or a wait in it was given up: its stop may have
     *  come. A worker's settles its owner's thread. */
    noteSettled(threadId: string): void {
      try {
        const manager = managerOf(threadId);
        if (!manager || deps.stopOf(manager) !== "stopped") return;
        const reply = replyOf(manager);
        if (!reply) return;
        if (deps.store.get(manager)?.replySeq === reply.seq || inFlight.get(manager)?.seq === reply.seq) return;
        const candidates = deps.candidates();
        if (candidates.length === 0) return;
        void start(manager, reply, candidates);
      } catch (err) {
        logError(`manager stop check for thread ${threadId}`, err);
      }
    },

    /** The verdict on the thread's latest reply, for a notice that may wait
     *  for it: at once when stored, else the judgement under way (started
     *  now if the thread has stopped), null once `waitMs` has passed. Null,
     *  and no promise, when there is nothing to judge. */
    verdictFor(threadId: string, waitMs: number): Promise<StopVerdict | null> | null {
      const manager = managerOf(threadId);
      if (!manager) return null;
      const candidates = deps.candidates();
      if (candidates.length === 0) return null;
      const reply = replyOf(manager);
      if (!reply) return null;
      const stored = deps.store.get(manager);
      if (stored?.replySeq === reply.seq) return Promise.resolve(stored.outcome);
      let promise = inFlight.get(manager)?.seq === reply.seq ? inFlight.get(manager)!.promise : null;
      if (!promise) {
        if (deps.stopOf(manager) !== "stopped") return null;
        promise = start(manager, reply, candidates);
      }
      const judged = promise;
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), waitMs);
        void judged.then((outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
      });
    },

    /** The verdict that shows now: a decision or a result on the thread's
     *  latest reply, unread, with nothing from the user or Your agent after
     *  it, on a thread not archived, while the manager stop check is on. */
    current(threadId: string): CurrentVerdict | null {
      if (deps.on && !deps.on()) return null;
      const stored = deps.store.get(threadId);
      if (!stored || stored.outcome === "nothing") return null;
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread || thread.archivedAt || thread.seenSeq >= stored.replySeq) return null;
      // Whether its reply is still the latest, with nothing from the user or
      // Your agent after it, changes only with a new row.
      const key = `${stored.replySeq}:${deps.agentStore.lastSeq(threadId)}`;
      let facts = replyFacts.get(threadId);
      if (facts?.key !== key) {
        const latest = deps.agentStore.latestReply(threadId);
        const stands = latest?.seq === stored.replySeq && latest.content.type === "assistant"
          && deps.agentStore.latestPersonMessageSeq(threadId) <= stored.replySeq;
        facts = { key, text: stands && latest.content.type === "assistant" ? (latest.content.text ?? "").slice(0, REPLY_TEXT_MAX) : null };
      }
      replyFacts.set(threadId, facts);
      if (replyFacts.size > pruneAt) {
        // Past the bound: the threads no longer open go; then the bound is
        // twice what is left, so open threads past it are not scanned again
        // on every read.
        for (const id of replyFacts.keys()) {
          const kept = deps.agentStore.getThreadById(id);
          if (!kept || kept.archivedAt) replyFacts.delete(id);
        }
        pruneAt = Math.max(KEPT_MAX, replyFacts.size * 2);
      }
      return facts.text === null ? null : { verdict: stored.outcome, replySeq: stored.replySeq, replyText: facts.text };
    },

    /** The thread is put away (archived, so soon perhaps deleted): what
     *  current() kept of it goes. */
    forget(threadId: string): void {
      replyFacts.delete(threadId);
    },

    /** How many threads current() keeps what it read of (tests). */
    kept(): number {
      return replyFacts.size;
    },

    /** A judgement of the thread is under way: it will still write (its call's
     *  row, its verdict), so a delete waits for it. */
    judging(threadId: string): boolean {
      return runningFor.has(threadId);
    },

    /** Resolves once no judgement is running (tests, shutdown). */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.allSettled([...running]);
    }
  };
}

export type ManagerStopCheck = ReturnType<typeof createManagerStopCheck>;
