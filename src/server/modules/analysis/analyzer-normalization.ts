import { nowIso } from "../../platform/time/time.js";
import type {
  PaneAnalysis,
  RawTmuxPane,
  WindowAnalysis
} from "../../platform/tmux/tmux-types.js";
import {
  PENDING_ANALYSIS_STATES,
  type AnalyzerPaneSnapshot,
  type AnalyzerWindowSnapshot
} from "./analyzer-contracts.js";
import { limitText } from "./analyzer-utils.js";
import { extractWindowFacts } from "./analyzer-window-facts.js";

export function withAnalysisState(
  analysis: WindowAnalysis,
  state: WindowAnalysis["analysisState"],
  options: { stale?: boolean; nextAnalysisAt?: string } = {}
): WindowAnalysis {
  if (!analysis) {
    return analysis;
  }
  const stale = Boolean(options.stale);
  return {
    ...analysis,
    pending: PENDING_ANALYSIS_STATES.has(state),
    stale,
    analysisState: state,
    nextAnalysisAt: options.nextAnalysisAt || ""
  };
}

export function localWindowFallbackAnalysis(window: AnalyzerWindowSnapshot): WindowAnalysis {
  const primaryPane = window.panes.find((pane) => pane.paneActive) || window.panes[0] || null;
  const analyzedAt = nowIso();

  // Compute status from local deterministic heuristics (process inspection +
  // screen content). This keeps the dashboard pane dot and watch_window
  // triggers useful without an LLM-backed analyzer.
  const facts = extractWindowFacts(window);
  const status = facts.deterministicStatus || "unknown";
  const confidence = facts.deterministicStatus ? facts.deterministicConfidence : 0.1;
  const reason = facts.deterministicReason || "Deterministic facts did not match any heuristic.";

  return {
    status,
    confidence,
    taskTitle: limitText(`${window.sessionName}:${window.windowIndex}: ${window.windowName}`, 90),
    summary: "",
    reason,
    suggestedAction: "",
    urgency: "low",
    signals: facts.deterministicEvidence,
    primaryPaneId: primaryPane?.paneId || "",
    primaryPaneIndex: primaryPane?.paneIndex ?? 0,
    panes: window.panes.map((pane) => localPaneFallbackAnalysis(pane)),
    pending: false,
    stale: false,
    analysisState: "unavailable",
    nextAnalysisAt: "",
    analyzer: "local-fallback",
    analyzedAt,
    updatedAt: analyzedAt
  };
}

export function localPaneFallbackAnalysis(pane: AnalyzerPaneSnapshot | RawTmuxPane): PaneAnalysis {
  const taskTitle = pane.metadata?.name
    || (pane.windowName
    ? `${pane.sessionName}:${pane.windowIndex}: ${pane.windowName}`
    : pane.currentCommand);
  const commandContext = [pane.currentCommand, pane.currentPath].filter(Boolean).join(" in ");
  const analyzedAt = nowIso();

  return {
    paneId: pane.paneId,
    paneIndex: pane.paneIndex,
    status: "unknown",
    confidence: 0.1,
    taskTitle: limitText(taskTitle, 90),
    summary: limitText(commandContext || "No window analysis is available.", 260),
    reason: "This pane has no captured screen content; no local status inference is applied.",
    suggestedAction: "",
    urgency: "low",
    signals: [],
    pending: false,
    stale: false,
    analysisState: "unavailable",
    nextAnalysisAt: "",
    analyzer: "local-fallback",
    analyzedAt,
    updatedAt: analyzedAt
  };
}
