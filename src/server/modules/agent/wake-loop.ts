import {
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type TimeoutConfiguration,
  type ToolSet
} from "ai";
import type {
  AgentMessage, AgentScope, AgentStore, AgentThread, AgentWakeReason,
  AssistantContent
} from "./agent-store.js";
import type { AgentWakeMetadata } from "../../../shared/api-contracts.js";
import type {
  ModelInputType,
  WakeFailureContent
} from "../../../shared/agent-message-types.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { ModelRefDto } from "../../../shared/api/agents.js";
import type { WakeLock } from "./wake-lock.js";
import { RepeatFailureTracker, REPEAT_NUDGE_TEXT, repeatStopText } from "./repeat-failures.js";
import { OUTPUT_LIMIT_CALL_NOT_RUN, OUTPUT_LIMIT_RETRIES, OUTPUT_LIMIT_STOPPED, outputLimitNote } from "./output-limit.js";
import { WakeLlmAttempts, type WakeLlmCandidate } from "./wake-llm-attempts.js";
import { WakeCanceledError } from "./wake-canceled-error.js";
import { ReleaseFollowUps } from "./wake-follow-ups.js";
import { WakeRuntimeContext } from "./wake-runtime-context.js";
import type { AgentLlmCallRecorder } from "../activity/llm-call-recorder.js";
import type { AgentScope as AgentToolScope } from "./tool-scope.js";
import { TOOL_CALL_STOPPED, type ToolContext } from "./tool-registry.js";
import { AGENT_WAKE_STEP_LLM_TIMEOUT, LLM_STREAM_IDLE_TIMEOUT_MS } from "../llm/timeouts.js";
import { withImageHint } from "./wake-failure-hint.js";
import { replayTargetFor, withCacheMarksFor } from "./replay-target.js";
import { prepareAiSdkMessages } from "./wake-message-adapter.js";
import { positiveNumberOrNull } from "../../../shared/positive-number.js";
import { withoutTrailingReasoning } from "./reasoning-replay.js";
import { ANTHROPIC_CACHE_CONTROL, type AnthropicCacheTtl } from "../llm/anthropic-cache.js";
import { extractUsage } from "../activity/llm-call-logging.js";
import type { CacheSealer } from "./cache-seal/cache-sealer.js";
import { withPendingToolResults } from "./cache-seal/pending-results.js";
import { toUserFacingError } from "../../platform/errors.js";
import { logError } from "../../platform/logger.js";
import { localTimeZone } from "../../platform/time/agent-time.js";
import { modelImages, type FittedImages, type ModelImageFitter } from "./model-images.js";

export interface ToolCallSpec {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface ToolDispatchResult {
  result?: unknown;
  isError?: boolean;
  error?: string;
}

export interface ToolDispatcher {
  registry: { tools: ToolSet };
  dispatch(call: ToolCallSpec, ctx: ToolContext): Promise<ToolDispatchResult>;
}

interface SseEmitter {
  emit(event: string, data: unknown): void;
  /** Optional so a test double may omit it; the real emitter coalesces deltas
   *  and needs the end of the stream announced. */
  flushMessageDelta?(threadId: string, wakeId: string): void;
}

interface WakeSchedulerDeps {
  agentStore: AgentStore;
  /** Makes the images a step sends small enough for a model; the process's
   *  one unless a test gives its own. */
  modelImages?: ModelImageFitter;
  /** Resolves after the server's initial terminal-state refresh. */
  ready?: Promise<void>;
  lock: WakeLock;
  /** The repeat stop's streaks: the same tool failing the same way.
   *  One per scheduler; a test may share one. */
  repeatFailures?: RepeatFailureTracker;
  buildSystemPrompt: (threadId: string) => string | Promise<string>;
  buildInitialContext?: (threadId: string) => string | null | Promise<string | null>;
  /** What still runs in the background, for a first context only: after a
   *  compaction the conversation is told once (later wakes do not repeat it). */
  buildTasksContext?: (threadId: string) => string | null | Promise<string | null>;
  buildRuntimeContext?: (threadId: string) => string | null | Promise<string | null>;
  /** Whether a thread's digest updates go as the changes since its window's
   *  last full digest (WakeRuntimeContext). */
  contextChangesOnly?: (threadId: string) => boolean;
  /** The zone the times in a step's prompt are written in (each incoming
   *  message's arrival, a late tool result's finish). Unset: the machine's. */
  timeZone?: string;
  toolDispatcherForThread: (threadId: string) => ToolDispatcher;
  llmModel: LanguageModel;
  llmForThread?: (threadId: string) => {
    model: LanguageModel;
    llmCallRecorder?: AgentLlmCallRecorder;
    candidates?: WakeLlmCandidate[];
  };
  supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
  supportsToolResultImagesForThread?: (threadId: string) => boolean;
  contextBudgetTokens?: number | (() => number);
  /** Total/chunk timeout passed to the AI SDK streamText call. Defaults to the agent wake timeout. */
  llmTimeout?: TimeoutConfiguration<ToolSet> | (() => TimeoutConfiguration<ToolSet>);
  /** Mandate-level idle timeout for stream activity. Any non-terminal stream
   *  event refreshes it; the total LLM timeout remains the hard cap. */
  streamIdleTimeoutMs?: number | (() => number);
  sse: SseEmitter;
  /** Called after the wake lock is acquired and before the first LLM step.
   *  Used for scope-specific wake setup such as mailbox draining. */
  preWakeHook?: (threadId: string, info: PreWakeInfo) => void | Promise<void>;
  /** Called before every LLM step. Used for pending inter-agent mailbox
   *  input that arrives while the wake is already running. */
  preStepHook?: (threadId: string, info: PreStepInfo) => void | Promise<void>;
  /** Called after queued input/runtime context are appended but before each
   *  LLM request is built. Used for context compression gates. If it changes
   *  prompt history, return historyChanged so runtime context can be rebuilt. */
  beforeModelCallHook?: (
    threadId: string,
    info: BeforeModelCallInfo
  ) => void | BeforeModelCallResult | Promise<void | BeforeModelCallResult>;
  /** Called fire-and-forget after the wake completes (success / error / limit). */
  postWakeHook?: (threadId: string, info: PostWakeInfo) => void | Promise<void>;
  /** Called after the in-memory wake lock is released. Used to flush queued user messages. */
  afterWakeReleasedHook?: (threadId: string) => void | Promise<void>;
  /** The waits before each new try of a release follow-up that failed (a
   *  write the database refused): RELEASE_RETRY_DELAYS_MS; a test passes
   *  short ones, or none. */
  releaseRetryDelaysMs?: readonly number[];
  /** A follow-up given up after its last try: what queued waits for the
   *  thread's next wake. Not called for a try that fails with tries left. */
  onFollowUpAbandoned?: (threadId: string) => void;
  /** Build an AgentScope object passed to tool handlers via `ctx.scope`. */
  buildToolScope: (threadId: string) => AgentToolScope;
  /** The waits before each new try at ending a wake whose end the database
   *  refused (WAKE_END_RETRY_DELAYS_MS); a test passes short ones. */
  wakeEndRetryDelaysMs?: readonly number[];
  /** True for a conversation nothing should wake on its own any more (its
   *  feature is archived). Only a wake a person asked for gets through. */
  isThreadRetired?: (threadId: string) => boolean;
  /** Called when a non-user wake of a retired thread was refused, to clear
   *  whatever would try again. */
  onRetiredWakeRefused?: (threadId: string, reason: AgentWakeReason) => void;
  /** Optional recorder for the llm_calls table. When omitted (or its
   *  logRequests is "off"), no Activity rows are written for wakes. */
  llmCallRecorder?: AgentLlmCallRecorder;
  /** How a thread's wake steps are filed for Activity when not as
   *  agent_wake_step: a subagent's, under subagent_step (a page
   *  subagent's under page_subagent_step) with the conversation it works
   *  for. Null or absent: agent_wake_step. */
  stepRecordingForThread?: (threadId: string) => { purpose: string; metadata: Record<string, unknown> } | null;
  /** The cache seal: the lifetime a wake step's message
   *  marks take, and the calls and answered steps that schedule or drop a
   *  seal. Absent: hour-long marks, nothing sealed. */
  cacheSeal?: Pick<CacheSealer, "shortMarksFor" | "fallbackMarksShort" | "noteCallStarted" | "noteStepSucceeded" | "noteStepFailed" | "noteStepNotCalled">;
}




export type { WakeLlmCandidate } from "./wake-llm-attempts.js";

export interface PostWakeInfo {
  wakeId: string;
  status: "finished" | "stuck" | "error" | "canceled";
}

interface PreWakeInfo {
  wakeId: string;
  reason: AgentWakeReason;
  triggerMessageId: string | null;
}

export interface BeforeModelCallInfo {
  wakeId: string;
  reason: AgentWakeReason;
  triggerMessageId: string | null;
}

interface BeforeModelCallResult {
  historyChanged?: boolean;
}

/** The prompt a thread's next step sends, as the step builds it: its tools,
 *  its system instruction (with the cache mark), the candidates that can take
 *  it, and each candidate's history (with its provider state and cache marks). */
export interface StepPrompt {
  tools: ToolSet;
  systemContent: string;
  system: string | SystemModelMessage;
  candidates: WakeLlmCandidate[];
  messagesFor: (candidate: WakeLlmCandidate) => ModelMessage[];
  /** What the first candidate is sent: the request logged. */
  messages: ModelMessage[];
  promptMaxSeq: number;
  /** The lifetime a candidate's message marks take (an Anthropic one's). */
  cacheTtlFor?: (candidate: WakeLlmCandidate) => AnthropicCacheTtl;
}

type ThreadLlm = NonNullable<ReturnType<NonNullable<WakeSchedulerDeps["llmForThread"]>>>;

interface PreStepInfo {
  wakeId: string;
}


type WakeContextUsage = {
  inputTokens: number | null;
  budgetTokens: number;
  updatedAt: string | null;
  source: "compression_budget";
} | null;

/** Thread scope info folded into wake SSE payloads so clients can map wake
 *  activity onto feature cards without a per-event thread lookup. */
interface WakeScopeInfo {
  scope: AgentScope;
  scopeId: string | null;
}

/** One wake's fixed facts, from its start to its end. */
interface WakeRun {
  threadId: string;
  wakeId: string;
  reason: AgentWakeReason;
  triggerMessageId: string | null;
  signal: AbortSignal;
  scopeInfo: WakeScopeInfo | null;
  wakeMetadata: AgentWakeMetadata | null;
}

/** The input tokens a wake's steps reported: the latest and the largest. */
interface WakeTokens {
  last: number | null;
  max: number | null;
}

/** One step's end: whether the turn is done, the repeat stop, and whether
 *  its reply stopped at the output token limit (cut) and that ends the turn
 *  (cutOff). */
interface RanStep {
  done: boolean;
  inputTokens: number | null;
  stuck: string | null;
  cut?: boolean;
  cutOff?: boolean;
}

/** How a turn's steps ended. */
interface RanSteps {
  stepCount: number;
  stuck: string | null;
  cutOff: boolean;
}

/** The conversations a repeated failing call stops for one turn
 *  only: the global agent's and a manager's. Each follows
 *  other agents' work, and stopped for good it was a dead end: the global
 *  agent heard of no thread it followed and kept none of the times it had set,
 *  and a manager's workers reported to nobody. What happens next wakes them as
 *  it would have. The streak is kept, so the same call made again ends that
 *  turn at once; a turn that first does something that works starts a new one.
 *  A worker waits for someone above it, a person or its manager (heldByStop):
 *  its own alarms and watches made the loops that were seen (a stopped
 *  worker was woken again by its own watch within the minute). */
const STUCK_ENDS_THE_TURN: ReadonlySet<AgentScope> = new Set<AgentScope>(["global", "manager"]);

/** An outside writer (an agent running sqlite3 on Mandate's database) can
 *  hold it past the busy timeout just as a wake ends. Ending is tried again
 *  after each of these waits, five tries over about 7.5 s of waits. */
const WAKE_END_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000];

export class WakeScheduler {
  private readonly running = new Map<string, {
    threadId: string;
    controller: AbortController;
    reason: AgentWakeReason;
    triggerMessageId: string | null;
    /** A person's message started it, or reached it between steps: it
     *  answers them. */
    answersPerson: boolean;
    /** The model its current call runs on, once one started. */
    model?: ModelRefDto;
  }>();
  private readonly runtimeContext: WakeRuntimeContext;
  private readonly repeatFailures: RepeatFailureTracker;
  /** Per running wake: the model whose request failed last in the current
   *  step, when that request carried image input — the failure hint names it. */
  private readonly imagePromptByWake = new Map<string, string>();
  /** The newest person message each running wake has seen (notePersonMessages). */
  private readonly personSeqByWake = new Map<string, number>();

  private readonly llmAttempts: WakeLlmAttempts;
  private readonly followUps: ReleaseFollowUps;

  constructor(private deps: WakeSchedulerDeps) {
    this.repeatFailures = deps.repeatFailures ?? new RepeatFailureTracker();
    this.llmAttempts = new WakeLlmAttempts({
      sse: deps.sse,
      llmTimeout: () => this.llmTimeout(),
      streamIdleTimeoutMs: () => this.streamIdleTimeoutMs()
    });
    this.followUps = new ReleaseFollowUps(deps, (threadId) => this.isThreadBusy(threadId));
    this.runtimeContext = new WakeRuntimeContext(deps);
  }

  /** Synchronously creates the wake row and kicks off the async loop.
   *  Returns the wakeId so callers (e.g. voice agent) can correlate later
   *  agentWakeFinished events. Returns null if a wake is already in flight for
   *  this thread (lock contention). */
  wake(
    threadId: string,
    reason: AgentWakeReason,
    triggerMessageId: string | null,
    metadata: AgentWakeMetadata | null = null
  ): string | null {
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (!thread || thread.archivedAt) return null;
    if (this.deps.isThreadRetired?.(threadId) && !this.isPersonInitiatedWake(reason, triggerMessageId)) {
      this.deps.onRetiredWakeRefused?.(threadId, reason);
      return null;
    }
    const personInitiated = this.isPersonInitiatedWake(reason, triggerMessageId);
    // A stopped worker is not woken by the alarms and watches it set (what
    // they wrote stays in the conversation and is read when it goes on).
    if (!personInitiated && this.heldByStop(thread)) return null;
    if (personInitiated) this.repeatFailures.reset(threadId);
    const release = this.deps.lock.tryAcquire(threadId);
    if (!release) return null;
    let wake: ReturnType<AgentStore["createWake"]>;
    try {
      wake = this.deps.agentStore.createWake({ threadId, reason, triggerMessageId, metadata });
    } catch (err) {
      // No row, no wake: kept, the thread would read busy with nothing that
      // ends it, and Stop goes by a wake's row.
      release();
      throw err;
    }
    reason = wake.reason;
    triggerMessageId = wake.triggerMessageId;
    metadata = wake.metadata ?? null;
    const controller = new AbortController();
    this.running.set(wake.id, { threadId, controller, reason, triggerMessageId, answersPerson: this.isPersonInitiatedWake(reason, triggerMessageId) });
    this.runtimeContext.begin(wake.id);
    this.personSeqByWake.set(wake.id, this.deps.agentStore.latestPersonMessageSeq(threadId));
    const scopeInfo = this.threadScopeInfo(threadId);
    this.deps.sse.emit(SSE_EVENTS.agentWakeStarted, {
      threadId, wakeId: wake.id, reason, triggerMessageId, metadata, startedAt: wake.startedAt, ...(scopeInfo ?? {})
    });
    void this.runWakeBody({
      threadId,
      wakeId: wake.id,
      reason,
      triggerMessageId,
      signal: controller.signal,
      scopeInfo,
      wakeMetadata: metadata
    }, release);
    return wake.id;
  }

  /** A turn that ended in an error or was stopped leaves a row in its
   *  thread where it stopped, sent before the wake's end so the page has it
   *  when the thread goes idle. Role "system": for people only. */
  private appendFailureRow(threadId: string, wakeId: string, failure: Omit<WakeFailureContent, "type">): void {
    const message = this.deps.agentStore.appendMessage({
      threadId, role: "system", source: "wake-failure", wakeId,
      content: { type: "wake_failure", ...failure }
    });
    this.deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message });
  }

  /** Ends a wake: its row, the failure row a stop or an error leaves in the
   *  transcript, and the agentWakeFinished event. The event carries the step
   *  count where the loop counted steps, the reason on any ending but a clean
   *  finish, and the user-facing error on an error. */
  private endWake(end: {
    threadId: string;
    wakeId: string;
    status: "finished" | "stuck" | "error" | "canceled";
    errorMessage?: string;
    stepCount?: number;
    failure?: Omit<WakeFailureContent, "type">;
    error?: unknown;
    contextUsage: WakeContextUsage;
    scopeInfo: WakeScopeInfo | null;
  }): void {
    this.deps.agentStore.finishWake(end.wakeId, end.status, end.errorMessage ?? null);
    if (end.failure) this.appendFailureRow(end.threadId, end.wakeId, end.failure);
    this.deps.sse.emit(SSE_EVENTS.agentWakeFinished, {
      threadId: end.threadId,
      wakeId: end.wakeId,
      status: end.status,
      ...(end.stepCount === undefined ? {} : { stepCount: end.stepCount }),
      ...(end.errorMessage === undefined ? {} : { errorMessage: end.errorMessage }),
      ...(end.error === undefined ? {} : { error: end.error }),
      contextUsage: end.contextUsage,
      ...(end.scopeInfo ?? {})
    });
  }

  cancelWake(wakeId: string): { ok: boolean; wakeId: string; status: "running" | "canceled" | "finished" | "stuck" | "error"; message?: string } {
    const wake = this.deps.agentStore.getWakeById(wakeId);
    if (!wake) return { ok: false, wakeId, status: "error", message: "wake not found" };
    if (wake.status !== "running") {
      return { ok: false, wakeId, status: wake.status, message: `wake is already ${wake.status}` };
    }
    this.deps.agentStore.requestWakeCancellation(wakeId);
    const running = this.running.get(wakeId);
    if (!running) {
      this.endWake({
        threadId: wake.threadId, wakeId, status: "canceled", errorMessage: "Stopped by user.",
        contextUsage: null, scopeInfo: this.threadScopeInfo(wake.threadId)
      });
      return { ok: true, wakeId, status: "canceled" };
    }
    running.controller.abort(new WakeCanceledError());
    return { ok: true, wakeId, status: "running" };
  }

  /** Returns the running wake row for a thread, or null. Used by dispatchers
   *  and queues to detect in-flight feature/overview wakes. */
  /** The thread's running turn answers a person: their message started it,
   *  or reached it between steps. */
  isAnsweringPerson(threadId: string): boolean {
    for (const run of this.running.values()) if (run.threadId === threadId && run.answersPerson) return true;
    return false;
  }

  /** The model a thread's running turn calls now; null when none runs, or
   *  its first call has not started. */
  modelInFlight(threadId: string): ModelRefDto | null {
    for (const run of this.running.values()) if (run.threadId === threadId && run.model) return run.model;
    return null;
  }

  private noteModelInFlight(threadId: string, wakeId: string, candidate: WakeLlmCandidate): void {
    const run = this.running.get(wakeId);
    const providerName = candidate.meta?.providerName;
    const model = candidate.meta?.model;
    if (!run || !providerName || !model) return;
    const ref = `${providerName}/${model}`;
    if (run.model?.ref === ref) return;
    run.model = { ref, providerName, model };
    this.deps.sse.emit(SSE_EVENTS.agentWakeModel, { threadId, wakeId, model: run.model });
  }

  getRunningWakeForThread(threadId: string): { id: string; reason: AgentWakeReason; startedAt: string } | null {
    const r = this.deps.agentStore.getRunningWakeForThread(threadId);
    return r ? { id: r.id, reason: r.reason, startedAt: r.startedAt } : null;
  }

  /** True while the in-memory wake lock is held. This catches active LLM/tool
   *  work even before the wake row is visible to DB readers. */
  isThreadBusy(threadId: string): boolean {
    return this.deps.lock.isHeld(threadId);
  }

  /** Holds a thread as a wake does, for work that must not run beside a turn
   *  and that no turn carries (a compaction started by hand). Null when the
   *  thread is busy. The function returned releases it and starts what queued
   *  behind, as a wake's end does; calling it again does nothing. */
  holdThread(threadId: string): (() => void) | null {
    const release = this.deps.lock.tryAcquire(threadId);
    if (!release) return null;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      release();
      this.followUps.run(threadId, `agent thread ${threadId}`);
    };
  }

  /** The prompt the thread's next step would send now, for a call that wants
   *  the step's prompt cache (a compaction). Throws when no candidate can
   *  take it, as the step does. */
  async stepPromptFor(threadId: string, opts: { pendingResults?: boolean } = {}): Promise<StepPrompt> {
    const stored = this.deps.agentStore.getActiveMessages(threadId);
    // A seal's prompt keeps a reply whose tools still run whole, as the next
    // step will send it (placeholders past the seal's mark, never stored).
    const active = opts.pendingResults ? withPendingToolResults(stored) : stored;
    const fitted = await this.images().prepare(active);
    // Hour-long marks: a compaction reads the step's cache, and a seal takes
    // the marks off.
    return this.stepPrompt(threadId, this.deps.toolDispatcherForThread(threadId), this.threadLlm(threadId), active, fitted, { stepMarks: false });
  }

  private threadLlm(threadId: string): ThreadLlm {
    return this.deps.llmForThread?.(threadId) ?? {
      model: this.deps.llmModel,
      llmCallRecorder: this.deps.llmCallRecorder
    };
  }

  /** Done with this scheduler (the server stopping): the follow-ups waiting to
   *  be tried again are dropped, and none is asked for after. What queued
   *  waits in the database for the next start, as it does for a follow-up
   *  given up. */
  dispose(): void {
    this.followUps.dispose();
  }

  /** A delivery outside a release (a watch or monitor firing on an idle
   *  thread) the database refused: no release comes to start what it left
   *  queued, so the thread's follow-up is tried again, as a refused
   *  release's is. */
  retryFollowUp(threadId: string, who: string, err: unknown): void {
    this.followUps.retry(threadId, who, err);
  }

  /** A retry of the thread's follow-up waits: what queued behind it (or was
   *  refused outside a release) is about to be started. */
  hasFollowUpDue(threadId: string): boolean {
    return this.followUps.isDue(threadId);
  }

  /** A wake for mail just put in a thread's mailbox, by a sender outside the
   *  thread's release (a report, a notice, a reply). Refused (a write the
   *  database refused), the mail waits there and the thread's follow-up,
   *  which wakes for it, is tried again (retryFollowUp): null, as for a
   *  thread busy now. Never from inside the thread's own follow-up, whose
   *  tries it would start over. */
  wakeForMail(threadId: string, reason: AgentWakeReason): string | null {
    try {
      return this.wake(threadId, reason, null);
    } catch (err) {
      this.retryFollowUp(threadId, `${reason} mail for ${threadId}`, err);
      return null;
    }
  }

  /** Resolved once per wake (not per emit) and threaded through runWakeBody
   *  so every started/finished emission carries the same scope info. The
   *  lookup sits between lock acquisition and the wake body — it must never
   *  throw, or the lock would leak; scope info is display-only, so a failed
   *  read degrades to omitting the optional fields. */
  private threadScopeInfo(threadId: string): WakeScopeInfo | null {
    try {
      const thread = this.deps.agentStore.getThreadById(threadId);
      return thread ? { scope: thread.scope, scopeId: thread.scopeId } : null;
    } catch {
      return null;
    }
  }

  private async runWakeBody(run: WakeRun, release: () => void): Promise<void> {
    const { threadId, wakeId, signal } = run;
    const tokens: WakeTokens = { last: null, max: null };
    try {
      if (this.deps.ready) await this.deps.ready;
      throwIfCanceled(signal);
      const thread = this.deps.agentStore.getThreadById(threadId);
      if (!thread || thread.archivedAt) throw new WakeCanceledError();
      if (this.deps.preWakeHook) {
        await this.deps.preWakeHook(threadId, {
          wakeId,
          reason: run.reason,
          triggerMessageId: run.triggerMessageId
        });
      }
      throwIfCanceled(signal);
      const outcome = await this.runSteps(run, tokens);
      await this.endWithRetries(run, () => this.endRanWake(run, outcome));
    } catch (err) {
      await this.endWithRetries(run, () => this.endFailedWake(run, err));
    } finally {
      this.releaseWake(threadId, wakeId, release);
    }
  }

  /** Ends a wake, trying again while the database refuses the write. One it
   *  still cannot end is logged, never thrown: thrown, it left the row
   *  running with nothing to end it, as an unhandled rejection. Stop or the
   *  next start closes such a row. A Stop accepted while it waits ends the
   *  wake stopped, as Stop said it would. */
  private async endWithRetries(run: WakeRun, end: () => void): Promise<void> {
    const delays = this.deps.wakeEndRetryDelaysMs ?? WAKE_END_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        if (run.signal.aborted) this.endFailedWake(run, new WakeCanceledError());
        else end();
        return;
      } catch (err) {
        if (attempt >= delays.length) {
          logError(`agent wake ${run.wakeId} could not be ended`, err);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  /** Steps until the turn ends: a reply, or a stop. Replies cut off at the
   *  output token limit are gone on with OUTPUT_LIMIT_RETRIES times in a row;
   *  the next cut one ends the turn (cutOff). */
  private async runSteps(run: WakeRun, tokens: WakeTokens): Promise<RanSteps> {
    const { threadId, wakeId, signal } = run;
    let stepCount = 0;
    let stuck: string | null = null;
    let cutStreak = 0;
    let cutOff = false;
    while (true) {
      throwIfCanceled(signal);
      const step = await this.runStep(threadId, wakeId, {
        reason: run.reason,
        triggerMessageId: run.triggerMessageId,
        signal,
        wakeMetadata: run.wakeMetadata,
        onUsage: (inputTokens) => this.publishContextUsage(run, tokens, inputTokens),
        cutRetry: cutStreak < OUTPUT_LIMIT_RETRIES
      });
      throwIfCanceled(signal);
      stepCount++;
      this.deps.agentStore.updateWakeStepCount(wakeId, stepCount);
      cutStreak = step.cut ? cutStreak + 1 : 0;
      if (step.stuck) { stuck = step.stuck; break; }
      if (step.cutOff) { cutOff = true; break; }
      if (step.done) break;
    }
    return { stepCount, stuck, cutOff };
  }

  private publishContextUsage(run: WakeRun, tokens: WakeTokens, inputTokens: number): void {
    tokens.last = inputTokens;
    tokens.max = tokens.max === null
      ? inputTokens
      : Math.max(tokens.max, inputTokens);
    this.deps.agentStore.updateWakeTokenUsage(run.wakeId, tokens.last, tokens.max);
    const contextUsage = this.contextUsage(tokens.last);
    if (contextUsage) {
      this.deps.sse.emit(SSE_EVENTS.agentContextUsageUpdated, {
        threadId: run.threadId,
        wakeId: run.wakeId,
        contextUsage
      });
    }
  }

  /** A turn that ran to its end: stuck, finished, or finished on replies
   *  that kept being cut off (a stop line, the wake itself finished). */
  private endRanWake(run: WakeRun, outcome: RanSteps): void {
    const { threadId, wakeId, scopeInfo } = run;
    const { stepCount, stuck, cutOff } = outcome;
    if (stuck) {
      this.endWake({
        threadId, wakeId, status: "stuck", errorMessage: stuck, stepCount,
        failure: { status: "stuck", message: stuck, stepCount },
        contextUsage: this.contextUsageAtEnd(threadId), scopeInfo
      });
    } else if (cutOff) {
      this.endWake({
        threadId, wakeId, status: "finished", stepCount,
        failure: { status: "cut_off", message: OUTPUT_LIMIT_STOPPED, stepCount },
        contextUsage: this.contextUsageAtEnd(threadId), scopeInfo
      });
    } else {
      this.endWake({ threadId, wakeId, status: "finished", stepCount, contextUsage: this.contextUsageAtEnd(threadId), scopeInfo });
    }
  }

  /** A turn that threw: stopped by the person, or failed. */
  private endFailedWake(run: WakeRun, err: unknown): void {
    const { threadId, wakeId, scopeInfo } = run;
    if (err instanceof WakeCanceledError || run.signal.aborted) {
      this.endWake({
        threadId, wakeId, status: "canceled", errorMessage: "Stopped by user.",
        contextUsage: this.contextUsageAtEnd(threadId), scopeInfo
      });
      return;
    }
    const userError = toUserFacingError(err, "LLM call failed");
    const message = withImageHint(userError, this.imagePromptByWake.get(wakeId));
    logError(`agent wake ${wakeId}`, wakeErrorLogMessage(userError), "LLM call failed");
    this.endWake({
      threadId, wakeId, status: "error", errorMessage: message, error: { ...userError, message },
      failure: { status: "error", message, stepCount: this.deps.agentStore.getWakeById(wakeId)?.stepCount ?? 0 },
      contextUsage: this.contextUsageAtEnd(threadId), scopeInfo
    });
  }

  /** Forgets the wake, starts its post-wake hook, releases the thread, and
   *  starts what was queued behind it. Runs however the wake ended. */
  private releaseWake(threadId: string, wakeId: string, release: () => void): void {
    const finalWake = this.deps.agentStore.getWakeById(wakeId);
    const finalStatus = finalWake && finalWake.status !== "running"
      ? finalWake.status as "finished" | "stuck" | "error" | "canceled"
      : "error";
    this.running.delete(wakeId);
    this.runtimeContext.end(wakeId);
    this.personSeqByWake.delete(wakeId);
    this.imagePromptByWake.delete(wakeId);
    let postWakeHookPromise: Promise<void> | null = null;
    if (this.deps.postWakeHook) {
      try {
        // Start post-wake bookkeeping before releasing the wake lock so
        // release-time follow-up checks see any synchronous state changes.
        postWakeHookPromise = Promise.resolve(this.deps.postWakeHook(threadId, {
          wakeId,
          status: finalStatus
        }));
      } catch (err) {
        // Never let a hook failure poison the wake result — but say so.
        logError(`agent wake ${wakeId} post-wake hook`, err);
      }
    }
    release();
    // Starts whatever was queued behind the wake (a user message, mailbox,
    // task, window watch); one that fails is tried again.
    this.followUps.run(threadId, `agent wake ${wakeId}`);
    postWakeHookPromise?.catch((err) => logError(`agent wake ${wakeId} post-wake hook`, err));
  }

  private async runStep(
    threadId: string,
    wakeId: string,
    opts: {
      reason: AgentWakeReason;
      triggerMessageId: string | null;
      signal: AbortSignal;
      wakeMetadata?: AgentWakeMetadata | null;
      onUsage?: (inputTokens: number) => void;
      /** Whether a reply cut off at the output token limit is gone on with. */
      cutRetry: boolean;
    }
  ): Promise<RanStep> {
    // Only this step's model request may set it (its pre-call hooks, such as
    // compression, can fail on their own, image-free).
    this.imagePromptByWake.delete(wakeId);
    // Any call of the thread drops a seal waiting on it: from the step's
    // start, so one due during the work before the call never goes out
    // beside it. That work failing (or stopped) puts it back: no call follows.
    this.deps.cacheSeal?.noteCallStarted(threadId);
    const { dispatcher, request } = await this.prepareStep(threadId, wakeId, opts).catch((err: unknown) => {
      this.deps.cacheSeal?.noteStepNotCalled(threadId);
      throw err;
    });
    const callStartedAt = Date.now();
    const collected = await this.runStepCall(threadId, request, callStartedAt, opts.signal, () => this.llmAttempts.run({
      candidates: request.candidates,
      threadId,
      wakeId,
      requestPayload: request.requestPayload,
      purpose: request.purpose,
      metadata: request.callMetadata,
      callId: request.callId,
      streamArgs: {
        tools: request.tools,
        system: request.system,
        messages: request.messages,
        abortSignal: opts.signal
      },
      messagesFor: request.messagesFor,
      // Each attempt's row says what its own marks asked for (none off Anthropic).
      metadataFor: (candidate) => ({ cacheTtl: candidate.meta?.provider === "anthropic" ? request.cacheTtlFor?.(candidate) ?? "1h" : undefined }),
      signal: opts.signal,
      // For the failure hint: the candidate whose request failed, when that
      // request carried images (the last failed attempt is the one thrown).
      onAttemptFailed: (candidate) => {
        if (promptContainsImageInput(request.messages)) this.imagePromptByWake.set(wakeId, candidate.meta?.model || "this model");
        else this.imagePromptByWake.delete(wakeId);
      },
      // The page shows the model a turn runs on now: told when it changes.
      onAttemptStart: (candidate) => this.noteModelInFlight(threadId, wakeId, candidate)
    }));

    // Stopped at the output token limit: the call it was writing (arguments
    // that are not JSON) is not run, and the reasoning the reply ended on is
    // not kept — replayed with nothing after it, a provider refuses it. A
    // reply that was reasoning only is not stored at all.
    const cut = collected.finishReason === "length";
    const cutCallIds = new Set(cut ? collected.unreadableToolCallIds ?? [] : []);
    if (!cut) {
      this.appendAssistantStep(threadId, wakeId, collected, cutCallIds);
    } else if (collected.text || collected.toolCalls.length > 0) {
      const sdkAssistantMessages = withoutTrailingReasoning(collected.sdkAssistantMessages ?? []);
      // A cut reply the turn goes on after does not end it, for the page
      // too: it keeps the turn running (and Stop) until the next step.
      const endTurn = opts.cutRetry ? false : undefined;
      this.appendAssistantStep(threadId, wakeId, { ...collected, sdkAssistantMessages, endTurn }, cutCallIds);
    }
    // A cut reply too: one that ends the turn leaves the thread quiet.
    if (request.purpose === "agent_wake_step") this.noteSealStep(threadId, request, collected, callStartedAt);

    // The context the model read (a continued reply bills more than it read).
    const inputTokens = positiveNumberOrNull(collected.usage.contextPromptTokens ?? collected.usage.promptTokens);
    if (inputTokens !== null) opts.onUsage?.(inputTokens);

    const stuck = collected.toolCalls.length === 0 ? null
      : await this.runToolCalls(threadId, wakeId, dispatcher, collected.toolCalls, opts.signal, cutCallIds);
    if (!cut) {
      return { done: collected.toolCalls.length === 0 && collected.endTurn !== false, inputTokens, stuck };
    }
    if (!opts.cutRetry) return { done: true, inputTokens, stuck, cut, cutOff: true };
    const note = outputLimitNote({
      text: Boolean(collected.text),
      calls: collected.toolCalls.length > 0,
      droppedCall: (collected.unfinishedToolCalls ?? 0) > 0
    });
    if (note) this.appendOutputLimitNote(threadId, wakeId, note);
    return { done: false, inputTokens, stuck, cut };
  }

  /** A step's work before its call: queued input, runtime context, the
   *  pre-call hooks (a compaction), the history with its images fitted, and
   *  the request built from it. */
  private async prepareStep(
    threadId: string,
    wakeId: string,
    opts: { reason: AgentWakeReason; triggerMessageId: string | null; signal: AbortSignal; wakeMetadata?: AgentWakeMetadata | null }
  ) {
    throwIfCanceled(opts.signal);
    if (this.deps.preStepHook) {
      await this.deps.preStepHook(threadId, { wakeId });
    }
    throwIfCanceled(opts.signal);
    this.notePersonMessages(threadId, wakeId);
    const dispatcher = this.deps.toolDispatcherForThread(threadId);
    await this.runtimeContext.ensurePromptContextMessages(threadId, wakeId);
    if (this.deps.beforeModelCallHook) {
      const hookResult = await this.deps.beforeModelCallHook(threadId, {
        wakeId,
        reason: opts.reason,
        triggerMessageId: opts.triggerMessageId
      });
      throwIfCanceled(opts.signal);
      if (hookResult?.historyChanged) {
        await this.runtimeContext.ensurePromptContextMessages(threadId, wakeId);
      }
    }
    // The thread's models as they are once the pre-call work is done: one
    // switched to while it ran (a compaction) is the one this step calls.
    const llm = this.threadLlm(threadId);
    // The history this step sends, its images made small enough first.
    const active = this.deps.agentStore.getActiveMessages(threadId);
    const fitted = await this.images().prepare(active);
    throwIfCanceled(opts.signal);
    return { dispatcher, request: this.buildStepRequest(threadId, wakeId, opts, dispatcher, llm, active, fitted) };
  }

  /** What the model reads before the step after a cut-off reply. Its own:
   *  never shown, as the runtime context is not. */
  private appendOutputLimitNote(threadId: string, wakeId: string, text: string): void {
    this.deps.agentStore.appendMessage({
      threadId, role: "user", source: "output-limit", wakeId,
      content: { type: "text", text }
    });
  }

  /** This step's request: its prompt (stepPrompt) and the llm-call row
   *  opened for it. */
  private buildStepRequest(
    threadId: string,
    wakeId: string,
    opts: { wakeMetadata?: AgentWakeMetadata | null },
    dispatcher: ToolDispatcher,
    llm: ThreadLlm,
    active: AgentMessage[],
    fitted: FittedImages
  ) {
    const prompt = this.stepPrompt(threadId, dispatcher, llm, active, fitted, { stepMarks: true });
    const { messages, candidates, systemContent, promptMaxSeq } = prompt;
    const requestPayload = {
      system: systemContent,
      messages,
      toolNames: Object.keys(prompt.tools)
    };
    // A subagent's steps are filed apart, with whose they are; the step's own
    // keys come after, so a recording's never stands in for them.
    const recording = this.deps.stepRecordingForThread?.(threadId) ?? null;
    const purpose = recording?.purpose ?? "agent_wake_step";
    const callMetadata = {
      ...(recording?.metadata ?? {}),
      wakeId,
      // Activity names a call's role and wake from these once the thread and
      // its wake rows are deleted (deleting a thread keeps its calls).
      threadScope: this.deps.agentStore.getThreadById(threadId)?.scope ?? null,
      wakeReason: this.deps.agentStore.getWakeById(wakeId)?.reason ?? null,
      messageCount: messages.length,
      promptMaxSeq,
      // What the first candidate's message marks asked for, when it caches by marks.
      ...(candidates[0]?.meta?.provider === "anthropic" ? { cacheTtl: prompt.cacheTtlFor?.(candidates[0]) ?? "1h" } : {})
    };
    const firstRecorder = candidates[0]?.llmCallRecorder ?? llm.llmCallRecorder;
    const callId = firstRecorder?.startCall({
      purpose,
      scopeType: "agent_thread",
      scopeId: threadId,
      requestPayload,
      metadata: callMetadata
    }) ?? null;

    return { ...prompt, requestPayload, callMetadata, callId, purpose };
  }

  /** A step's prompt: the history as stored, the candidates that can take it,
   *  the system instruction and the tools. */
  private images(): ModelImageFitter {
    return this.deps.modelImages ?? modelImages;
  }

  private stepPrompt(
    threadId: string,
    dispatcher: ToolDispatcher,
    llm: ThreadLlm,
    active: AgentMessage[],
    fitted: FittedImages,
    opts: { stepMarks: boolean }
  ): StepPrompt {
    const promptMaxSeq = active.reduce((max, message) => Math.max(max, message.seq), 0);
    // System-role messages are persisted separately as the immutable first
    // instruction. The LLM-facing messages[] stream stays append-only user /
    // assistant / tool history plus context snapshots.
    const includeImages = this.deps.supportsInputForThread?.(threadId, "image") ?? true;
    const includeToolResultImages = this.deps.supportsToolResultImagesForThread?.(threadId) ?? includeImages;
    const allCandidates = normalizeLlmCandidates(llm, this.deps.llmCallRecorder);
    const timeZone = this.deps.timeZone ?? localTimeZone();
    const imageForModel = (image: { id: string; data: string; mediaType: string }, messageId: string) => fitted.forModel(image, messageId);
    // Each candidate model gets the history it can take: a step's stored
    // provider state goes back only to the model id that wrote it. Built once
    // per model id; a candidate that names none gets the history as stored.
    const byModel = new Map<string, ModelMessage[]>();
    const builtFor = (candidate: WakeLlmCandidate): ModelMessage[] => {
      const { target, key } = replayTargetFor(candidate);
      let built = byModel.get(key);
      if (!built) {
        built = prepareAiSdkMessages(active, { includeImages, includeToolResultImages, timeZone, imageForModel, ...target });
        byModel.set(key, built);
      }
      return built;
    };
    // Who can take the history's images, judged on it before any cache mark
    // (a mark changes no image).
    const unmarked = allCandidates[0] ? builtFor(allCandidates[0]) : prepareAiSdkMessages(active, { includeImages, includeToolResultImages, timeZone, imageForModel });
    const candidates = filterCandidatesForPromptImages(allCandidates, unmarked);
    if (candidates.length === 0) {
      throw new Error("current agent model candidates do not support image input");
    }
    // What a wake step marks its messages for. Its leader — the first candidate the images leave —
    // five minutes while it takes part and is not paused: its quiet thread is
    // sealed for an hour. A fallback five minutes too, never sealed: it answers
    // only when the leader fails, rarely twice in a row. Sealing switched off,
    // a subagent's step, a compaction or a seal: an hour, as before sealing.
    const sealedStep = opts.stepMarks && !this.deps.stepRecordingForThread?.(threadId);
    const leader = candidates[0];
    // Fixed once asked for (when the candidate's messages are built): what the
    // request sent, whatever the switch or the model's pause says after.
    const ttls = new Map<WakeLlmCandidate, AnthropicCacheTtl>();
    const cacheTtlFor = (candidate: WakeLlmCandidate): AnthropicCacheTtl => {
      let ttl = ttls.get(candidate);
      if (!ttl) {
        const seal = this.deps.cacheSeal;
        const short = sealedStep && seal !== undefined && (candidate === leader ? seal.shortMarksFor(candidate) : seal.fallbackMarksShort());
        ttl = short ? "5m" : "1h";
        ttls.set(candidate, ttl);
      }
      return ttl;
    };
    const messagesFor = (candidate: WakeLlmCandidate): ModelMessage[] => withCacheMarksFor(candidate, builtFor(candidate), cacheTtlFor(candidate));
    // What the first candidate is sent: the request logged for the step.
    const messages = allCandidates[0] ? messagesFor(allCandidates[0]) : unmarked;

    const systemContent = systemContentForThread(this.deps.agentStore, threadId);
    // Wrap as a SystemModelMessage so we can attach cacheControl to the
    // immutable system instruction. Runtime state is stored as user-role
    // context messages, cached with the conversation by its own marks
    // (withAnthropicCacheBreakpoints).
    const system: string | SystemModelMessage = systemContent
      ? {
          role: "system" as const,
          content: systemContent,
          providerOptions: { anthropic: { cacheControl: ANTHROPIC_CACHE_CONTROL } }
        }
      : "";

    return { tools: dispatcher.registry.tools, systemContent, system, candidates, messagesFor, messages, promptMaxSeq, cacheTtlFor };
  }

  /** The step's model call. One that does not answer (Stop, a failure, a
   *  Stop just after it answered) sent its prompt all the same: the cache
   *  seal is told, so the quiet thread is still sealed. */
  private async runStepCall<T>(threadId: string, request: StepPrompt & { purpose: string }, startedAt: number, signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    try {
      const collected = await call();
      throwIfCanceled(signal);
      return collected;
    } catch (err) {
      if (request.purpose === "agent_wake_step") this.deps.cacheSeal?.noteStepFailed(threadId, { prompt: request, startedAt });
      throw err;
    }
  }

  /** A wake step that answered, for the cache seal: the prompt it sent, the
   *  candidate that answered, when its call ran and what it read from the
   *  cache. */
  private noteSealStep(threadId: string, prompt: StepPrompt, collected: Awaited<ReturnType<WakeLlmAttempts["run"]>>, startedAt: number): void {
    const sealer = this.deps.cacheSeal;
    if (!sealer) return;
    sealer.noteStepSucceeded(threadId, {
      prompt, served: collected.answeredBy ?? null, startedAt, finishedAt: Date.now(),
      cacheReadTokens: extractUsage(collected.usage).cacheReadTokens ?? 0,
      cacheWriteTokens: extractUsage(collected.usage).cacheWriteTokens ?? 0,
      cacheWrite1hTokens: collected.facts?.cacheWrite1h ?? 0
    });
  }

  /** The model's reply, stored and announced. A call cut off mid-arguments
   *  keeps no arguments: what came is not JSON, which no model takes back
   *  (the SDK's own replay sends it the same way). */
  private appendAssistantStep(
    threadId: string,
    wakeId: string,
    collected: Awaited<ReturnType<WakeLlmAttempts["run"]>>,
    cutCallIds: ReadonlySet<string>
  ): void {
    const assistantContent: AssistantContent = { type: "assistant" };
    if (collected.sdkAssistantMessages?.length) assistantContent.sdkAssistantMessages = collected.sdkAssistantMessages;
    if (collected.text) assistantContent.text = collected.text;
    if (collected.toolCalls.length > 0) {
      assistantContent.toolCalls = collected.toolCalls.map((call) => cutCallIds.has(call.toolCallId) ? { ...call, args: {} } : call);
    }
    if (collected.endTurn === false) assistantContent.endTurn = false;
    if (collected.reasoning) assistantContent.reasoning = collected.reasoning;
    if (collected.writtenBy) assistantContent.writtenBy = collected.writtenBy;

    const assistantMsg = this.deps.agentStore.appendMessage({
      threadId, role: "assistant", source: "self",
      wakeId, content: assistantContent
    });
    this.deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message: assistantMsg });
  }

  /** Runs the step's tool calls in order, storing each result. A call cut
   *  off mid-arguments is answered as not run, outside the repeat count.
   *  Returns why the wake must stop (the repeat stop), or null. */
  private async runToolCalls(
    threadId: string,
    wakeId: string,
    dispatcher: ToolDispatcher,
    toolCallsThisStep: ToolCallSpec[],
    signal: AbortSignal,
    cutCallIds: ReadonlySet<string>
  ): Promise<string | null> {
    this.repeatFailures.beginStep(threadId);
    let stuck: string | null = null;
    for (let i = 0; i < toolCallsThisStep.length; i++) {
      const call = toolCallsThisStep[i]!;
      if (signal.aborted) {
        this.appendCanceledToolResults(threadId, wakeId, toolCallsThisStep.slice(i));
        throw new WakeCanceledError();
      }
      if (cutCallIds.has(call.toolCallId)) {
        this.appendToolResult(threadId, wakeId, call, { isError: true, error: OUTPUT_LIMIT_CALL_NOT_RUN });
        continue;
      }
      const dispatched = await dispatcher.dispatch(call, {
        threadId, wakeId,
        scope: this.deps.buildToolScope(threadId),
        // A stop reaches the call that runs, not only the ones after it.
        signal
      });
      // The repeat stop: the same call failing the same way. The third failure tells
      // the model at once; the fifth ends the wake after this step.
      const verdict = this.repeatFailures.record(threadId, {
        toolName: call.toolName,
        args: call.args,
        isError: Boolean(dispatched.isError),
        ...(dispatched.isError ? { error: dispatched.error } : {})
      });
      // First, not last: a long error is cut for the model from its end.
      const note = !dispatched.isError ? null : verdict.stop ? repeatStopText(verdict.count) : verdict.nudge ? REPEAT_NUDGE_TEXT : null;
      const error = note ? `${note}\n\n${dispatched.error}` : dispatched.error;
      if (verdict.stop && !stuck) stuck = `${call.toolName} failed ${verdict.count} times in a row: ${dispatched.error}`;
      this.appendToolResult(threadId, wakeId, call, dispatched.isError ? { isError: true, error } : { result: dispatched.result });
      if (signal.aborted) {
        this.appendCanceledToolResults(threadId, wakeId, toolCallsThisStep.slice(i + 1));
        throw new WakeCanceledError();
      }
    }

    // A stop holds only if the streak still stands after the whole step: a
    // success later in it (parallel calls) clears it, whatever their order.
    if (stuck && !this.repeatFailures.isStopped(threadId)) stuck = null;
    return stuck;
  }

  private appendToolResult(
    threadId: string,
    wakeId: string,
    call: ToolCallSpec,
    outcome: { isError: true; error: string | undefined } | { result: unknown }
  ): void {
    const toolMsg = this.deps.agentStore.appendMessage({
      threadId, role: "tool", source: "self", wakeId,
      content: { type: "tool_result", toolCallId: call.toolCallId, toolName: call.toolName, ...outcome }
    });
    this.deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message: toolMsg });
  }

  /** What a thread's meter shows once its wake has ended: the store's
   *  answer, which knows whether the window was compacted after the last call
   *  that measured it. The wake's own last figure is then from before the
   *  compaction (a turn that compacts at a gate and fails or is stopped on
   *  the call after it), and no figure is the truth. */
  private contextUsageAtEnd(threadId: string): WakeContextUsage {
    const budget = positiveNumberOrNull(resolveNumber(this.deps.contextBudgetTokens));
    return budget === null ? null : this.deps.agentStore.getContextUsage(threadId, budget);
  }

  private contextUsage(inputTokens: number | null): WakeContextUsage {
    const budget = positiveNumberOrNull(resolveNumber(this.deps.contextBudgetTokens));
    if (budget === null) return null;
    return {
      inputTokens,
      budgetTokens: budget,
      updatedAt: new Date().toISOString(),
      source: "compression_budget"
    };
  }

  /** A person's message that reaches a running wake between steps (queued,
   *  then delivered by preStepHook) counts as a wake of their own would:
   *  the streak of a repeated failing call starts over. Once per message —
   *  the wake remembers the newest it has seen. */
  private notePersonMessages(threadId: string, wakeId: string): void {
    const newest = this.deps.agentStore.latestPersonMessageSeq(threadId);
    if (newest <= (this.personSeqByWake.get(wakeId) ?? newest)) return;
    this.personSeqByWake.set(wakeId, newest);
    this.repeatFailures.reset(threadId);
    const run = this.running.get(wakeId);
    if (run) run.answersPerson = true;
  }

  /** Whether a stop for a repeated failing call holds the thread
   *  against a wake no person started. Never the global agent's or a
   *  manager's: for them the stop ends the turn and nothing more
   *  (STUCK_ENDS_THE_TURN). A worker's, until someone above it writes: a
   *  person, or its manager, which was told it stopped and whose message
   *  waits in its mail (before, that message was never read and
   *  the manager was told "queued"). */
  private heldByStop(thread: AgentThread): boolean {
    if (this.deps.agentStore.getLatestWakeForThread(thread.id)?.status !== "stuck") return false;
    if (STUCK_ENDS_THE_TURN.has(thread.scope)) return false;
    return !this.deps.agentStore.queuedMailboxSources(thread.id).includes("manager");
  }

  private appendCanceledToolResults(threadId: string, wakeId: string, calls: ToolCallSpec[]): void {
    for (const call of calls) {
      const toolMsg = this.deps.agentStore.appendMessage({
        threadId,
        role: "tool",
        source: "self",
        wakeId,
        content: {
          type: "tool_result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          isError: true,
          error: TOOL_CALL_STOPPED
        }
      });
      this.deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message: toolMsg });
    }
  }

  /** A person asked for this wake: they wrote the message that triggers it
   *  (chat or voice).
   *  Internal wakes borrow the "user" reason too — mailbox flushes, task
   *  wakes, feature-message replies — but carry no message of the user's. */
  private isPersonInitiatedWake(reason: AgentWakeReason, triggerMessageId: string | null): boolean {
    if (reason !== "user" || !triggerMessageId) return false;
    const source = this.deps.agentStore.getMessageById(triggerMessageId)?.source;
    return source === "user" || source === "voice";
  }

  private llmTimeout(): TimeoutConfiguration<ToolSet> {
    const configured = this.deps.llmTimeout;
    return typeof configured === "function" ? configured() : configured ?? AGENT_WAKE_STEP_LLM_TIMEOUT;
  }

  private streamIdleTimeoutMs(): number {
    const value = positiveNumberOrNull(resolveNumber(this.deps.streamIdleTimeoutMs));
    return value === null ? LLM_STREAM_IDLE_TIMEOUT_MS : Math.floor(value);
  }

}

function systemContentForThread(agentStore: AgentStore, threadId: string): string {
  const message = agentStore.getSystemMessage(threadId);
  if (!message || message.content.type !== "text") return "";
  return message.content.text;
}

function normalizeLlmCandidates(
  llm: { model: LanguageModel; llmCallRecorder?: AgentLlmCallRecorder; candidates?: WakeLlmCandidate[] },
  fallbackRecorder?: AgentLlmCallRecorder
): WakeLlmCandidate[] {
  return llm.candidates?.length
    ? llm.candidates
    : [{ model: llm.model, llmCallRecorder: llm.llmCallRecorder ?? fallbackRecorder }];
}

function filterCandidatesForPromptImages(
  candidates: WakeLlmCandidate[],
  messages: ModelMessage[]
): WakeLlmCandidate[] {
  if (!promptContainsImageInput(messages)) return candidates;
  const hasToolResultImage = promptContainsToolResultImageInput(messages);
  return candidates.filter((candidate) =>
    candidate.supportsImageInput !== false &&
    (!hasToolResultImage || candidate.supportsToolResultImages !== false)
  );
}

function promptContainsImageInput(messages: ModelMessage[]): boolean {
  return messages.some((message) => valueContainsImageInput((message as Record<string, unknown>).content));
}

function promptContainsToolResultImageInput(messages: ModelMessage[]): boolean {
  return messages.some((message) => valueContainsToolResultImageInput((message as Record<string, unknown>).content));
}

function valueContainsImageInput(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(valueContainsImageInput);
  const record = value as Record<string, unknown>;
  if (
    record.type === "image" ||
    record.type === "image-data" ||
    record.type === "image-url" ||
    record.type === "image-file-id"
  ) {
    return true;
  }
  if (record.type === "content" && valueContainsImageInput(record.value)) return true;
  if (record.type === "tool-result" && valueContainsImageInput(record.output)) return true;
  if (record.type === "file" && isImageMediaType(record.mediaType)) return true;
  if (record.type === "media" && typeof record.mediaType === "string" && record.mediaType.startsWith("image/")) {
    return true;
  }
  return false;
}

function valueContainsToolResultImageInput(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(valueContainsToolResultImageInput);
  const record = value as Record<string, unknown>;
  if (record.type === "tool-result") return valueContainsImageInput(record.output);
  return false;
}

function isImageMediaType(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const mediaType = value.trim().toLowerCase();
  return mediaType === "image" || mediaType.startsWith("image/");
}

function wakeErrorLogMessage(error: ReturnType<typeof toUserFacingError>): string {
  const parts = [
    error.message,
    error.category ? `category=${error.category}` : "",
    error.code ? `code=${error.code}` : "",
    error.detail && error.detail !== error.message ? `detail=${error.detail}` : ""
  ].filter(Boolean);
  return parts.join(" ");
}


function resolveNumber(value: number | (() => number) | undefined): number | undefined {
  return typeof value === "function" ? value() : value;
}

function throwIfCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new WakeCanceledError();
}
