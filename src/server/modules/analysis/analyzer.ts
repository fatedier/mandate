import type {
  AnalysisState,
  TmuxSnapshotWindow,
  RawTmuxPane,
  WindowAnalysis
} from "../../platform/tmux/tmux-types.js";
import {
  localPaneFallbackAnalysis,
  localWindowFallbackAnalysis,
  withAnalysisState
} from "./analyzer-normalization.js";
import { buildWindowHash, makeWindowSnapshot } from "./analyzer-snapshots.js";
import { type AnalysisEntry } from "./analyzer-contracts.js";

export { screenForAnalysis } from "./analyzer-utils.js";

export class Analyzer {
  cache: Map<string, AnalysisEntry>;

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
      return this.analysisForClient(existing);
    }

    const fallback = localWindowFallbackAnalysis(windowSnapshot);
    const nextEntry: AnalysisEntry = {
      hash,
      analysis: fallback,
      windowSnapshot,
      updatedAt: Date.now()
    };
    this.cache.set(scopeId, nextEntry);

    return this.analysisForClient(nextEntry);
  }

  analysisForClient(entry: AnalysisEntry): WindowAnalysis {
    const state = this.analysisStateFor(entry);
    return withAnalysisState(entry?.analysis, state, {
      stale: Boolean(entry?.analysis?.stale)
    });
  }

  analysisStateFor(entry: AnalysisEntry): AnalysisState {
    const analysis = entry?.analysis;
    if (!analysis) {
      return "unavailable";
    }
    if (analysis.error) {
      return "failed";
    }
    if (analysis.stale || analysis.pending) {
      return "stale";
    }
    if (analysis.analyzer === "local-fallback") {
      return "unavailable";
    }
    return analysis.analysisState || "fresh";
  }
}
