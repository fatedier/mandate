export type WorkItemNeedsUser = "review" | "input" | null;
export type WorkItemPhase = "design" | "working" | "verifying" | "done";

/** Which agent last wrote `WorkItemDto.summary`. Both the worker and the
 *  manager can write the same field, so the pane must not assume either. */
export type WorkItemSummaryAuthor = "worker" | "manager";

export interface WorkItemRefSnapshot {
  itemId: string;
  snapshotAt: string;
  title?: string;
  summary?: string | null;
  projectId?: string;
  featureId?: string;
  needsUser?: WorkItemNeedsUser;
  phase?: WorkItemPhase;
  phaseDetail?: string | null;
}

export interface WorkItemDto {
  id: string;
  featureId: string;
  projectId: string;
  title: string;
  summary: string | null;
  needsUser: WorkItemNeedsUser;
  phase: WorkItemPhase;
  phaseDetail: string | null;
  canvasId: string | null;
  /** When `summary`'s text last changed, and who wrote it. Null when unknown
   *  (no summary yet, or a row written before the fields existed) — the UI
   *  omits the corresponding fragment rather than showing "unknown". These
   *  are facts about the write, not a freshness judgement. */
  summaryUpdatedAt: string | null;
  summaryUpdatedBy: WorkItemSummaryAuthor | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemsListResponse {
  items: WorkItemDto[];
  nextCursor: string | null;
}

/** Successful response for both item lookup and needsUser updates. */
export interface WorkItemResponse {
  item: WorkItemDto;
}
