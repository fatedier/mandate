import type { MandateModule } from "../module.js";
import {
  API_ROUTES,
  MEMORY_ENTRY_SORTS,
  MEMORY_USAGE_FILTERS,
  type MemoryDreamRunDetailResponse,
  type MemoryDreamRunsResponse,
  type MemoryDreamTriggerResponse,
  type MemoryEntriesQuery,
  type MemoryEntriesResponse,
  type MemoryStatsResponse
} from "../../../shared/api-contracts.js";
import { getMemoryStats, listMemoryEntries } from "./browse.js";
import { getMemoryDreamRun, listMemoryDreamRuns } from "./dream.js";
import { initializeMemorySchema } from "./schema.js";
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
        scope: parseEnum(c.req.query("scope"), ["user", "global", "project", "feature", "all"]),
        projectId: c.req.query("projectId") || undefined,
        featureId: c.req.query("featureId") || undefined,
        kind: parseEnum(c.req.query("kind"), ["episodic", "semantic", "preference", "procedural", "all"]),
        status: parseEnum(c.req.query("status"), ["available", "archived", "all"]),
        usage: parseEnum(c.req.query("usage"), MEMORY_USAGE_FILTERS),
        sort: parseEnum(c.req.query("sort"), MEMORY_ENTRY_SORTS),
        q: c.req.query("q") || undefined,
        limit: parseIntOrUndefined(c.req.query("limit")),
        offset: parseIntOrUndefined(c.req.query("offset"))
      };
      const response = listMemoryEntries(deps.store.db, query) satisfies MemoryEntriesResponse;
      return c.json(response);
    });

    app.get(API_ROUTES.memoryStats, (c) => {
      const response = getMemoryStats(deps.store.db) satisfies MemoryStatsResponse;
      return c.json(response);
    });
  },
  commonToolPacks: (ctx) => buildMemoryToolPacks({
    scope: ctx.scope,
    memory: ctx.memory
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
