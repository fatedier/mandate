import type { ApiErrorResponse } from "./common.js";

export interface PaneLookupDto {
  paneId: string;
  sessionName: string;
  windowName: string;
  windowId: string;
  windowIndex: number;
  paneIndex: number;
  active: boolean;
  currentCommand: string;
  currentPath: string;
  paneWidth: number;
  paneHeight: number;
  projectId: string | null;
  metadata?: {
    name: string;
    description: string;
    updatedAt: string;
  };
}

export type PaneByIdResponse = PaneLookupDto | ApiErrorResponse;
export type PaneSplitDirection = "right" | "down";

export interface PaneSplitRequest {
  direction?: PaneSplitDirection;
  name?: string;
  description?: string;
}

export type PaneKillResponse = {
  ok: true;
} | ApiErrorResponse;
