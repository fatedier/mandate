import type { ApiErrorResponse } from "./common.js";

export interface SessionPaneDto {
  paneId: string;
  index: number;
  active: boolean;
  currentCommand: string;
  currentPath: string;
  metadata?: {
    name: string;
    description: string;
    updatedAt: string;
  };
}

export interface SessionWindowDto {
  name: string;
  windowId: string;
  index: number;
  active: boolean;
  panes: SessionPaneDto[];
}

export interface SessionDto {
  name: string;
  windows: SessionWindowDto[];
  ownership: "managed" | "unmanaged";
  projectId: string | null;
  projectName: string | null;
}

export interface WindowDetailDto {
  sessionName: string;
  name: string;
  windowId: string;
  index: number;
  active: boolean;
  windowLayout: string;
  panes: Array<SessionPaneDto & { preview: string }>;
}

export type TmuxSessionsResponse = {
  sessions: SessionDto[];
};

export type SessionWindowResponse = {
  window: WindowDetailDto;
} | ApiErrorResponse;
