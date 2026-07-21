import type { SnapshotVersion } from "../../../shared/api/workspace-snapshot.js";

export type WindowStatus =
  | "working"
  | "waiting_user"
  | "done"
  | "idle_shell"
  | "running_service"
  | "unknown";

export type AnalysisState =
  | "unavailable"
  | "scheduled"
  | "queued"
  | "analyzing"
  | "stale"
  | "failed"
  | "fresh";

type Urgency = "low" | "medium" | "high";

export interface PaneProcessInfo {
  pid: number;
  ppid: number;
  state: string;
  command: string;
}

interface PaneMetadataSnapshot {
  name: string;
  description: string;
  updatedAt: string;
}

export interface RawTmuxSession {
  sessionName: string;
  sessionWindows: number;
  sessionAttached: number;
  created: string;
}

export interface RawTmuxWindow {
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
  windowActive: boolean;
  windowPanes: number;
  windowLayout: string;
  windowZoomed: boolean;
}

export interface RawTmuxClient {
  clientName: string;
  sessionName: string;
  windowId: string;
  paneId: string;
  clientTty: string;
}

export interface RawTmuxPane {
  sessionName: string;
  windowId: string;
  paneId: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  paneActive: boolean;
  windowActive: boolean;
  currentPath: string;
  currentCommand: string;
  paneTitle: string;
  panePid: number;
  paneTty: string;
  paneWidth: number;
  paneHeight: number;
  capture?: string;
  styledCapture?: string;
  captureHash: string;
  changedAt: string;
  preview: string;
  processes: PaneProcessInfo[];
  foregroundProcesses: PaneProcessInfo[];
  metadata?: PaneMetadataSnapshot;
}

export interface RawTmuxState {
  sessions: RawTmuxSession[];
  windows: RawTmuxWindow[];
  panes: RawTmuxPane[];
  clients: RawTmuxClient[];
}

export interface PaneAnalysis {
  paneId?: string;
  paneIndex?: number;
  status: WindowStatus;
  confidence: number;
  taskTitle: string;
  summary: string;
  reason: string;
  suggestedAction: string;
  urgency: Urgency;
  signals: string[];
  pending: boolean;
  stale: boolean;
  analysisState: AnalysisState;
  nextAnalysisAt: string;
  analyzer: string;
  analyzedAt: string;
  updatedAt: string;
  error?: string;
  changedAt?: string;
}

export interface WindowAnalysis extends PaneAnalysis {
  primaryPaneId: string;
  primaryPaneIndex: number;
  panes: PaneAnalysis[];
}

export interface TmuxSnapshotPane extends RawTmuxPane {
  analysis: PaneAnalysis;
}

interface WindowAggregate {
  status: WindowStatus;
  paneId: string;
  paneIndex: number;
  title: string;
  summary: string;
  suggestedAction: string;
  confidence: number;
  urgency: Urgency;
  currentPath: string;
  currentCommand: string;
  pending: boolean;
  stale: boolean;
  analysisState: AnalysisState;
  nextAnalysisAt: string;
}

export interface TmuxSnapshotWindow extends RawTmuxWindow {
  panes: TmuxSnapshotPane[];
  analysis?: WindowAnalysis;
  aggregate: WindowAggregate | null;
}

export interface TmuxSnapshotSession extends RawTmuxSession {
  activeClient: RawTmuxClient | null;
  windows: TmuxSnapshotWindow[];
}

export interface TmuxSnapshot {
  snapshotVersion?: SnapshotVersion;
  generatedAt: string;
  sessions: TmuxSnapshotSession[];
  clients: RawTmuxClient[];
  counts: Record<WindowStatus | "totalWindows", number>;
}

export interface TmuxCaptureOptions {
  forceWindowIds?: Iterable<string>;
  monitorWindowKeys?: Set<string> | null;
}

export interface AnalyzerLike {
  getPaneAnalysis(pane: RawTmuxPane | TmuxSnapshotPane): PaneAnalysis;
  getWindowAnalysis(window: TmuxSnapshotWindow): WindowAnalysis;
}
