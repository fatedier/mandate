import type {
  AnalysisState,
  RawTmuxPane,
  WindowAnalysis
} from "../../platform/tmux/tmux-types.js";

export const PENDING_ANALYSIS_STATES = new Set<AnalysisState>([
  "scheduled",
  "queued",
  "analyzing",
  "stale"
]);

export interface AnalyzerPaneSnapshot {
  paneId: string;
  paneIndex: number;
  metadata?: {
    name: string;
    description: string;
    updatedAt: string;
  };
  sessionName: string;
  windowIndex: number;
  windowName: string;
  currentPath: string;
  currentCommand: string;
  paneActive: boolean;
  paneWidth: number;
  paneHeight: number;
  changedAt: string;
  captureHash: string;
  preview: string;
  processes: RawTmuxPane["processes"];
  foregroundProcesses: RawTmuxPane["foregroundProcesses"];
  capture: string;
  styledCapture: string;
}

export interface AnalyzerWindowSnapshot {
  windowId: string;
  windowKey: string;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  windowActive: boolean;
  windowPanes: number;
  windowLayout: string;
  windowZoomed: boolean;
  panes: AnalyzerPaneSnapshot[];
}

export interface AnalysisEntry {
  hash: string;
  analysis: WindowAnalysis;
  windowSnapshot: AnalyzerWindowSnapshot;
  updatedAt: number;
}
