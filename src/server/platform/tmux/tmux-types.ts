import type { SnapshotVersion } from "../../../shared/api/workspace-snapshot.js";

export type WindowStatus =
  | "working"
  | "waiting_user"
  | "done"
  | "idle_shell"
  | "running_service"
  | "unknown";

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
}

/** What the pane dot, get_worker_status and pane_status read of a pane;
 *  changedAt only on a cached read (when its output last changed). */
export interface PaneAnalysis {
  paneId: string;
  paneIndex: number;
  status: WindowStatus;
  confidence: number;
  taskTitle: string;
  summary: string;
  changedAt?: string;
}

export interface WindowAnalysis {
  status: WindowStatus;
  taskTitle: string;
  panes: PaneAnalysis[];
}

/** A window with its panes, before analysis. */
export interface WindowToAnalyze extends RawTmuxWindow {
  panes: RawTmuxPane[];
}

export interface TmuxSnapshotPane extends RawTmuxPane {
  analysis: PaneAnalysis;
}

/** The window's status and title, as the page and get_worker_status read them. */
interface WindowAggregate {
  status: WindowStatus;
  title: string;
}

export interface TmuxSnapshotWindow extends RawTmuxWindow {
  panes: TmuxSnapshotPane[];
  aggregate: WindowAggregate;
}

export interface TmuxSnapshotSession extends RawTmuxSession {
  windows: TmuxSnapshotWindow[];
}

export interface TmuxSnapshot {
  snapshotVersion?: SnapshotVersion;
  generatedAt: string;
  sessions: TmuxSnapshotSession[];
}

export interface TmuxCaptureOptions {
  forceWindowIds?: Iterable<string>;
  monitorWindowKeys?: Set<string> | null;
  /** Captures kept between polls (pane-capture-cache.ts); without it every
   *  pane the rules pick is captured. */
  captureCache?: import("./pane-capture-cache.js").PaneCaptureCache;
}

export interface AnalyzerLike {
  getWindowAnalysis(window: WindowToAnalyze): WindowAnalysis;
}
