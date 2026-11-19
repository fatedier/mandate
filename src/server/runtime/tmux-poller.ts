import type { Analyzer } from "../modules/analysis/analyzer.js";
import type { MandateStore } from "../app/store.js";
import { buildTmuxSnapshot, getRawTmuxState } from "../platform/tmux/tmux.js";
import { createPaneCaptureCache } from "../platform/tmux/pane-capture-cache.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { PaneMetadataStore } from "../modules/panes/pane-metadata-store.js";
import type { TmuxSnapshot, RawTmuxState } from "../platform/tmux/tmux-types.js";
import type { BroadcastCenter } from "./broadcast-center.js";
import { SSE_EVENTS } from "../../shared/api-contracts.js";
import { randomUUID } from "node:crypto";
import { errorText } from "../../shared/error-text.js";
import { stallWatch } from "../platform/diagnostics/stall-watch.js";

interface TmuxPollerDeps {
  store: MandateStore;
  analyzer: Analyzer;
  broadcaster: BroadcastCenter;
  tmuxClient: TmuxClient;
  paneMetadata?: PaneMetadataStore;
  captureLines: number;
}

interface PollOptions {
  forceWindowIds?: Iterable<string>;
}

interface LastError {
  message: string;
  at: string;
}

/** Owns the tmux polling loop and the cached "last raw state / last
 *  snapshot / last error" so HTTP routes can read snapshot data without
 *  re-running tmux. State is private — read it via the accessor methods.
 *
 *  Write path: `poll()` — full re-scan, called every `pollIntervalMs` and
 *  on demand. */
export class TmuxPoller {
  private raw: RawTmuxState | null = null;
  private snapshot: TmuxSnapshot | null = null;
  private lastError: LastError | null = null;
  private polling = false;
  private inFlight: Promise<void> | null = null;
  private readonly snapshotEpoch = randomUUID();
  /** What the poll captured, kept so a pane is captured again only when tmux
   *  reports it changed (pane-capture-cache.ts). */
  private readonly captureCache = createPaneCaptureCache();
  private snapshotRevision = 0;

  constructor(private deps: TmuxPollerDeps) {}

  getSnapshot(): TmuxSnapshot | null { return this.snapshot; }
  getRaw(): RawTmuxState | null { return this.raw; }
  getLastError(): LastError | null { return this.lastError; }

  updateConfig(input: { captureLines: number }): void {
    this.deps.captureLines = input.captureLines;
  }

  async poll(options: PollOptions = {}): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const run = this.runPoll(options);
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
      this.polling = false;
    }
  }

  /** A poll that began after this call: what tmux has now, a pane just made
   *  included. One already running may have read tmux before; it is waited
   *  for, then read again. */
  async pollFresh(): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => {});
    // One that began after the poll awaited above began after this call.
    if (this.inFlight) return this.inFlight.catch(() => {});
    return this.poll();
  }

  private async runPoll(options: PollOptions): Promise<void> {
    try {
      const monitorWindowKeys = this.deps.store.listWorkerWindowKeys();
      const forceWindowIds = new Set(options.forceWindowIds ?? []);
      const polled = await this.getPolledRawTmuxState(
        this.deps.captureLines,
        forceWindowIds,
        monitorWindowKeys
      );
      stallWatch.run("tmux poll snapshot", () => {
        const raw = this.deps.paneMetadata?.enrichRawState(polled) ?? polled;
        const snapshot: TmuxSnapshot = {
          ...buildTmuxSnapshot(raw, this.deps.analyzer, { monitorWindowKeys }),
          snapshotVersion: { epoch: this.snapshotEpoch, revision: ++this.snapshotRevision }
        };
        this.raw = raw;
        this.snapshot = snapshot;
        const recovered = this.lastError !== null;
        this.lastError = null;
        // Clear the client's error banner even if the recovered state is idle.
        this.deps.broadcaster.snapshot(snapshot, { force: recovered });
      });
      await stallWatch.watched("tmux projects state", () => this.deps.broadcaster.projectsState());
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message !== this.lastError?.message) {
        this.lastError = { message, at: new Date().toISOString() };
        this.deps.broadcaster.emit(SSE_EVENTS.error, this.lastError);
      }
    }
  }

  private async getPolledRawTmuxState(
    captureLines: number,
    forceWindowIds: Set<string>,
    monitorWindowKeys: Set<string>
  ): Promise<RawTmuxState> {
    return getRawTmuxState(captureLines, {
      forceWindowIds,
      monitorWindowKeys,
      captureCache: this.captureCache
    }, this.deps.tmuxClient);
  }
}

function errorMessage(error: unknown): string {
  return errorText(error);
}
