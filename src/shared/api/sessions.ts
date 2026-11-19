import type { ApiErrorResponse } from "./common.js";

export interface SessionPaneDto {
  paneId: string;
  index: number;
  active: boolean;
  currentCommand: string;
  currentPath: string;
  /** The title the program in the pane set (tmux `pane_title`); null when
   *  empty or tmux's default, the host name. */
  title: string | null;
  /** The pane's first process: with the id, it names this pane and no later
   *  one that reuses the id after tmux restarts. */
  pid: number;
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

/** A pane the user pinned to the Terminals page's tab row. */
export interface TerminalPinDto {
  paneId: string;
  pid: number;
  pinnedAt: string;
}

/** The Terminals page: every tmux session, and the pins in the order made. */
export type TerminalsResponse = { sessions: SessionDto[]; pins: TerminalPinDto[] } | ApiErrorResponse;

export type TerminalPinsResponse = { pins: TerminalPinDto[] } | ApiErrorResponse;

/** POST /api/terminals: the new shell's pane. */
export type NewTerminalResponse = { paneId: string; pid: number } | ApiErrorResponse;

export type SessionWindowResponse = {
  window: WindowDetailDto;
} | ApiErrorResponse;
