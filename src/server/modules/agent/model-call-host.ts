import type { ModelMessage, SystemModelMessage, TimeoutConfiguration, ToolSet } from "ai";
import { getLogLevel, logStacks } from "../../platform/logger.js";
import { llmStreamTrace } from "./llm-stream-diagnostics.js";
import type { LlmStreamDiagnosticsInput } from "./llm-stream-diagnostics.js";
import { decodeData, decodeError, encodeData, encodeError, encodePrompt } from "./model-call-codec.js";
import type { FromWorker, HostDiagnostics, ToWorker } from "./model-call-protocol.js";
import type { ModelStreamHooks, ModelStreamOutput } from "./model-stream.js";
import type { OfferedToolSpec } from "./tool-set.js";
import type { candidateCallOptions, WakeLlmCandidate } from "./wake-llm-attempts.js";

export type { HostDiagnostics } from "./model-call-protocol.js";

/** The worker's path in the build: scripts/build-binary.ts makes it an
 *  entrypoint of the binary by this name. */
export const MODEL_CALL_WORKER_ENTRY = "./src/server/modules/agent/model-call-worker.ts";

/** In a compiled binary an entrypoint is found by its path in the build;
 *  from source, the worker sits beside this file. */
function workerSpec(): string {
  return import.meta.url.includes("/$bunfs/") ? MODEL_CALL_WORKER_ENTRY : new URL("./model-call-worker.ts", import.meta.url).href;
}

/** A stream whose worker was lost before it ended. Read by the retry policy
 *  as a dropped connection (retry-policy.ts). */
export class ModelWorkerLostError extends Error {
  constructor() {
    super("the model worker was lost before the response finished");
    this.name = "ModelWorkerLostError";
  }
}

export interface HostStreamRequest {
  attemptId: string;
  threadId: string;
  wakeId: string;
  candidate: WakeLlmCandidate;
  tools: OfferedToolSpec[];
  system?: string | SystemModelMessage | SystemModelMessage[];
  messages: ModelMessage[];
  callOptions: Omit<ReturnType<typeof candidateCallOptions>, "model">;
  askSummary: boolean;
  timeout: TimeoutConfiguration<ToolSet>;
  idleMs: number;
  startedAt: number;
  diagnostics: LlmStreamDiagnosticsInput;
  signal: AbortSignal;
}

export type HostStreamResult =
  | { ok: true; output: ModelStreamOutput }
  /** The stream failed, or was stopped. `observed` when this is not the
   *  worker's own answer (it was lost, or did not answer a Stop in time):
   *  what this thread saw of the stream. */
  | { ok: false; error: unknown; notPosted?: undefined; observed?: StreamObserved }
  /** It never reached the worker (not ready, or not cloneable): run it here. */
  | { ok: false; notPosted: true; error: unknown; observed?: undefined };

export interface StreamObserved {
  firstOutputAt: number | null;
  emittedText: boolean;
}

export interface ModelCallHostOptions {
  spawn?: (spec: string, options: WorkerOptions) => Worker;
  /** How long a new worker may take to say it is ready. */
  readyWaitMs?: number;
  /** How long the worker may go without saying it is alive (it says so every second). */
  aliveLimitMs?: number;
  /** After Stop, how long the worker's own answer is waited for. */
  abortAnswerMs?: number;
  /** Waits before starting the worker again, after each loss in a row. */
  restartBackoffMs?: number[];
  /** The clock the watchdog reads; a monotonic one by default, as the wall
   *  clock jumps (a clock change). */
  now?: () => number;
}

interface Pending {
  attemptId: string;
  hooks: ModelStreamHooks;
  total: string;
  firstOutputAt: number | null;
  emittedText: boolean;
  settle(result: HostStreamResult): void;
}

/**
 * The main thread's side of the model-call worker: starts it, hands it a
 * stream, turns its messages back into the stream's hooks and result, and
 * when it is lost (gone, or silent past the bound) fails its streams as a
 * dropped connection and starts another. Until it is ready, and while it is
 * down, canStream says no and the caller streams on this thread.
 */
export class ModelCallHost {
  private worker: Worker | null = null;
  /** Bumped for every worker and every loss: a message from an older one is dropped. */
  private generation = 0;
  private ready = false;
  private lastAlive = 0;
  /** When the watchdog last looked. */
  private lastLook = 0;
  /** A late look's grace was given since the worker's last alive: one per alive. */
  private graceGiven = false;
  /** The logging the worker was last told, as "level stacks trace". */
  private workerLogging: string | null = null;
  private readonly now: () => number;
  private losses = 0;
  private disposed = false;
  private sequence = 0;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly pending = new Map<string, Pending>();
  /** Attempts whose streams went to the current worker. */
  private readonly attemptsSent = new Set<string>();
  private readonly endWaits = new Map<string, (diagnostics: HostDiagnostics | null) => void>();
  private readonly readyWaitMs: number;
  private readonly aliveLimitMs: number;
  private readonly abortAnswerMs: number;
  private readonly backoffMs: number[];

  constructor(private readonly options: ModelCallHostOptions = {}) {
    this.readyWaitMs = options.readyWaitMs ?? 10_000;
    this.aliveLimitMs = options.aliveLimitMs ?? 10_000;
    this.abortAnswerMs = options.abortAnswerMs ?? 2_000;
    this.backoffMs = options.restartBackoffMs?.length ? options.restartBackoffMs : [1_000, 5_000, 30_000];
    this.now = options.now ?? (() => performance.now());
    this.lastLook = this.now();
    this.watchdog = setInterval(() => this.checkAlive(), Math.max(25, Math.floor(this.aliveLimitMs / 4)));
    (this.watchdog as { unref?: () => void }).unref?.();
  }

  /** Whether this candidate's stream, with these tools, can go to the worker now. */
  canStream(candidate: WakeLlmCandidate, tools: OfferedToolSpec[] | null): boolean {
    if (this.disposed || candidate.construction === undefined || tools === null) return false;
    // Started by the first stream it could take, which runs on this thread
    // while it starts: a server whose models need this thread never starts one.
    if (!this.worker && !this.restartTimer) this.start();
    return this.ready;
  }

  stream(request: HostStreamRequest, hooks: ModelStreamHooks): Promise<HostStreamResult> {
    return new Promise<HostStreamResult>((resolve) => {
      const { signal } = request;
      if (signal.aborted) {
        resolve({ ok: false, error: signal.reason });
        return;
      }
      const worker = this.worker;
      const construction = request.candidate.construction;
      if (!worker || !this.ready || !construction) {
        resolve({ ok: false, notPosted: true, error: new Error("the model worker is not ready") });
        return;
      }
      const streamId = `stream_${++this.sequence}`;
      let settled = false;
      let abortTimer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        if (settled) return;
        this.post({ type: "abort", streamId, reason: encodeError(signal.reason) });
        // The worker answers with the stream's own failure; if it cannot, the stop stands anyway.
        abortTimer = setTimeout(() => pending.settle({ ok: false, error: signal.reason, observed: { firstOutputAt: pending.firstOutputAt, emittedText: pending.emittedText } }), this.abortAnswerMs);
      };
      const pending: Pending = {
        attemptId: request.attemptId,
        hooks,
        total: "",
        firstOutputAt: null,
        emittedText: false,
        settle: (result) => {
          if (settled) return;
          settled = true;
          if (abortTimer) clearTimeout(abortTimer);
          signal.removeEventListener("abort", onAbort);
          this.pending.delete(streamId);
          resolve(result);
        }
      };
      this.pending.set(streamId, pending);
      signal.addEventListener("abort", onAbort, { once: true });
      const message: ToWorker = {
        type: "stream",
        streamId,
        attemptId: request.attemptId,
        threadId: request.threadId,
        wakeId: request.wakeId,
        snapshot: construction,
        tools: request.tools,
        ...(request.system !== undefined ? { system: request.system } : {}),
        messages: encodePrompt(request.messages),
        callOptions: encodeData(request.callOptions),
        askSummary: request.askSummary,
        timeout: request.timeout,
        idleMs: request.idleMs,
        diagnostics: request.diagnostics
      };
      try {
        // Logging changed since the worker was told (a config reload)
        // reaches it before the stream it applies to.
        this.tellLogging(worker);
        worker.postMessage(message);
        this.attemptsSent.add(request.attemptId);
      } catch (error) {
        pending.settle({ ok: false, notPosted: true, error });
      }
    });
  }

  /** The attempt is over: its stream diagnostics as the worker took them
   *  under this status; null when its streams did not go to the worker, or
   *  the worker is gone. A worker always answers, however busy; one that
   *  stops answering anything is found by the watchdog, which ends the wait. */
  endAttempt(attemptId: string, status: "succeeded" | "failed"): Promise<HostDiagnostics | null> {
    if (!this.worker || !this.attemptsSent.delete(attemptId)) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.endWaits.set(attemptId, (diagnostics) => {
        this.endWaits.delete(attemptId);
        resolve(diagnostics);
      });
      this.post({ type: "endAttempt", attemptId, status });
    });
  }

  /** The server is going away (the process exits right after). The worker
   *  ends; a stream still pending is left as a process exit leaves one on
   *  the main thread: unsettled, so its wake is not ended here and the next
   *  start resumes it, and nothing is tried in its place. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.watchdog);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    this.generation += 1;
    this.pending.clear();
    this.endWaits.clear();
    worker?.terminate();
  }

  private post(message: ToWorker): void {
    try {
      this.worker?.postMessage(message);
    } catch {
      // A worker that cannot be written to is lost: its watchdog says so.
    }
  }

  /** Tells the worker this thread's log level, stacks and stream trace
   *  settings, when they differ from what it was last told. */
  private tellLogging(worker: Worker): void {
    const level = getLogLevel();
    const stacks = logStacks();
    const streamTrace = llmStreamTrace();
    const key = `${level} ${stacks} ${streamTrace}`;
    if (key === this.workerLogging) return;
    worker.postMessage({ type: "logging", level, stacks, streamTrace } satisfies ToWorker);
    this.workerLogging = key;
  }

  private start(): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    const options: WorkerOptions = {};
    const worker = this.options.spawn ? this.options.spawn(workerSpec(), options) : new Worker(workerSpec(), options);
    (worker as { unref?: () => void }).unref?.();
    this.worker = worker;
    // Its logger starts at the defaults: this thread's config comes first.
    this.workerLogging = null;
    this.tellLogging(worker);
    this.ready = false;
    this.lastAlive = this.now();
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.onMessage(generation, event.data);
    const lost = (why: string) => () => { if (generation === this.generation) this.lose(why); };
    worker.addEventListener("error", lost("error"));
    worker.addEventListener("messageerror", lost("message error"));
    worker.addEventListener("close", lost("closed"));
    this.readyTimer = setTimeout(() => { if (generation === this.generation && !this.ready) this.lose("not ready in time"); }, this.readyWaitMs);
  }

  private onMessage(generation: number, message: FromWorker): void {
    if (generation !== this.generation) return;
    if (message.type === "ready") {
      this.ready = true;
      this.lastAlive = this.now();
      this.graceGiven = false;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this.losses = 0;
      return;
    }
    if (message.type === "alive") {
      this.lastAlive = this.now();
      this.graceGiven = false;
      return;
    }
    if (message.type === "attemptEnded") {
      this.endWaits.get(message.attemptId)?.(message.diagnostics);
      return;
    }
    const pending = this.pending.get(message.streamId);
    if (!pending) return;
    switch (message.type) {
      case "reasoning":
        pending.firstOutputAt ??= Date.now();
        pending.hooks.onReasoning();
        return;
      case "summary":
        pending.hooks.onSummaryInBody?.(message.sent);
        return;
      case "heading":
        pending.firstOutputAt ??= Date.now();
        pending.hooks.onHeading(message.heading);
        return;
      case "delta":
        pending.firstOutputAt ??= Date.now();
        pending.total += message.text;
        pending.emittedText = pending.emittedText || message.text.length > 0;
        pending.hooks.onTextDelta(message.text, pending.total);
        return;
      case "done":
        pending.settle({ ok: true, output: decodeData<ModelStreamOutput>(message.output) });
        return;
      case "failed":
        pending.settle({ ok: false, error: decodeError(message.error) });
        return;
    }
  }

  private checkAlive(): void {
    const now = this.now();
    const sinceLook = now - this.lastLook;
    this.lastLook = now;
    // Until a worker is ready its ready timer bounds it; a late look then
    // spends no grace.
    if (!this.worker || !this.ready) return;
    // A look far later than the watchdog's interval means this thread, or
    // the machine, was held or asleep: the worker's alive messages wait
    // behind it, so it gets a fresh bound instead of being taken for silent.
    // Once per alive: a thread held again and again cannot keep a worker
    // that sends nothing from being found.
    if (sinceLook > this.aliveLimitMs / 2 && !this.graceGiven) {
      this.graceGiven = true;
      this.lastAlive = now;
      return;
    }
    if (now - this.lastAlive > this.aliveLimitMs) this.lose("silent");
  }

  private lose(why: string): void {
    const worker = this.worker;
    if (!worker || this.disposed) return;
    this.worker = null;
    this.ready = false;
    this.generation += 1;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    try {
      worker.terminate();
    } catch {
      // Already gone.
    }
    for (const pending of [...this.pending.values()]) {
      pending.settle({ ok: false, error: new ModelWorkerLostError(), observed: { firstOutputAt: pending.firstOutputAt, emittedText: pending.emittedText } });
    }
    for (const done of [...this.endWaits.values()]) done(null);
    this.attemptsSent.clear();
    const delay = this.backoffMs[Math.min(this.losses, this.backoffMs.length - 1)]!;
    this.losses += 1;
    console.warn(`[mandate] model worker lost (${why}); model calls run on the main thread until it is back, in ${Math.round(delay / 100) / 10}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.disposed) this.start();
    }, delay);
    (this.restartTimer as { unref?: () => void }).unref?.();
  }
}
