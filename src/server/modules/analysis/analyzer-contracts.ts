import type {
  RawTmuxPane,
  WindowAnalysis
} from "../../platform/tmux/tmux-types.js";

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
  /** The window as last seen, which a cache hit refreshes: the hash leaves
   *  out what does not change the verdict, such as each pane's changedAt. */
  windowSnapshot: AnalyzerWindowSnapshot;
  updatedAt: number;
  /** Order in which windows were last seen, cache hits included. */
  seen: number;
}
