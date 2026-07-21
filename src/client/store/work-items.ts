import { create } from "zustand";
import type { WorkItemDto, WorkItemNeedsUser, WorkItemResponse, WorkItemsListResponse } from "@shared/api/work-items";
import { api } from "@/lib/api-paths";

type WorkItemNeedsUserFilter = WorkItemNeedsUser | "any" | "none";

interface WorkItemRequest {
  order: number;
  items: ReadonlyMap<string, WorkItemDto>;
}

interface WorkItemPagination {
  /** Pass as `before` on next fetch to load older items. Null when no more. */
  nextCursor: string | null;
  /** False once the server returned fewer than `limit` items for this state. */
  hasMore: boolean;
}

interface WorkItemsState {
  items: Map<string, WorkItemDto>;
  /** Per-filter pagination state. Filters not yet fetched are absent. */
  paginationByStatus: Map<string, WorkItemPagination>;

  upsert: (item: WorkItemDto) => void;

  /** Fetch a page of items for the given needsUser filter.
   *  Pass `nextCursor` from a previous fetch as `cursor` to load older items.
   */
  fetchList: (
    needsUser?: WorkItemNeedsUserFilter,
    opts?: { cursor?: string | null; limit?: number }
  ) => Promise<void>;
  fetchDetail: (itemId: string) => Promise<void>;
  /** Fetch the single item bound to a feature. The feature pane's fallback for
   *  when the item is not in the list it already holds — a feature created in
   *  this session, an item beyond the list limit, or a created event that
   *  arrived while this client was disconnected. */
  fetchByFeature: (featureId: string) => Promise<void>;
  patchNeedsUser: (itemId: string, needsUser: WorkItemNeedsUser) => Promise<void>;
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
    paginationByStatus: new Map(),

    upsert: (item) => merge([item]),

    fetchList: async (needsUser = "review", opts = {}) => {
      const limit = opts.limit ?? 50;
      const before = opts.cursor ?? undefined;
      const request = beginRequest();
      const res = await fetch(api.workItems({ needsUser, before, limit }));
      if (!res.ok) return;
      const body = (await res.json()) as WorkItemsListResponse;
      set((s) => {
        // Merge into existing map so items of other filters (e.g. previously
        // fetched items, or items the client received via SSE) survive.
        const items = mergeItems(s.items, body.items, request);
        const paginationByStatus = new Map(s.paginationByStatus);
        const filterKey = needsUser ?? "none";
        paginationByStatus.set(filterKey, {
          nextCursor: body.nextCursor,
          hasMore: body.nextCursor !== null
        });
        return { items, paginationByStatus };
      });
    },

    fetchDetail: async (itemId) => {
      const request = beginRequest();
      const res = await fetch(api.workItem(itemId));
      if (!res.ok) return;
      const body = (await res.json()) as WorkItemResponse;
      merge([body.item], request);
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

    patchNeedsUser: async (itemId: string, needsUser: WorkItemNeedsUser) => {
      const request = beginRequest();
      const res = await fetch(api.workItem(itemId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ needsUser })
      });
      if (!res.ok) return;
      const body = (await res.json()) as WorkItemResponse;
      merge([body.item], request);
    }
  };
});
