import type { ModelMessage } from "ai";
import { logError } from "../../../platform/logger.js";
import type { IdleCompactor } from "../idle-compaction/idle-compactor.js";
import { candidateCallOptions, type WakeLlmCandidate } from "../wake-llm-attempts.js";
import type { StepPrompt } from "../wake-loop.js";
import { sealParticipates } from "./seal-family.js";
import type { CacheSealLedger, SealPause, SealTicket } from "./seal-ledger.js";
import { judgeNextStep, judgeSealWrite, sealFingerprint, sealMessages, systemFingerprint, toolSetFingerprint } from "./seal-request.js";

/** After the step's call started: its five-minute entries are still alive. */
export const SEAL_DELAY_MS = 270_000;
/** A call still running by then is not sealed: its entries are about to go. */
export const SEAL_LATEST_MS = 290_000;
/** How often what is kept of archived or deleted threads is swept. */
export const SEAL_SWEEP_MS = 3_600_000;

export interface SealSend {
  threadId: string;
  candidate: WakeLlmCandidate;
  system: StepPrompt["system"];
  tools: StepPrompt["tools"];
  messages: ModelMessage[];
}

export type SealResult =
  | { ok: true; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1h: number | undefined; finishedAt: number }
  | { ok: false; error: unknown };

export interface CacheSealerDeps {
  /** `agent.cacheSealEnabled`, read on every decision. */
  enabled(): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  /** The prompt the thread's next step would send now. */
  stepPromptFor(threadId: string): Promise<StepPrompt>;
  /** The thread still exists and is not archived. */
  threadSealable(threadId: string): boolean;
  /** The idle clock (idle compaction), told of every call of a thread, every
   *  wake step that answered, and every seal that wrote for an hour. */
  idle?: Pick<IdleCompactor, "noteCallStarted" | "noteStep" | "noteSeal">;
  sendSeal(send: SealSend): Promise<SealResult>;
  ledger: CacheSealLedger;
}

/** A wake step whose call did not answer (Stop, a failure): what it sent. */
export interface UnansweredStep {
  prompt: StepPrompt;
  startedAt: number;
}

/** When a waiting seal is due, for whom, and the last moment it may go. */
interface SealTiming {
  candidateKey: string;
  dueAt: number;
  deadline: number;
}

/** A wake step that succeeded, as the sealer needs it. */
export interface SealStep {
  prompt: StepPrompt;
  /** The candidate that answered; null when none could be told. */
  served: WakeLlmCandidate | null;
  startedAt: number;
  finishedAt: number;
  cacheReadTokens: number;
  /** What the step wrote to the cache, and of it for an hour (the idle
   *  clock reads them); missing, none. */
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
}

interface OpenSeal {
  candidateKey: string;
  ticket: SealTicket;
  fingerprint: string;
  /** The tools offered alone: a change there excuses the next step. */
  toolsFingerprint: string;
  /** The system instruction alone: a refresh excuses the next step. */
  systemFingerprint: string;
  sealedCount: number;
  sealedTokens: number;
  finishedAt: number;
  excused: boolean;
}

const connectionOf = (candidate: WakeLlmCandidate) => candidate.meta?.providerName ?? candidate.meta?.provider ?? "";
const modelOf = (candidate: WakeLlmCandidate) => candidate.meta?.model ?? "";
/** Who the seal is for: the connection, the model, its effort and whether it
 *  reasons at all (each changes the thinking options the request sends). */
export const sealKeyOf = (candidate: WakeLlmCandidate) =>
  `${connectionOf(candidate)}\0${modelOf(candidate)}\0${candidate.meta?.reasoningEffort ?? ""}\0${candidate.meta?.supportsReasoning === false ? "off" : "on"}`;

/** The call options a step and its seal send, without the model object. */
function callOptionsOf(candidate: WakeLlmCandidate, threadId: string) {
  const { model: _model, ...options } = candidateCallOptions(candidate, threadId, { askSummary: false });
  return options;
}

/**
 * Seals a quiet thread's cache. After a wake step whose
 * first candidate takes part, wrote its messages for five minutes and
 * answered, one seal is due 270 s after the step's call started; any other
 * call on the thread drops it. A step that did not answer sent its prompt all
 * the same: its thread is sealed when the seal its call dropped was due, or
 * 270 s after its own call when none was waiting. The seal is the
 * prompt the next step would send, cut after the reply and marked for an
 * hour; its own response is layer 1, the thread's next step layer 2. What
 * they find goes to the ledger, which pauses and resumes a model.
 */
export class CacheSealer {
  private readonly pending = new Map<string, { cancel(): void; timing: SealTiming }>();
  /** The seal a call dropped, until that call answers or does not. */
  private readonly dropped = new Map<string, SealTiming>();
  /** A seal being built, not yet sent: a call that starts drops it as it
   *  would a waiting one. */
  private readonly building = new Map<string, SealTiming>();
  private readonly open = new Map<string, OpenSeal>();
  /** The number of each thread's latest call, from one sequence that never
   *  goes back (a thread forgotten and called again gets a new one): a seal
   *  built or sent across a call is dropped. */
  private readonly calls = new Map<string, number>();
  private callSeq = 0;
  private disposed = false;
  private lastSweepAt: number;

  constructor(private readonly deps: CacheSealerDeps) {
    this.lastSweepAt = deps.now();
  }

  /** Whether this candidate's step writes its messages for five minutes. */
  shortMarksFor(candidate: WakeLlmCandidate): boolean {
    return this.deps.enabled() && sealParticipates(candidate) && this.deps.ledger.shortMarks(connectionOf(candidate), modelOf(candidate));
  }

  /** Whether a wake step's fallback writes its messages for five minutes:
   *  while sealing is on. It answers only when the leader fails, rarely twice
   *  in a row, so an hour there is paid for and not read; it is never sealed. */
  fallbackMarksShort(): boolean {
    return this.deps.enabled();
  }

  noteCallStarted(threadId: string): void {
    this.deps.idle?.noteCallStarted(threadId);
    this.calls.set(threadId, ++this.callSeq);
    const pending = this.pending.get(threadId);
    const timing = pending?.timing ?? this.building.get(threadId);
    pending?.cancel();
    this.pending.delete(threadId);
    this.building.delete(threadId);
    if (timing) this.dropped.set(threadId, timing);
    this.sweepIfDue();
  }

  /** At most once an hour, on a call of any thread: what is kept of a thread
   *  archived or deleted since goes, unless a seal of its is still waiting
   *  or being built. */
  private sweepIfDue(): void {
    const now = this.deps.now();
    if (now - this.lastSweepAt < SEAL_SWEEP_MS) return;
    this.lastSweepAt = now;
    for (const threadId of new Set([...this.calls.keys(), ...this.open.keys(), ...this.dropped.keys()])) {
      if (this.pending.has(threadId) || this.building.has(threadId) || this.deps.threadSealable(threadId)) continue;
      this.calls.delete(threadId);
      this.open.delete(threadId);
      this.dropped.delete(threadId);
    }
  }

  /** A compaction rewrote the thread: its next step is not judged, and a
   *  seal dropped before it seals a prompt no longer sent. */
  noteCompacted(threadId: string): void {
    this.dropped.delete(threadId);
    const open = this.open.get(threadId);
    if (open) open.excused = true;
  }

  /** A wake step whose call did not answer: its entries were written (or
   *  read) all the same, so the thread is sealed as after a step. The seal
   *  its call dropped, for the same model, keeps its time and deadline — the
   *  entries are alive till then even when the call never reached the
   *  provider. A step written for an hour (a paused model) added nothing to
   *  seal: a try of its model waits for a step that answers. */
  noteStepFailed(threadId: string, step: UnansweredStep): void {
    const dropped = this.dropped.get(threadId);
    this.dropped.delete(threadId);
    if (this.disposed || !this.deps.enabled()) return;
    const first = step.prompt.candidates[0];
    if (!first) return;
    if (dropped && dropped.candidateKey === sealKeyOf(first)) {
      this.arm(threadId, dropped);
      return;
    }
    if (!sealParticipates(first) || step.prompt.cacheTtlFor?.(first) !== "5m") return;
    this.arm(threadId, { candidateKey: sealKeyOf(first), dueAt: step.startedAt + SEAL_DELAY_MS, deadline: step.startedAt + SEAL_LATEST_MS });
  }

  /** A wake step whose work before its call failed (or was stopped): no
   *  call followed, so the seal its start dropped goes back as it was. */
  noteStepNotCalled(threadId: string): void {
    const dropped = this.dropped.get(threadId);
    this.dropped.delete(threadId);
    if (dropped && !this.disposed && this.deps.enabled()) this.arm(threadId, dropped);
  }

  /** Judges a seal before this step (layer 2), and schedules the next one. */
  noteStepSucceeded(threadId: string, step: SealStep): void {
    this.deps.idle?.noteStep(threadId, step);
    this.dropped.delete(threadId);
    const open = this.open.get(threadId);
    this.open.delete(threadId);
    this.schedule(threadId, step);
    if (open) void this.judgeNextStep(open, threadId, step).catch((err) => logError("cache seal", err, `judging the step after a seal of ${threadId}`));
  }

  pauses(): SealPause[] {
    return this.deps.ledger.pauses();
  }

  /** The runtime is going: every waiting seal is dropped and none is made. */
  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) pending.cancel();
    this.pending.clear();
    this.dropped.clear();
    this.building.clear();
  }

  /** Layer 2: the thread's step after a seal. */
  private async judgeNextStep(open: OpenSeal, threadId: string, step: SealStep): Promise<void> {
    const served = step.served;
    const first = step.prompt.candidates[0];
    // Not judged: a compaction since, a step its own first candidate did not
    // answer (a fallback, even one that is the sealed model), another model
    // or effort, other tools offered, or a refreshed system instruction.
    const excused = open.excused || !served || !first || sealKeyOf(served) !== sealKeyOf(first) || sealKeyOf(served) !== open.candidateKey
      || systemFingerprint(step.prompt.system) !== open.systemFingerprint
      || (await toolSetFingerprint(step.prompt.tools)) !== open.toolsFingerprint;
    const stepFingerprint = excused || !served ? "" : await sealFingerprint({
      system: step.prompt.system,
      tools: step.prompt.tools,
      callOptions: callOptionsOf(served, threadId),
      messages: step.prompt.messagesFor(served),
      count: open.sealedCount
    });
    const outcome = judgeNextStep({
      sealedFingerprint: open.fingerprint,
      stepFingerprint,
      excused,
      gapMs: step.startedAt - open.finishedAt,
      sealedTokens: open.sealedTokens,
      cacheReadTokens: step.cacheReadTokens
    });
    this.deps.ledger.layer2(open.ticket, outcome);
  }

  private schedule(threadId: string, step: SealStep): void {
    if (this.disposed || !this.deps.enabled()) return;
    const first = step.prompt.candidates[0];
    if (!first || !step.served || sealKeyOf(step.served) !== sealKeyOf(first) || !sealParticipates(first)) return;
    if (!this.needsSeal(step.prompt, first)) return;
    if (step.finishedAt - step.startedAt > SEAL_LATEST_MS) return;
    // Past the deadline the step's five-minute entries are about to go: a
    // seal then would rewrite the prompt at the hour's price (a late timer).
    this.arm(threadId, { candidateKey: sealKeyOf(first), dueAt: step.startedAt + SEAL_DELAY_MS, deadline: step.startedAt + SEAL_LATEST_MS });
  }

  /** Whether the step's first candidate wrote its messages for five minutes
   *  — or its model is paused and a try is due (its steps write for an hour;
   *  the try is what tells whether sealing works again). A step marked for an
   *  hour otherwise (its primary left out for the images) needs no seal. */
  private needsSeal(prompt: StepPrompt, first: WakeLlmCandidate): boolean {
    if (prompt.cacheTtlFor?.(first) === "5m") return true;
    const [connection, model] = [connectionOf(first), modelOf(first)];
    return !this.deps.ledger.shortMarks(connection, model) && this.deps.ledger.sealAllowed(connection, model);
  }

  private arm(threadId: string, timing: SealTiming): void {
    this.pending.get(threadId)?.cancel();
    const callsAtStep = this.calls.get(threadId) ?? 0;
    const dueIn = Math.max(0, timing.dueAt - this.deps.now());
    const timer = this.deps.setTimer(() => {
      this.pending.delete(threadId);
      // Each build its own: one that gives up never clears the next one's.
      const build: SealTiming = { ...timing };
      this.building.set(threadId, build);
      void this.seal(threadId, build, callsAtStep)
        .catch((err) => logError("cache seal", err, `sealing ${threadId}`))
        .finally(() => this.doneBuilding(threadId, build));
    }, dueIn);
    this.pending.set(threadId, { cancel: () => timer.cancel(), timing });
  }

  private doneBuilding(threadId: string, timing: SealTiming): void {
    if (this.building.get(threadId) === timing) this.building.delete(threadId);
  }

  private async seal(threadId: string, timing: SealTiming, callsAtStep: number): Promise<void> {
    const { candidateKey, deadline } = timing;
    const stillQuiet = () => !this.disposed && (this.calls.get(threadId) ?? 0) === callsAtStep;
    const inTime = () => this.deps.now() <= deadline;
    if (!stillQuiet() || !inTime() || !this.deps.enabled() || !this.deps.threadSealable(threadId)) return;
    const prompt = await this.deps.stepPromptFor(threadId);
    const candidate = prompt.candidates[0];
    if (!candidate || sealKeyOf(candidate) !== candidateKey || !sealParticipates(candidate)) return;
    if (!this.deps.ledger.sealAllowed(connectionOf(candidate), modelOf(candidate))) return;
    const sealed = sealMessages(prompt.messagesFor(candidate));
    if (!sealed) return;
    const fingerprint = await sealFingerprint({
      system: prompt.system,
      tools: prompt.tools,
      callOptions: callOptionsOf(candidate, threadId),
      messages: sealed.messages,
      count: sealed.sealedCount
    });
    const toolsFingerprint = await toolSetFingerprint(prompt.tools);
    // Asked again after the awaits: a call, the switch or an archive since.
    if (!stillQuiet() || !inTime() || !this.deps.enabled() || !this.deps.threadSealable(threadId)) return;
    // Sent from here: a call that starts now comes after the seal.
    this.doneBuilding(threadId, timing);
    const ticket = this.deps.ledger.startSeal(connectionOf(candidate), modelOf(candidate));
    if (!ticket) return;
    let result: SealResult;
    // The hour a seal writes runs from its request's start.
    const sentAt = this.deps.now();
    try {
      result = await this.deps.sendSeal({ threadId, candidate, system: prompt.system, tools: prompt.tools, messages: sealed.messages });
    } catch (error) {
      result = { ok: false, error };
    }
    if (!result.ok) {
      logError("cache seal", result.error, `the seal of ${threadId} failed`);
      this.deps.ledger.sendFailed(ticket);
      return;
    }
    this.deps.ledger.sendSucceeded(ticket);
    const outcome = judgeSealWrite(result);
    this.deps.ledger.layer1(ticket, outcome, result.outputTokens);
    // A step or a compaction while the seal was out came after it but is not
    // the step it is judged by: no record, so no later step judges it.
    if ((outcome === "pass" || outcome === "neutral") && stillQuiet()) {
      this.open.set(threadId, {
        candidateKey, ticket, fingerprint, toolsFingerprint,
        systemFingerprint: systemFingerprint(prompt.system),
        sealedCount: sealed.sealedCount,
        sealedTokens: result.cacheReadTokens + result.cacheWriteTokens,
        finishedAt: result.finishedAt,
        excused: false
      });
    }
    if (outcome === "pass" && stillQuiet()) {
      this.deps.idle?.noteSeal(threadId, { candidate, startedAt: sentAt, systemFingerprint: systemFingerprint(prompt.system), toolsFingerprint });
    }
  }
}
