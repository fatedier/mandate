import type { SnapshotVersion } from "@shared/api/workspace-snapshot";

export type WindowStatus =
  | "working"
  | "waiting_user"
  | "done"
  | "running_service"
  | "idle_shell"
  | "unknown";

interface WindowAnalysis {
  status?: WindowStatus;
  confidence?: number;
  taskTitle?: string;
  summary?: string;
  reason?: string;
  suggestedAction?: string;
  urgency?: "low" | "medium" | "high";
  signals?: unknown[];
  pending?: boolean;
  stale?: boolean;
}

interface WindowAggregate extends WindowAnalysis {
  paneId?: string;
  paneIndex?: number;
  title?: string;
  currentPath?: string;
  currentCommand?: string;
  analysisState?: "fresh" | "stale" | "scheduled" | "queued" | "analyzing" | "failed";
  nextAnalysisAt?: string;
}

interface PaneProcess {
  pid?: number;
  ppid?: number;
  state?: string;
  command?: string;
}

export interface SnapshotPane {
  sessionName?: string;
  windowId?: string;
  paneId?: string;
  windowIndex?: number;
  windowName?: string;
  paneIndex?: number;
  paneActive?: boolean;
  windowActive?: boolean;
  currentPath?: string;
  currentCommand?: string;
  paneTitle?: string;
  panePid?: number;
  paneTty?: string;
  paneWidth?: number;
  paneHeight?: number;
  captureHash?: string;
  changedAt?: string;
  preview?: string;
  processes?: PaneProcess[];
  foregroundProcesses?: PaneProcess[];
  metadata?: {
    name: string;
    description: string;
    updatedAt: string;
  };
  analysis?: WindowAnalysis & { paneId?: string; paneIndex?: number };
}

export interface SnapshotWindow {
  sessionName?: string;
  windowId?: string;
  windowIndex?: number;
  windowName?: string;
  windowActive?: boolean;
  windowPanes?: number;
  windowLayout?: string;
  windowZoomed?: boolean;
  aggregate?: WindowAggregate;
  analysis?: WindowAnalysis;
  panes?: SnapshotPane[];
  changedAt?: string;
}

export interface SnapshotSession {
  sessionName?: string;
  sessionWindows?: number;
  sessionAttached?: number;
  created?: string;
  activeClient?: unknown;
  windows?: SnapshotWindow[];
}

interface StatusCounts {
  totalWindows?: number;
  working?: number;
  waiting_user?: number;
  done?: number;
  running_service?: number;
  idle_shell?: number;
  unknown?: number;
}

export interface TypedSnapshot {
  snapshotVersion?: SnapshotVersion;
  generatedAt?: string;
  sessions?: SnapshotSession[];
  clients?: unknown[];
  counts?: StatusCounts;
  analyzer?: unknown;
}
