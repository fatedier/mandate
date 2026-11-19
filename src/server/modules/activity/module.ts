import type { Context } from "hono";
import { priceMatchDto } from "../pricing/module.js";
import type { MandateModule } from "../module.js";
import {
  ACTIVITY_GROUP_KEYS,
  API_ROUTES,
  type ActivityFilterOptionsResponse,
  type ActivityGroupKey,
  type ActivitySummaryResponse,
  type CacheSealPauseDto,
  type LlmCallDetailResponse,
  type LlmCallView,
  type LlmCallsResponse
} from "../../../shared/api-contracts.js";
import { rollupInputs } from "./activity-rollup.js";
import { countCallsAway, expiredVerdictsAway, listFilterOptionsAway, summarizeActivityAway } from "./activity-summary-away.js";
import { annotateCallDetail, annotateCalls, extraForCalls } from "./call-annotations.js";
import { initializeActivitySchema } from "./schema.js";
import { sliceKeeperFor } from "./slice-keeper.js";
import { initializeActivitySliceSchema } from "./slice-schema.js";

/** A day is the smallest window that still has a shape; ninety is as far back as
 *  the aggregate stays cheap enough to answer inline. */
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;
/** How long a reading of every stored call in a window may take before Bun
 *  closes its connection. Bun's own limit, 10 seconds without a byte sent,
 *  has been passed on a busy machine reading a cold database: the page then
 *  had no answer at all. */
const SLOW_ANSWER_SECONDS = 120;

/** Asks Bun for longer on this request. The server is Hono's env under Bun;
 *  elsewhere (tests, another runtime) there is none, and nothing changes. */
function allowSlowAnswer(c: Context): void {
  (c.env as { timeout?: (request: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, SLOW_ANSWER_SECONDS);
}

export const activityModule: MandateModule = {
  id: "activity",
  schema: [initializeActivitySchema, initializeActivitySliceSchema],
  mountRoutes: (app, { deps }) => {
    const ledgerDeps = () => ({ catalog: deps.priceData?.catalog() ?? null, providers: deps.config?.models.providers ?? {} });

    app.get(API_ROUTES.activitySummary, async (c) => {
      allowSlowAnswer(c);
      const keeper = sliceKeeperFor(deps.store.db);
      const catalog = deps.priceData?.catalog() ?? null;
      const providers = deps.config?.models.providers ?? {};
      // Worked out on a thread of its own: reading and weighing a month of
      // calls is too long to hold the server's thread for. The hours kept as
      // slices are read instead of their calls, unless they were found wrong.
      const answer = await summarizeActivityAway({
        dbPath: deps.store.db.filename,
        days: readDays(c.req.query("days")),
        group: readGroup(c.req.query("group")),
        now: Date.now(),
        zone: c.req.query("tz") ?? null,
        day: c.req.query("day") ?? null,
        providers,
        prices: catalog?.sources() ?? null,
        inputs: keeper.enabled ? rollupInputs(catalog, providers) : null
      });
      if (answer.fellBack !== null) keeper.off(answer.fellBack);
      // Written in later turns of the loop, once this answer is on its way.
      keeper.keep(answer.built);
      const response = {
        ...answer.result,
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

    // Every model and purpose the log can be filtered by: read over all
    // stored calls, so on the summary's thread too.
    app.get(API_ROUTES.activityFilterOptions, async (c) => {
      allowSlowAnswer(c);
      const response: ActivityFilterOptionsResponse = await listFilterOptionsAway({ dbPath: deps.store.db.filename });
      return c.json(response);
    });

    app.get(API_ROUTES.activityCalls, async (c) => {
      const before = c.req.query("before") ?? null;
      const beforeId = c.req.query("beforeId") ?? null;
      const limit = Number(c.req.query("limit") || 20);
      const filters = readLlmCallFilters(c.req.query.bind(c.req));
      // The views that answer a figure the Overview counted keep to its
      // window; All, Failed and Slow list all history.
      const periodBound = filters.view === "expired" || filters.view === "timers" || filters.agent !== null;
      const since = periodBound ? new Date(Date.now() - readDays(c.req.query("days")) * 86_400_000).toISOString() : null;
      // Which steps expired takes every step of the window, read and judged,
      // and a view's count weighs a month of calls one by one: both on the
      // summary's thread, as on this one each held the server for up to a
      // fifth of a second.
      if (periodBound) allowSlowAnswer(c);
      const expired = filters.view === "expired" && since ? await expiredVerdictsAway({ dbPath: deps.store.db.filename, since }) : null;
      const ids = expired ? [...expired.keys()] : null;
      const calls = deps.store.listLlmCallSummaries(limit, { ...filters, before, beforeId, since, ids });
      const response: LlmCallsResponse = { calls: annotateCalls(deps.store.db, calls, ledgerDeps()) };
      // The view's whole set under every filter on it, cursor aside: the
      // count and the extra describe the same calls. Shown from the first
      // page; an older page is only more rows.
      if (periodBound && !before) {
        if (expired) {
          const matching = deps.store.matchingLlmCallIds({ ...filters, since, ids });
          response.totals = { calls: matching.length, extraMicros: extraForCalls(deps.store.db, expired, matching, ledgerDeps()) };
        } else {
          response.totals = { calls: await countCallsAway({ dbPath: deps.store.db.filename, filters: { ...filters, since, ids } }), extraMicros: null };
        }
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

const LLM_CALL_VIEWS = ["failed", "slow", "expired", "timers", "held"] as const satisfies readonly LlmCallView[];
