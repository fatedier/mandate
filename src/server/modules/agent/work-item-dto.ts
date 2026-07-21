import type { WorkItem } from "./work-item-store.js";
import type { WorkItemDto } from "../../../shared/api/work-items.js";

export function toWorkItemDto(item: WorkItem): WorkItemDto {
  return {
    id: item.id,
    featureId: item.featureId,
    projectId: item.projectId,
    title: item.title,
    summary: item.summary,
    needsUser: item.needsUser,
    phase: item.phase,
    phaseDetail: item.phaseDetail,
    canvasId: item.canvasId,
    summaryUpdatedAt: item.summaryUpdatedAt,
    summaryUpdatedBy: item.summaryUpdatedBy,
    lastActivityAt: item.lastActivityAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}
