import type {
  PaneAnalysis,
  TmuxSnapshotWindow,
  RawTmuxPane,
  WindowAnalysis
} from "../../platform/tmux/tmux-types.js";
import {
  localPaneFallbackAnalysis,
  localWindowFallbackAnalysis
} from "./analyzer-normalization.js";
import { buildWindowHash, makeWindowSnapshot } from "./analyzer-snapshots.js";
import { type AnalysisEntry } from "./analyzer-contracts.js";

export { screenForAnalysis } from "./analyzer-utils.js";

export class Analyzer {
  cache: Map<string, AnalysisEntry>;
  private seenCount = 0;

  constructor() {
    this.cache = new Map();
  }

  getPaneAnalysis(pane: RawTmuxPane) {
    return localPaneFallbackAnalysis(pane);
  }

  getWindowAnalysis(window: TmuxSnapshotWindow): WindowAnalysis {
    const windowSnapshot = makeWindowSnapshot(window);
    const scopeId = windowSnapshot.windowKey;
    const hash = buildWindowHash(windowSnapshot);
    const existing = this.cache.get(scopeId);
    if (existing?.hash === hash) {
      existing.windowSnapshot = windowSnapshot;
      existing.seen = ++this.seenCount;
      return existing.analysis;
    }

    const fallback = localWindowFallbackAnalysis(windowSnapshot);
    const nextEntry: AnalysisEntry = {
      hash,
      analysis: fallback,
      windowSnapshot,
      updatedAt: Date.now(),
      seen: ++this.seenCount
    };
    this.cache.set(scopeId, nextEntry);

    return fallback;
  }

  /** One pane's latest analysis, from the cached analysis of the window it
   *  is in, with when its output last changed; null for a pane no analysed
   *  window holds. Windows that went away stay cached, so a pane that moved
   *  is read from the window that held it when last seen. */
  getCachedAnalysis(paneId: string): PaneAnalysis | null {
    let latest: AnalysisEntry | null = null;
    for (const entry of this.cache.values()) {
      if (!entry.windowSnapshot.panes.some((pane) => pane.paneId === paneId)) continue;
      if (!latest || entry.seen > latest.seen) latest = entry;
    }
    if (!latest) return null;
    const pane = latest.windowSnapshot.panes.find((item) => item.paneId === paneId)!;
    const analysis = latest.analysis.panes.find((item) => item.paneId === paneId);
    return analysis ? { ...analysis, changedAt: pane.changedAt } : null;
  }
}
