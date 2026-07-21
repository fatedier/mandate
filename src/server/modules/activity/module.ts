import type { MandateModule } from "../module.js";
import {
  ACTIVITY_GROUP_KEYS,
  API_ROUTES,
  type ActivityGroupKey,
  type LlmCallDetailResponse,
  type LlmCallSummaryDto,
  type LlmCallsResponse
} from "../../../shared/api-contracts.js";
import type { ProviderConfig } from "../../config/types.js";
import { buildActivitySummary } from "./activity-summary.js";
import { initializeActivitySchema } from "./schema.js";

/** A day is the smallest window that still has a shape; ninety is as far back as
 *  the aggregate stays cheap enough to answer inline. */
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

export const activityModule: MandateModule = {
  id: "activity",
  schema: [initializeActivitySchema],
  mountRoutes: (app, { deps }) => {
    app.get(API_ROUTES.activitySummary, (c) => {
      return c.json(buildActivitySummary(
        deps.store.db,
        readDays(c.req.query("days")),
        readGroup(c.req.query("group"))
      ));
    });

    app.get(API_ROUTES.activityCalls, (c) => {
      const before = c.req.query("before") ?? null;
      const beforeId = c.req.query("beforeId") ?? null;
      const limit = Number(c.req.query("limit") || 20);
      const response = {
        calls: deps.store.listLlmCallSummaries(limit, {
          ...readLlmCallFilters(c.req.query.bind(c.req)),
          before,
          beforeId
        }).map((call) => matchLegacyProviderName(call, deps.config?.models.providers ?? {}))
      } satisfies LlmCallsResponse;
      return c.json(response);
    });

    app.get(API_ROUTES.activityCall, (c) => {
      const call = deps.store.getLlmCall(c.req.param("id"));
      if (!call) return c.json({ error: "not found" }, 404);
      const response = {
        call: matchLegacyProviderName(call, deps.config?.models.providers ?? {})
      } satisfies LlmCallDetailResponse;
      return c.json(response);
    });

  }
};

/** Keep inferred names out of stored metadata: today's configuration cannot
 *  establish what a provider was named when a legacy call was recorded. */
function matchLegacyProviderName<T extends Pick<LlmCallSummaryDto, "provider" | "baseURL" | "metadata">>(
  call: T,
  providers: Record<string, ProviderConfig>
): T & { matchedProviderName?: string } {
  const recordedName = call.metadata?.providerName;
  if (typeof recordedName === "string" && recordedName.trim()) return call;
  const normalizeURL = (url: string | null | undefined) => url?.trim().replace(/\/+$/, "") ?? "";
  const baseURL = normalizeURL(call.baseURL);
  if (!baseURL) return call;
  const matches = Object.entries(providers).filter(([, provider]) =>
    provider.type === call.provider && normalizeURL(provider.baseURL) === baseURL
  );
  return matches.length === 1 ? { ...call, matchedProviderName: matches[0]![0] } : call;
}

/** Clamps to the supported window. Non-numeric input falls back to the default
 *  rather than clamping: `Math.min`/`Math.max` pass NaN straight through, and a
 *  NaN window reaches `new Date(NaN).toISOString()`, which throws. */
function readDays(raw: string | undefined): number {
  const parsed = Number(raw ?? "");
  if (!Number.isFinite(parsed) || parsed === 0) return DEFAULT_DAYS;
  return Math.max(MIN_DAYS, Math.min(MAX_DAYS, Math.floor(parsed)));
}

/** An unknown grouping is a stale link, not an error: answer the default rather
 *  than a 400 the page has no way to render. The allow-list is the shared one
 *  the selector is built from, so "the page offers it" and "this endpoint
 *  answers it" cannot come apart. */
function readGroup(raw: string | undefined): ActivityGroupKey {
  return (ACTIVITY_GROUP_KEYS as readonly string[]).includes(raw ?? "")
    ? (raw as ActivityGroupKey)
    : "model";
}

function readLlmCallFilters(query: (key: string) => string | undefined) {
  return {
    status: query("status") ?? null,
    purpose: query("purpose") ?? null,
    provider: query("provider") ?? null,
    model: query("model") ?? null,
    // The three a breakdown row links by. Nothing on the log sets them from a
    // control, which is exactly why they have to be read here: their only route
    // in is the url.
    scopeType: query("scopeType") ?? null,
    day: query("day") ?? null,
    fallback: query("fallback") ?? null,
    q: query("q") ?? null
  };
}
