import type { AgentScope } from "./agents.js";
import type { ApiErrorResponse } from "./common.js";

export type CanvasKind = "html";

export interface CanvasDocumentDto {
  id: string;
  title: string;
  kind: CanvasKind;
  html: string;
  /** Advances on publication, including asset-only changes; omitted by older servers. */
  contentRevision?: number;
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

export type CanvasDocumentResponse = {
  canvas: CanvasDocumentDto;
} | ApiErrorResponse;

export interface CanvasEventRequest {
  action: string;
  data?: unknown;
}

export type CanvasEventResponse = {
  ok: true;
  threadId: string;
  messageId: string | null;
  wakeId: string | null;
  queued?: boolean;
} | ApiErrorResponse;
