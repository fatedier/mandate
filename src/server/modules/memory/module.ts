import type { MandateModule } from "../module.js";
import {
  API_ROUTES,
  MEMORY_ENTRY_SORTS,
  type MemoryDreamRunDetailResponse,
  type MemoryDreamRunsResponse,
  type MemoryDreamTriggerResponse,
  type MemoryEntriesQuery,
  type MemoryEntriesResponse,
  type MemoryBriefsResponse,
  type MemoryEntryHistoryResponse,
  type MemoryStatsResponse
} from "../../../shared/api-contracts.js";
import { getMemoryStats, listMemoryBriefs, listMemoryEntries, memoryEntryHistory } from "./browse.js";
import { getMemoryDreamRun, listMemoryDreamRuns } from "./dream-runs.js";
import { initializeMemorySchema } from "./schema.js";
import { FeatureRecordStore } from "../plans/record-store.js";
import { buildMemoryToolPacks } from "./tool-packs.js";

export const memoryModule: MandateModule = {
  id: "memory",
  schema: [initializeMemorySchema],
  mountRoutes: (app, { deps }) => {
    app.get(API_ROUTES.memoryDreamRuns, (c) => {
      const limit = Number(c.req.query("limit") || 20);
      const response = {
        runs: listMemoryDreamRuns(deps.store.db, limit)
      } satisfies MemoryDreamRunsResponse;
      return c.json(response);
    });

    app.post(API_ROUTES.memoryDreamRuns, async (c) => {
      const job = deps.memoryDreamJob?.() ?? null;
      if (!job) {
        return c.json({
          ok: false,
          error: "memory dream is disabled or not configured"
        } satisfies MemoryDreamTriggerResponse, 400);
      }
      const result = await job.tick("manual", { force: true });
      return c.json({
        ok: true,
        result
      } satisfies MemoryDreamTriggerResponse);
    });

    app.get(API_ROUTES.memoryDreamRun, (c) => {
      const detail = getMemoryDreamRun(deps.store.db, c.req.param("id"));
      if (!detail) {
        return c.json({ error: "not found" } satisfies MemoryDreamRunDetailResponse, 404);
      }
      return c.json(detail satisfies MemoryDreamRunDetailResponse);
    });

    app.get(API_ROUTES.memoryEntries, (c) => {
      const query: MemoryEntriesQuery = {
        scope: parseEnum(c.req.query("scope"), ["user", "project", "all"]),
        projectId: c.req.query("projectId") || undefined,
        type: parseEnum(c.req.query("type"), ["preference", "knowledge", "all"]),
        source: parseEnum(c.req.query("source"), ["user", "agent", "extraction", "all"]),
        status: parseEnum(c.req.query("status"), ["available", "archived", "all"]),
        forgotten: c.req.query("forgotten") === "1",
        learned: c.req.query("learned") === "1",
        updated: c.req.query("updated") === "1",
        sort: parseEnum(c.req.query("sort"), MEMORY_ENTRY_SORTS),
        q: c.req.query("q") || undefined,
        limit: parseIntOrUndefined(c.req.query("limit")),
        offset: parseIntOrUndefined(c.req.query("offset"))
      };
      const response = listMemoryEntries(deps.store.db, query) satisfies MemoryEntriesResponse;
      return c.json(response);
    });

    app.get(API_ROUTES.memoryBriefs, (c) => c.json(listMemoryBriefs(deps.store.db) satisfies MemoryBriefsResponse));

    app.get(API_ROUTES.memoryEntryHistory, (c) => {
      const history = memoryEntryHistory(deps.store.db, c.req.param("id"));
      if (!history) return c.json({ error: "not found" }, 404);
      return c.json(history satisfies MemoryEntryHistoryResponse);
    });

    app.get(API_ROUTES.memoryStats, (c) => {
      const response = getMemoryStats(deps.store.db) satisfies MemoryStatsResponse;
      return c.json(response);
    });
  },
  commonToolPacks: (ctx) => buildMemoryToolPacks({
    scope: ctx.scope,
    memory: ctx.memory,
    agentStore: ctx.agentStore,
    projectsStore: ctx.projectsStore,
    records: ctx.store ? new FeatureRecordStore(ctx.store.db) : null
  })
};

function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  if (!value) return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
