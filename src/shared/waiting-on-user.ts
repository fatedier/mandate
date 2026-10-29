import { threadRests, type WaitKind } from "./thread-dot.js";
import { WAITING_ORDER } from "./status-words.js";
import type { WaitingEntryDto } from "./api/thread-status.js";

// What waits on the user, as one rule: Home's list and the count on what
// opens Home, the global agent's `waiting_on_you` and its context, voice and
// Your agent's page all read it. Pure; the server gives it the facts.

/** A manager thread as the attention rule reads it. */
export interface AttentionThread {
  id: string;
  title: string;
  running: boolean;
  /** What its manager is asleep on (leadWait), if anything. */
  watching: WaitKind | boolean | null;
  /** Its own turn failed ("error") or stopped short ("stopped"), and why. */
  failure: { kind: "error" | "stopped"; reason: string } | null;
  /** What its manager asked the user and they have not answered, oldest first. */
  questions: readonly string[];
  /** The manager stop check's verdict while it is current. */
  verdict: { kind: "decision" | "result"; replyText: string } | null;
}

/** A worker as the attention rule reads it: only its question can reach the
 *  user; the rest of its state is its manager's. */
export interface AttentionWorker {
  featureId: string;
  ownerThreadId: string | null;
  name: string;
  /** Its project, and its page there. */
  place: WaitingEntryDto["place"];
  /** Its plan holds a question, and `question` is the first of them. */
  asking: boolean;
  question: string | null;
  running: boolean;
  watching: WaitKind | boolean | null;
  stepInProgress?: boolean;
  /** What it would wait on the user for (waitingOnYou), for whether an alarm
   *  of its keeps its thread open. */
  waiting: "failed" | "stopped" | null;
}

/** Everything that waits on the user, most urgent first: a thread whose own
 *  turn failed or stopped; then a question put to them (by their own agent,
 *  by a thread's manager the moment it asks, or by a worker once nobody above
 *  it took the question up: its thread rests and its manager asked them
 *  nothing); then a stopped thread whose latest reply leaves them a
 *  decision, then one with a result to read. One order (WAITING_ORDER); each
 *  kind keeps the order it was given in. A worker's failure, stop or finished
 *  plan is its manager's, and is not here. */
export function attentionEntries(
  threads: readonly AttentionThread[],
  workers: readonly AttentionWorker[],
  agentQuestions: readonly string[] = []
): WaitingEntryDto[] {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const entries: WaitingEntryDto[] = [];
  const firstAndMore = ([first, ...more]: readonly string[]) => (more.length > 0 ? `${first} (+${more.length} more)` : first!);
  const entry = (fields: Omit<WaitingEntryDto, "key">): WaitingEntryDto => ({
    key: `${fields.kind}:${(fields.kind === "worker" ? fields.featureId : fields.threadId) ?? "agent"}:${fields.waiting}`, ...fields
  });
  for (const thread of threads) {
    if (!thread.failure) continue;
    entries.push(entry({
      kind: "thread", waiting: thread.failure.kind === "stopped" ? "stopped" : "failed",
      threadId: thread.id, threadTitle: thread.title, featureId: null, workerName: null, text: thread.failure.reason, place: null
    }));
  }
  if (agentQuestions.length > 0) {
    entries.push(entry({ kind: "agent", waiting: "input", threadId: null, threadTitle: null, featureId: null, workerName: null, text: firstAndMore(agentQuestions), place: null }));
  }
  for (const thread of threads) {
    if (thread.questions.length === 0) continue;
    entries.push(entry({ kind: "question", waiting: "input", threadId: thread.id, threadTitle: thread.title, featureId: null, workerName: null, text: firstAndMore(thread.questions), place: null }));
  }
  for (const worker of workers) {
    if (!worker.asking) continue;
    const thread = worker.ownerThreadId ? threadById.get(worker.ownerThreadId) : undefined;
    if (thread && thread.questions.length > 0) continue;
    const siblings = worker.ownerThreadId ? workers.filter((w) => w.ownerThreadId === worker.ownerThreadId) : [worker];
    if (!threadRests({ running: thread?.running ?? false, watching: thread?.watching ?? false }, siblings)) continue;
    entries.push(entry({
      kind: "worker", waiting: "input", threadId: worker.ownerThreadId, threadTitle: thread?.title ?? null,
      featureId: worker.featureId, workerName: worker.name, text: worker.question ?? "", place: worker.place
    }));
  }
  for (const thread of threads) {
    if (!thread.verdict) continue;
    entries.push(entry({
      kind: "thread", waiting: thread.verdict.kind, threadId: thread.id, threadTitle: thread.title, featureId: null, workerName: null, text: thread.verdict.replyText, place: null
    }));
  }
  return entries.sort((a, b) => WAITING_ORDER[a.waiting] - WAITING_ORDER[b.waiting]);
}
