import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { StoredWatch, WindowWatchManager } from "../window-watch-manager.js";

interface WatchSummary {
  watchId: string;
  paneId: string;
  windowKey: string;
  stableMs: number;
  note: string;
  createdAt: string;
  timeoutAt: string;
}

interface CancelWatchResult {
  ok: true;
  watchId: string;
}

const cancelParams = z.object({
  watchId: z.string().min(1)
});

const listParams = z.object({});

export function buildListMyWatchesTool(
  manager: WindowWatchManager
): ToolDefinition<z.infer<typeof listParams>, { watches: WatchSummary[] }> {
  return {
    name: "list_my_watches",
    description:
      "List the window watches registered on YOUR OWN thread, each with its " +
      "watchId, paneId, windowKey, stableMs, note, createdAt, and timeoutAt " +
      "— watchId is what cancel_watch takes. There is no history to browse " +
      "— a watch's row is deleted the moment it fires or is canceled, so " +
      "this only ever shows watches that are still pending.",
    parameters: listParams,
    approval: "never",
    handler: async (_input, ctx) => ({
      watches: manager.list(ctx.threadId).map(watchSummary)
    })
  };
}

export function buildCancelWatchTool(
  manager: WindowWatchManager
): ToolDefinition<z.infer<typeof cancelParams>, CancelWatchResult | { error: string }> {
  return {
    name: "cancel_watch",
    description:
      "Cancel a pending window watch by id (must be on YOUR OWN thread). Use " +
      "this if the watched work is no longer worth waiting on.",
    parameters: cancelParams,
    approval: "never",
    handler: async (input, ctx) => {
      const result = manager.cancel(input.watchId, ctx.threadId);
      if (!result) return { error: `watch not found: ${input.watchId}` };
      return {
        ok: true,
        watchId: result.id
      };
    }
  };
}

function watchSummary(watch: StoredWatch): WatchSummary {
  return {
    watchId: watch.id,
    paneId: watch.paneId,
    windowKey: watch.windowKey,
    stableMs: watch.stableMs,
    note: watch.note,
    createdAt: new Date(watch.createdAtMs).toISOString(),
    timeoutAt: new Date(watch.timeoutAtMs).toISOString()
  };
}
