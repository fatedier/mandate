import { useUiPageSummary } from "@/lib/ui-context";
import type { ActivitySummaryResponse } from "@shared/api-contracts";
import { errorMessageText, unwrapErrorReason } from "@shared/error-reason";
import { summarizeDailyTotals } from "./activity-model";
import type { ActivityCall, StatusFilter } from "./types";

/**
 * What the agent is told the reader is looking at.
 *
 * One hook per tab, each with its own registry key. A single page-level hook
 * would have to be handed every tab's data, which is what kept the log query
 * running while the reader was on the Overview.
 *
 * The keys differ deliberately. `ui-context` answers with the last provider
 * still registered and its cleanup deletes *by key*, so one shared key would
 * survive a tab switch only while React runs the outgoing tab's cleanup before
 * the incoming tab's effect: reverse that order and the incoming provider is
 * registered and then deleted by the departing one, leaving the agent an empty
 * summary. With distinct keys either order ends with exactly the arriving
 * tab's provider, so the answer does not rest on scheduling.
 *
 * The answers are deliberately different shapes. Handing the agent twenty call
 * rows while the reader is looking at a chart described the wrong screen;
 * handing it a 30-day aggregate while the reader is scrolling failures answers
 * a question nobody asked.
 */

const SUMMARY_GROUP_LIMIT = 8;
const SUMMARY_REASON_LIMIT = 3;
const SUMMARY_CALL_LIMIT = 20;

/**
 * The same reason the panel shows and the Overview groups on.
 *
 * `call.error` is `{name?, message}`, so the `String(...)` this replaced handed
 * the agent "[object Object]" for every failure on the page. Needs no slice of
 * its own: `unwrapErrorReason` is bounded at 120 characters, which is well
 * inside what a summary can carry.
 */
function reasonOf(error: unknown): string | null {
  return error ? unwrapErrorReason(errorMessageText(error)) : null;
}

/**
 * The head of the ranking, as both summary-publishing tabs report it.
 *
 * Ordered by call count by the endpoint, so the head is the answer to "what is
 * this install actually doing". Cut here rather than at each caller because the
 * two tabs describe the same rows: a truncation that drifted between them would
 * hand the agent a different top group depending on which tab it asked from.
 * Every reason on eight groups is a page of prose; the head of that list is
 * what names the failure.
 */
function topGroups(groups: ActivitySummaryResponse["groups"]) {
  return groups.slice(0, SUMMARY_GROUP_LIMIT).map((entry) => ({
    ...entry,
    reasons: entry.reasons.slice(0, SUMMARY_REASON_LIMIT)
  }));
}

export function useOverviewPageSummary(data: ActivitySummaryResponse | null): void {
  useUiPageSummary("activity-overview", () => {
    if (!data) return { page: "activity", tab: "overview", loaded: false };
    const totals = summarizeDailyTotals(data.daily);
    return {
      page: "activity",
      tab: "overview",
      loaded: true,
      windowDays: data.days,
      totals,
      latencyMs: { p50: data.p50Ms, p95: data.p95Ms, p99: data.p99Ms },
      latencyBuckets: data.buckets,
      // Which cut the rows below are, not only the rows: "the top group is
      // memory" answers one question under `purpose` and a different one under
      // `scopeType`. The Overview asks for purpose, but the tab the reader came
      // from is what is on screen until that answer lands, so the dimension
      // travels with its own rows rather than being assumed here.
      group: data.group,
      groups: topGroups(data.groups),
      dailyCount: data.daily.length
    };
  });
}

/**
 * The Breakdown, which is one table and nothing else.
 *
 * Narrower than the Overview's on purpose: this tab carries no chart, no
 * headline and no latency panel, so a summary that repeated them would describe
 * a screen the reader is not on. What it must carry that the table cannot is
 * the grouping — an agent told "the top group is memory" needs to know whether
 * that is a purpose or a scope type, and the rows themselves do not say.
 *
 * `data.group` rather than the pill the reader pressed, for the same reason the
 * table's own heading reads it: while a regrouping is in flight the previous
 * cut's rows are what is on screen, and naming the requested one would attach
 * the wrong dimension to them.
 */
export function useBreakdownPageSummary(data: ActivitySummaryResponse | null): void {
  useUiPageSummary("activity-breakdown", () => {
    if (!data) return { page: "activity", tab: "breakdown", loaded: false };
    return {
      page: "activity",
      tab: "breakdown",
      loaded: true,
      windowDays: data.days,
      group: data.group,
      groups: topGroups(data.groups),
      // How many rows the table has, against the eight above: without it an
      // agent handed the head of a long ranking reads it as the whole of it.
      groupCount: data.groups.length
    };
  });
}

export interface LogsPageSummaryInput {
  statusFilter: StatusFilter;
  purposeFilter: string | null;
  providerFilter: string | null;
  modelFilter: string | null;
  scopeTypeFilter: string | null;
  dayFilter: string | null;
  /** "1" or "0" — see `LlmCallQuery.fallback`. */
  fallbackFilter: string | null;
  queryFilter: string | null;
  calls: ActivityCall[];
  hasMore: boolean;
  /** The call whose detail panel is open, if any. The inline expansion this
   *  replaced could have several open at once; a panel has exactly one, which
   *  is also the one the reader is asking about. */
  openCall: ActivityCall | null;
}

export function useLogsPageSummary({
  statusFilter,
  purposeFilter,
  providerFilter,
  modelFilter,
  scopeTypeFilter,
  dayFilter,
  fallbackFilter,
  queryFilter,
  calls,
  hasMore,
  openCall
}: LogsPageSummaryInput): void {
  useUiPageSummary("activity-logs", () => ({
    page: "activity",
    tab: "logs",
    // Every filter the list was fetched under, including the three that only
    // arrive by link: a reader who came from a breakdown row is looking at one
    // day, or one scope, and an agent told the list is unfiltered would be
    // describing a screen nobody is on.
    filters: {
      status: statusFilter,
      purpose: purposeFilter,
      provider: providerFilter,
      model: modelFilter,
      scopeType: scopeTypeFilter,
      day: dayFilter,
      fallback: fallbackFilter,
      q: queryFilter
    },
    loadedCallCount: calls.length,
    hasMore,
    openCallId: openCall?.id ?? null,
    openCall: openCall
      ? {
          id: openCall.id,
          purpose: openCall.purpose,
          status: openCall.status,
          provider: openCall.provider,
          model: openCall.model,
          scopeType: openCall.scopeType,
          scopeId: openCall.scopeId,
          createdAt: openCall.createdAt,
          latencyMs: openCall.latencyMs,
          inputTokens: openCall.inputTokens,
          outputTokens: openCall.outputTokens,
          cacheReadTokens: openCall.cacheReadTokens,
          error: reasonOf(openCall.error)
        }
      : null,
    recentCalls: calls.slice(0, SUMMARY_CALL_LIMIT).map((call) => ({
      id: call.id,
      purpose: call.purpose,
      status: call.status,
      createdAt: call.createdAt,
      latencyMs: call.latencyMs,
      error: reasonOf(call.error)
    }))
  }));
}
