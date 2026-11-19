import type { WorkItem } from "./work-item-store.js";
import type { WorkItemDto } from "../../../shared/api/work-items.js";

export function toWorkItemDto(item: WorkItem): WorkItemDto {
  return {
    id: item.id,
    workerId: item.workerId,
    projectId: item.projectId,
    title: item.title,
    lastActivityAt: item.lastActivityAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    failedAt: item.failedAt,
    failedMessage: item.failedMessage,
    failedKind: item.failedKind
  };
}
