import type { SnapshotVersion } from "@shared/api/workspace-snapshot";

export type WindowStatus =
  | "working"
  | "waiting_user"
  | "done"
  | "running_service"
  | "idle_shell"
  | "unknown";

interface PaneAnalysis {
  paneId?: string;
  paneIndex?: number;
  status?: WindowStatus;
  confidence?: number;
  taskTitle?: string;
  summary?: string;
}

interface WindowAggregate {
  status?: WindowStatus;
  title?: string;
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
  analysis?: PaneAnalysis;
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
  panes?: SnapshotPane[];
  changedAt?: string;
}

export interface SnapshotSession {
  sessionName?: string;
  sessionWindows?: number;
  sessionAttached?: number;
  created?: string;
  windows?: SnapshotWindow[];
}

export interface TypedSnapshot {
  snapshotVersion?: SnapshotVersion;
  generatedAt?: string;
  sessions?: SnapshotSession[];
}
