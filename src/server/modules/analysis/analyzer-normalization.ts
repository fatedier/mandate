import { nowIso } from "../../platform/time/time.js";
import type {
  PaneAnalysis,
  RawTmuxPane,
  WindowAnalysis
} from "../../platform/tmux/tmux-types.js";
import {
  type AnalyzerPaneSnapshot,
  type AnalyzerWindowSnapshot
} from "./analyzer-contracts.js";
import { limitText } from "./analyzer-utils.js";
import { extractWindowFacts, type AnalyzerWindowFacts } from "./analyzer-window-facts.js";

export function localWindowFallbackAnalysis(window: AnalyzerWindowSnapshot): WindowAnalysis {
  const primaryPane = window.panes.find((pane) => pane.paneActive) || window.panes[0] || null;
  const analyzedAt = nowIso();

  // Compute status from local deterministic heuristics (process inspection +
  // screen content). This keeps the dashboard pane dot and pane monitor
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
    signals: facts.deterministicEvidence,
    primaryPaneId: primaryPane?.paneId || "",
    primaryPaneIndex: primaryPane?.paneIndex ?? 0,
    panes: facts.panes.map((fact) => paneAnalysisFromFacts(fact)),
    analyzer: "local-fallback",
    analyzedAt,
    updatedAt: analyzedAt
  };
}

/** A pane's analysis from the facts the window's verdict is drawn from: the
 *  status its own screen, processes and output recency decide, or the plain
 *  fallback (unknown) when none of the heuristics matched it. */
function paneAnalysisFromFacts(fact: AnalyzerWindowFacts["panes"][number]): PaneAnalysis {
  const fallback = localPaneFallbackAnalysis(fact.pane);
  if (!fact.localStatus) return fallback;
  return {
    ...fallback,
    status: fact.localStatus,
    confidence: fact.localConfidence,
    reason: fact.localReason,
    signals: fact.evidence
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
    signals: [],
    analyzer: "local-fallback",
    analyzedAt,
    updatedAt: analyzedAt
  };
}
