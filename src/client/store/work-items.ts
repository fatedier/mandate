import { create } from "zustand";
import type { WorkItemDto, WorkItemResponse, WorkItemsListResponse } from "@shared/api/work-items";
import { api } from "@/lib/api-paths";

interface WorkItemRequest {
  order: number;
  items: ReadonlyMap<string, WorkItemDto>;
}

interface WorkItemsState {
  items: Map<string, WorkItemDto>;

  upsert: (item: WorkItemDto) => void;

  /** Fetch the newest items, up to `limit`. */
  fetchList: (opts?: { limit?: number }) => Promise<void>;
  /** Fetch the single item bound to a feature. The feature pane's fallback for
   *  when the item is not in the list it already holds — a feature created in
   *  this session, an item beyond the list limit, or a created event that
   *  arrived while this client was disconnected. */
  fetchByFeature: (featureId: string) => Promise<void>;
  /** The page's acknowledge control: the worker's questions go. */
  acknowledge: (itemId: string) => Promise<void>;
}

/** Whether a feature's work item — its status — has arrived. */
export function hasWorkItemFor(featureId: string): boolean {
  for (const item of useWorkItemsStore.getState().items.values()) if (item.featureId === featureId) return true;
  return false;
}

export const useWorkItemsStore = create<WorkItemsState>((set, get) => {
  let requestOrder = 0;
  const httpOrders = new WeakMap<WorkItemDto, number>();
  const beginRequest = (): WorkItemRequest => ({ order: ++requestOrder, items: get().items });

  // Equal timestamps can represent different writes within one millisecond.
  // HTTP ties preserve intervening SSE updates and responses to later requests,
  // while allowing a later request to replace an earlier HTTP result.
  // SSE ties still apply in stream order. Weak keys release provenance when
  // an item is replaced, without retaining a second copy of the item cache.
  const mergeItems = (
    current: Map<string, WorkItemDto>,
    incoming: WorkItemDto[],
    request?: WorkItemRequest
  ): Map<string, WorkItemDto> => {
    let items = current;
    for (const item of incoming) {
      const held = items.get(item.id);
      if (held) {
        const at = Date.parse(item.updatedAt);
        const heldAt = Date.parse(held.updatedAt);
        if (Number.isNaN(at) || at < heldAt) continue;
        if (at === heldAt && request && held !== request.items.get(item.id)) {
          const heldOrder = httpOrders.get(held);
          if (heldOrder === undefined || heldOrder >= request.order) continue;
        }
      }
      if (held === item) continue;
      if (items === current) items = new Map(current);
      items.set(item.id, item);
      if (request) httpOrders.set(item, request.order);
      else httpOrders.delete(item);
    }
    return items;
  };

  const merge = (incoming: WorkItemDto[], request?: WorkItemRequest) =>
    set((s) => {
      const items = mergeItems(s.items, incoming, request);
      return items === s.items ? s : { items };
    });

  return {
    items: new Map(),

    upsert: (item) => merge([item]),

    fetchList: async (opts = {}) => {
      const request = beginRequest();
      const res = await fetch(api.workItems({ limit: opts.limit ?? 50 }));
      if (!res.ok) return;
      const body = (await res.json()) as WorkItemsListResponse;
      // Merged into what is held, so items fetched before or received over
      // SSE survive.
      merge(body.items, request);
    },

    fetchByFeature: async (featureId) => {
      if (!featureId) return;
      const request = beginRequest();
      const res = await fetch(api.workItems({ featureId }));
      if (!res.ok) return;
      const body = (await res.json()) as WorkItemsListResponse;
      // A response for another feature must never attach its item to this pane.
      merge(body.items.filter((item) => item.featureId === featureId), request);
    },

    acknowledge: async (itemId: string) => {
      const request = beginRequest();
      const res = await fetch(api.workItemAcknowledge(itemId), { method: "POST" });
      if (!res.ok) return;
      const body = (await res.json()) as WorkItemResponse;
      merge([body.item], request);
    }
  };
});
