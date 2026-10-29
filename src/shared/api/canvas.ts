import type { AgentScope } from "./agents.js";
import type { ApiErrorResponse } from "./common.js";

/** A report is one page to read; a design is artboards to look at and choose between. */
export type CanvasKind = "report" | "design";

/** A design canvas's page. The index always has at least one:
 *  `{id: "main", name: ""}` when it declares none. */
export interface DesignPage {
  id: string;
  name: string;
}

/** One artboard, normalized from canvas.json's `boards` entry. */
export interface DesignBoard {
  /** Its file's path in the canvas folder, the key in canvas.json. */
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string | null;
  page: string;
  expand: "fill" | null;
  interactive: boolean;
  radius: number;
}

export type DesignNoteKind = "title1" | "sticky";

export interface DesignNote {
  id: string;
  kind: DesignNoteKind;
  x: number;
  y: number;
  text: string;
  page: string;
  w: number | null;
  maxW: number | null;
  maxH: number | null;
  size: string | number | null;
  bold: boolean;
  italic: boolean;
  color: string | null;
  fill: string | null;
}

export type DesignLaunch = { view: "canvas"; page: string } | { view: "focused"; path: string };

export interface DesignIndex {
  title: string | null;
  pages: DesignPage[];
  /** In canvas.json's `order`, back to front. */
  boards: DesignBoard[];
  notes: DesignNote[];
  launch: DesignLaunch;
}

/** What a design's publish stores: the normalized index and every artboard's page. */
export interface DesignSnapshot {
  index: DesignIndex;
  artboards: Record<string, string>;
}

export interface CanvasDocumentDto {
  id: string;
  title: string;
  kind: CanvasKind;
  html: string;
  /** A published design: its normalized index and every artboard's page. `html` is "" for a design. */
  design?: DesignSnapshot;
  /** Advances on publication, including asset-only changes. */
  contentRevision: number;
  scope: AgentScope;
  scopeId: string | null;
  projectId: string | null;
  projectName: string | null;
  projectSlug: string | null;
  featureId: string | null;
  featureName: string | null;
  featureSlug: string | null;
  threadId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasListItemDto {
  id: string;
  title: string;
  kind: CanvasKind;
  scope: AgentScope;
  scopeId: string | null;
  threadId: string;
  createdAt: string;
  updatedAt: string;
  projectId: string | null;
  projectName: string | null;
  projectSlug: string | null;
  featureId: string | null;
  featureName: string | null;
  featureSlug: string | null;
}

/** All canvases scoped to a single feature (newest first). Unpaginated —
 *  a feature accumulates few canvases. */
export type FeatureCanvasesResponse = {
  canvases: CanvasListItemDto[];
} | ApiErrorResponse;

/** A manager thread's canvases (newest first): the manager's own and those of
 *  every worker the thread owns, archived ones too. Unpaginated, as a
 *  feature's. */
export type ThreadCanvasesResponse = {
  canvases: CanvasListItemDto[];
} | ApiErrorResponse;

export type CanvasDocumentResponse = {
  canvas: CanvasDocumentDto;
} | ApiErrorResponse;

/** A canvas's name, for a path to it written in a conversation. */
export interface CanvasTitleDto {
  id: string;
  title: string;
  kind: CanvasKind;
}

/** GET /api/canvases/titles?ids=…: the canvases among those asked for that
 *  are there (at most CANVAS_TITLES_MAX at once). */
export type CanvasTitlesResponse = {
  canvases: CanvasTitleDto[];
} | ApiErrorResponse;

export const CANVAS_TITLES_MAX = 50;

/** A canvas's id as newId makes it: `cnv_` and eleven letters, digits, `-`
 *  or `_`. Nothing else names a canvas whose title can be read. */
export const CANVAS_ID = /^cnv_[A-Za-z0-9_-]{11}$/;

/** DELETE /api/canvas/:id: the canvas and its files are gone, for good. */
export type DeleteCanvasResponse = { ok: true } | ApiErrorResponse;
