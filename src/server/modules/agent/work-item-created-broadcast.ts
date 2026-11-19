import { SSE_EVENTS } from "../../../shared/api/sse.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { WorkItemChangeEvent, WorkItemChangeListener } from "./work-item-events.js";
import { toWorkItemDto } from "./work-item-dto.js";
import type { WorkItemStore } from "./work-item-store.js";

interface WorkItemCreatedBroadcastDeps {
  workStore: Pick<WorkItemStore, "get">;
  /** The workers store, which is where work items are actually born:
   *  workers.insert() writes the worker and its bound work item in one
   *  transaction. */
  workersStore: { onWorkItemChange(listener: WorkItemChangeListener): () => void };
  sse: Pick<AgentSseEmitter, "emit">;
}

/** Put newly created work items on the SSE wire.
 *
 *  Work items are created inside workers.insert(), not through the work-item
 *  tools that emit their own updates, so without this an open client would
 *  show a new worker with no item until its next full list fetch.
 *
 *  The change event from workers.insert() carries ids only, so the row is
 *  re-read here to build the DTO. Returns an unsubscribe. */
export function broadcastWorkItemCreated(deps: WorkItemCreatedBroadcastDeps): () => void {
  const publish = (event: WorkItemChangeEvent) => {
    if (event.kind !== "created") return;
    const item = deps.workStore.get(event.itemId);
    if (item) deps.sse.emit(SSE_EVENTS.workItemCreated, { item: toWorkItemDto(item) });
  };

  return deps.workersStore.onWorkItemChange(publish);
}
