import { priceMatchDto } from "../pricing/module.js";
import type { MandateModule } from "../module.js";
import {
  ACTIVITY_GROUP_KEYS,
  API_ROUTES,
  type ActivityGroupKey,
  type ActivitySummaryResponse,
  type CacheSealPauseDto,
  type LlmCallDetailResponse,
  type LlmCallView,
  type LlmCallsResponse
} from "../../../shared/api-contracts.js";
import { buildActivitySummary } from "./activity-summary.js";
import { activityRange } from "./local-days.js";
import { annotateCallDetail, annotateCalls, extraForCalls } from "./call-annotations.js";
import { buildActivityLedger } from "./ledger-summary.js";
import { loadWindowVerdicts } from "./window-verdicts.js";
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
    const ledgerDeps = () => ({ catalog: deps.priceData?.catalog() ?? null, providers: deps.config?.models.providers ?? {} });

    app.get(API_ROUTES.activitySummary, (c) => {
      const days = readDays(c.req.query("days"));
      // One window end for both halves, so the response counts one window.
      const now = Date.now();
      // Days cut in the reader's zone, the same for both halves.
      const range = activityRange({ days, now, zone: c.req.query("tz") ?? null, day: c.req.query("day") ?? null });
      const response = {
        ...buildActivitySummary(deps.store.db, days, readGroup(c.req.query("group")), now, range),
        ledger: buildActivityLedger(deps.store.db, days, ledgerDeps(), now, range),
        day: range.day,
        cacheSeal: {
          paused: (deps.cacheSealPauses?.() ?? []).map((pause): CacheSealPauseDto => ({
            model: pause.model,
            failure: pause.failure,
            nextTryAt: new Date(pause.nextTryAt).toISOString(),
            ...(pause.outputTokens !== undefined ? { outputTokens: pause.outputTokens } : {})
          }))
        }
      } satisfies ActivitySummaryResponse;
      return c.json(response);
    });

    app.get(API_ROUTES.activityCalls, (c) => {
      const before = c.req.query("before") ?? null;
      const beforeId = c.req.query("beforeId") ?? null;
      const limit = Number(c.req.query("limit") || 20);
      const filters = readLlmCallFilters(c.req.query.bind(c.req));
      // The views that answer a figure the Overview counted keep to its
      // window; All, Failed and Slow list all history.
      const periodBound = filters.view === "expired" || filters.view === "timers" || filters.agent !== null;
      const since = periodBound ? new Date(Date.now() - readDays(c.req.query("days")) * 86_400_000).toISOString() : null;
      const verdicts = filters.view === "expired" && since ? loadWindowVerdicts(deps.store.db, since) : null;
      const ids = verdicts ? [...verdicts].filter(([, v]) => v.kind === "expired").map(([id]) => id) : null;
      const calls = deps.store.listLlmCallSummaries(limit, { ...filters, before, beforeId, since, ids });
      const response: LlmCallsResponse = { calls: annotateCalls(deps.store.db, calls, ledgerDeps()) };
      if (periodBound) {
        // The view's whole set under every filter on it, cursor aside: the
        // count and the extra describe the same calls.
        const matching = deps.store.matchingLlmCallIds({ ...filters, since, ids });
        response.totals = {
          calls: matching.length,
          extraMicros: verdicts ? extraForCalls(deps.store.db, verdicts, matching, ledgerDeps()) : null
        };
      }
      return c.json(response);
    });

    app.get(API_ROUTES.activityCall, (c) => {
      const call = deps.store.getLlmCall(c.req.param("id"));
      if (!call) return c.json({ error: "not found" }, 404);
      // An Unpriced call offers what its name looks like, for the user to
      // confirm; at a plan's address the way forward is its Billing instead.
      const catalog = deps.priceData?.catalog();
      const suggestion = call.cost?.source === "unpriced" && call.model && catalog && !(call.baseURL && catalog.isPlanProvider(call.baseURL))
        ? catalog.suggest(call.model) : null;
      const detail = { ...call, priceSuggestion: suggestion ? priceMatchDto(suggestion) : null };
      const response = { call: annotateCallDetail(deps.store.db, detail, ledgerDeps()) } satisfies LlmCallDetailResponse;
      return c.json(response);
    });

  }
};

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
    zone: query("tz") ?? null,
    fallback: query("fallback") ?? null,
    q: query("q") ?? null,
    agent: query("agent")?.trim() || null,
    view: (LLM_CALL_VIEWS as readonly string[]).includes(query("view") ?? "") ? (query("view") as LlmCallView) : null
  };
}

const LLM_CALL_VIEWS = ["failed", "slow", "expired", "timers"] as const satisfies readonly LlmCallView[];
