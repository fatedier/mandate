import { SSE_EVENTS } from "../../../shared/api/sse.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { WorkItemChangeEvent, WorkItemChangeListener } from "./work-item-events.js";
import { toWorkItemDto } from "./work-item-dto.js";
import type { WorkItemStore } from "./work-item-store.js";

interface WorkItemCreatedBroadcastDeps {
  workStore: Pick<WorkItemStore, "get" | "onChange">;
  /** The features store, which is where work items are actually born:
   *  features.insert() writes the feature and its bound work item in one
   *  transaction. */
  featuresStore: { onWorkItemChange(listener: WorkItemChangeListener): () => void };
  sse: Pick<AgentSseEmitter, "emit">;
}

/** Put newly created work items on the SSE wire.
 *
 *  The client has always had a `workItemCreated` listener; nothing ever fired
 *  it, because work items are created inside features.insert() rather than
 *  through the work-item tools that emit their own updates. A freshly created
 *  feature therefore had no item on any open client until the next full list
 *  fetch, and its pane read "no work item for this feature".
 *
 *  The change event from features.insert() carries ids only, so the row is
 *  re-read here to build the DTO. Returns an unsubscribe. */
export function broadcastWorkItemCreated(deps: WorkItemCreatedBroadcastDeps): () => void {
  const publish = (event: WorkItemChangeEvent) => {
    if (event.kind !== "created") return;
    const item = event.item ?? deps.workStore.get(event.itemId);
    if (item) deps.sse.emit(SSE_EVENTS.workItemCreated, { item: toWorkItemDto(item) });
  };

  // Registered on both stores because they are separate objects under some
  // wirings. In production they share a single WorkItemChangeEmitter, whose
  // listener Set silently drops the second registration of this same function
  // reference — so a create fires exactly one event either way.
  const unsubscribers = [
    deps.workStore.onChange(publish),
    deps.featuresStore.onWorkItemChange(publish)
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
