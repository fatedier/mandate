import type { Analyzer } from "../modules/analysis/analyzer.js";
import type { MandateStore } from "../app/store.js";
import { buildTmuxSnapshot, getRawTmuxState } from "../platform/tmux/tmux.js";
import type { TmuxClient } from "../platform/tmux/tmux.js";
import type { PaneMetadataStore } from "../modules/panes/pane-metadata-store.js";
import type { TmuxSnapshot, RawTmuxPane, RawTmuxState } from "../platform/tmux/tmux-types.js";
import type { BroadcastCenter } from "./broadcast-center.js";
import { SSE_EVENTS } from "../../shared/api-contracts.js";
import { randomUUID } from "node:crypto";

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
  private readonly snapshotEpoch = randomUUID();
  private snapshotRevision = 0;

  constructor(private deps: TmuxPollerDeps) {}

  getSnapshot(): TmuxSnapshot | null { return this.snapshot; }
  getRaw(): RawTmuxState | null { return this.raw; }
  getLastError(): LastError | null { return this.lastError; }

  updateConfig(input: { captureLines: number }): void {
    this.deps.captureLines = input.captureLines;
  }

  /** Look up a pane in the cached raw state. Returns null when no poll has
   *  completed yet or the pane is gone. */
  findPaneById(paneId: string | undefined): RawTmuxPane | null {
    if (!paneId) return null;
    return this.raw?.panes.find((pane) => pane.paneId === paneId) ?? null;
  }

  async poll(options: PollOptions = {}): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const monitorWindowKeys = this.deps.store.listFeatureWindowKeys();
      const forceWindowIds = new Set(options.forceWindowIds ?? []);
      const polled = await this.getPolledRawTmuxState(
        this.deps.captureLines,
        forceWindowIds,
        monitorWindowKeys
      );
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
      this.deps.broadcaster.projectsState();
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message !== this.lastError?.message) {
        this.lastError = { message, at: new Date().toISOString() };
        this.deps.broadcaster.emit(SSE_EVENTS.error, this.lastError);
      }
    } finally {
      this.polling = false;
    }
  }

  private async getPolledRawTmuxState(
    captureLines: number,
    forceWindowIds: Set<string>,
    monitorWindowKeys: Set<string>
  ): Promise<RawTmuxState> {
    return getRawTmuxState(captureLines, {
      forceWindowIds,
      monitorWindowKeys
    }, this.deps.tmuxClient);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
