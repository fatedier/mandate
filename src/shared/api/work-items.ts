export interface WorkItemDto {
  id: string;
  featureId: string;
  projectId: string;
  title: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  /** When this worker's last wake ended in an error or a stop; null once a later wake finished. */
  failedAt: string | null;
  failedMessage: string | null;
  /** Which: an error ("Failed") or a stop for a repeated failing call ("Stopped"). */
  failedKind: "error" | "stopped" | null;
}

export interface WorkItemsListResponse {
  items: WorkItemDto[];
  nextCursor: string | null;
}

/** A worker's item, as acknowledging it answers. */
export interface WorkItemResponse {
  item: WorkItemDto;
}
