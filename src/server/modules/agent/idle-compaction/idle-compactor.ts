import { logError } from "../../../platform/logger.js";
import type { StepPrompt } from "../wake-loop.js";
import type { WakeLlmCandidate } from "../wake-llm-attempts.js";
import { sealKeyOf, type SealStep } from "../cache-seal/cache-sealer.js";
import { systemFingerprint, toolSetFingerprint } from "../cache-seal/seal-request.js";
import { idleCacheLifetimeMinutes } from "./cache-lifetime.js";
import type { IdleCompactOptions, IdleCompactOutcome } from "./types.js";

const MINUTE = 60_000;

export interface IdleCompactorDeps {
  /** `agent.idleCompaction*`, read on every decision. */
  settings(): { enabled: boolean; leadMinutes: number; minTokens: number };
  now(): number;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  /** The cache lifetime typed for the model, in minutes; undefined, none. */
  typedLifetime(candidate: WakeLlmCandidate): number | undefined;
  /** The prompt the thread's next step would send now. */
  stepPromptFor(threadId: string): Promise<StepPrompt>;
  /** Exists, not archived, not a retired worker. */
  threadCompactable(threadId: string): boolean;
  /** Whether an alarm of the thread is due by then (ms since the epoch). */
  alarmDueBy(threadId: string, atMs: number): boolean;
  compact(threadId: string, opts: IdleCompactOptions): IdleCompactOutcome;
}

/** A seal that wrote the thread's cache for an hour, as the sealer tells it. */
export interface KeptBySeal {
  candidate: WakeLlmCandidate;
  /** When the seal's request started: the hour runs from there. */
  startedAt: number;
  systemFingerprint: string;
  toolsFingerprint: string;
}

interface Armed {
  timer: { cancel(): void };
  /** Who kept the cache: connection, model, effort, reasoning on or off. */
  key: string;
  keptAt: number;
  lifetimeMinutes: number;
  idleMinutes: number;
  systemFingerprint: string;
  toolsFingerprint: string;
}

/**
 * The idle clock. A call that kept a thread's
 * prompt cache arms it — a seal that wrote for an hour, a Claude step whose
 * marks asked for an hour and wrote for an hour, a step of another model
 * with a lifetime that read or wrote its cache — and it fires the model's
 * lifetime minus the lead after that call started. Any call of the thread
 * drops it. Firing, it gives up at the first thing that changed (the switch,
 * the thread, its leading model, system instruction or tools, an alarm due
 * before the cache expires) and otherwise asks for a compaction on the warm
 * model alone. Kept in memory: a restart arms nothing. What it keeps of a
 * thread lives only while a clock is being armed, waits or fires: a call of
 * the thread clears all of it, so nothing piles up for quiet threads.
 */
export class IdleCompactor {
  private readonly armed = new Map<string, Armed>();
  /** A step's clock while its tools are fingerprinted, and a clock while it
   *  fires: a call of the thread clears its token, which stops either. */
  private readonly arming = new Map<string, symbol>();
  private readonly firing = new Map<string, symbol>();
  private disposed = false;

  constructor(private readonly deps: IdleCompactorDeps) {}

  noteCallStarted(threadId: string): void {
    this.drop(threadId);
    this.arming.delete(threadId);
    this.firing.delete(threadId);
  }

  /** A wake step that answered: it arms the clock when it kept the cache. */
  noteStep(threadId: string, step: SealStep): void {
    const served = step.served;
    const first = step.prompt.candidates[0];
    // Only the step's leading model: a fallback's cache is not the next step's.
    if (!served || !first || sealKeyOf(served) !== sealKeyOf(first)) return;
    const kept = served.meta?.provider === "anthropic"
      ? step.prompt.cacheTtlFor?.(served) === "1h" && (step.cacheWrite1hTokens ?? 0) > 0
      : step.cacheReadTokens > 0 || (step.cacheWriteTokens ?? 0) > 0;
    if (!kept) return;
    const token = Symbol(threadId);
    this.arming.set(threadId, token);
    void toolSetFingerprint(step.prompt.tools).then((toolsFingerprint) => {
      // A call since the step drops it before it is armed.
      if (this.arming.get(threadId) !== token) return;
      this.arming.delete(threadId);
      this.arm(threadId, served, step.startedAt, systemFingerprint(step.prompt.system), toolsFingerprint);
    }).catch((err) => {
      if (this.arming.get(threadId) === token) this.arming.delete(threadId);
      logError("idle compaction", err, `arming ${threadId}`);
    });
  }

  /** A seal that wrote for an hour. */
  noteSeal(threadId: string, seal: KeptBySeal): void {
    this.arm(threadId, seal.candidate, seal.startedAt, seal.systemFingerprint, seal.toolsFingerprint);
  }

  dispose(): void {
    this.disposed = true;
    for (const armed of this.armed.values()) armed.timer.cancel();
    this.armed.clear();
    this.arming.clear();
    this.firing.clear();
  }

  private drop(threadId: string): void {
    this.armed.get(threadId)?.timer.cancel();
    this.armed.delete(threadId);
  }

  private arm(threadId: string, candidate: WakeLlmCandidate, keptAt: number, system: string, tools: string): void {
    if (this.disposed) return;
    const settings = this.deps.settings();
    if (!settings.enabled) return;
    const lifetimeMinutes = idleCacheLifetimeMinutes(candidate.meta, this.deps.typedLifetime(candidate));
    const idleMinutes = lifetimeMinutes - settings.leadMinutes;
    if (idleMinutes <= 0) return;
    const dueIn = keptAt + idleMinutes * MINUTE - this.deps.now();
    if (dueIn <= 0) return;
    this.drop(threadId);
    const armed: Armed = {
      timer: this.deps.setTimer(() => {
        if (this.armed.get(threadId) !== armed) return;
        this.armed.delete(threadId);
        const token = Symbol(threadId);
        this.firing.set(threadId, token);
        void this.fire(threadId, armed, token)
          .catch((err) => logError("idle compaction", err, `firing ${threadId}`))
          .finally(() => { if (this.firing.get(threadId) === token) this.firing.delete(threadId); });
      }, dueIn),
      key: sealKeyOf(candidate), keptAt, lifetimeMinutes, idleMinutes,
      systemFingerprint: system, toolsFingerprint: tools
    };
    this.armed.set(threadId, armed);
  }

  private async fire(threadId: string, armed: Armed, token: symbol): Promise<void> {
    const quiet = () => !this.disposed && this.firing.get(threadId) === token;
    if (!quiet()) return;
    const settings = this.deps.settings();
    if (!settings.enabled || !this.deps.threadCompactable(threadId)) return;
    const prompt = await this.deps.stepPromptFor(threadId);
    const leader = prompt.candidates[0];
    if (!quiet() || !leader || sealKeyOf(leader) !== armed.key) return;
    if (systemFingerprint(prompt.system) !== armed.systemFingerprint) return;
    if ((await toolSetFingerprint(prompt.tools)) !== armed.toolsFingerprint || !quiet()) return;
    // Asked again after the awaits, right before the compaction: the switch,
    // the thread, the model's lifetime (turned off since?), and whether the
    // cache is still alive (a timer can run late).
    const now = this.deps.settings();
    if (!now.enabled || !this.deps.threadCompactable(threadId)) return;
    const lifetimeNow = idleCacheLifetimeMinutes(leader.meta, this.deps.typedLifetime(leader));
    if (lifetimeNow <= now.leadMinutes) return;
    // A lifetime shortened since ends the cache sooner; a longer one does not
    // stretch the one already written.
    const expiresAt = armed.keptAt + Math.min(armed.lifetimeMinutes, lifetimeNow) * MINUTE;
    if (this.deps.now() >= expiresAt) return;
    // A wake due before the cache expires reads it warm itself.
    if (this.deps.alarmDueBy(threadId, expiresAt)) return;
    this.deps.compact(threadId, {
      only: (candidate) => sealKeyOf(candidate) === armed.key,
      minTokens: now.minTokens,
      idleMinutes: armed.idleMinutes
    });
  }
}
