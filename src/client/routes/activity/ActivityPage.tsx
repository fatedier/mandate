import { useCallback, useState } from "react";

import { useSearchParams } from "react-router";
import { ACTIVITY_GROUP_KEYS, type ActivityGroupKey } from "@shared/api-contracts";
import { PageHeader } from "@/shell/PageHeader";
import { readEnum, withParam } from "@/lib/url-params";
import { cn } from "@/lib/utils";
import { BreakdownTab } from "./BreakdownTab";
import { logFilterFor } from "./breakdown-model";
import { LogsTab } from "./logs/LogsTab";
import { OverviewTab } from "./overview/OverviewTab";
import { 
  ACTIVITY_WINDOW_OPTIONS,
  DEFAULT_ACTIVITY_WINDOW_DAYS,
  useActivitySummary
 } from "./useActivitySummary";
import { RefreshButton } from "@/components/RefreshButton";

const ACTIVITY_TABS = [
  { id: "overview", label: "Overview" },
  { id: "breakdown", label: "Breakdown" },
  { id: "logs", label: "Logs" }
] as const;

export type ActivityTab = (typeof ACTIVITY_TABS)[number]["id"];

const TAB_IDS = ACTIVITY_TABS.map((tab) => tab.id) as readonly ActivityTab[];

/** Every filter a breakdown row can set, so a jump from one grouping does not
 *  land on top of the one before it. `group` is deliberately absent: it names
 *  the cut the reader came from, and keeping it is what makes the tab they go
 *  back to the one they left. */
const GROUP_FILTER_PARAMS = [
  "purpose",
  "provider",
  "model",
  "scopeType",
  "day",
  "fallback",
  "status",
  "q"
];

/**
 * Three tabs over one window: the aggregate, the cut, and the stream.
 *
 * The page holds the 30-day summary because it survives a tab switch — the
 * Overview is where a reader lands, and refetching it every time they came
 * back from the log would be the same waste this rebuild removed from the
 * other direction. The Breakdown reads the same response, which is why the
 * grouping lives up here rather than inside the tab. The log's own query lives
 * in `LogsTab`, which only exists while its tab is showing.
 *
 * Nothing here polls. Returning to a summary older than five minutes refreshes
 * it in the background; Refresh always requests a new answer.
 */
export function ActivityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Overview is the landing tab, so it carries no param.
  const tab = readEnum<ActivityTab>(searchParams, "tab", TAB_IDS, "overview");
  // provider / model is the landing cut, so it carries no param either.
  const group = readEnum<ActivityGroupKey>(searchParams, "group", ACTIVITY_GROUP_KEYS, "model");
  // The Overview's table is the purpose grouping and the Breakdown's is the cut
  // the reader picked, which waits in the url while they are on the Overview.
  //
  // The log is neither: it reads no summary at all — `LogsTab` is handed a
  // refresh token and nothing else — so it asks for nothing, and the answer
  // already in hand is held for whichever tab the reader returns to. Naming a
  // grouping here instead fetched a cut nobody looks at on the way in and
  // fetched the previous one back on the way out, and while that second answer
  // was in flight the tab stood on the other cut: the Overview's table popped
  // in on every return from the log.
  // The window applies to the whole page, so it is read once here rather than
  // per tab. An unknown value falls back the way an unknown grouping does: a
  // stale link answers with the default rather than nothing.
  const windowDays = readWindowDays(searchParams);

  const requestedGroup: ActivityGroupKey | null =
    tab === "overview" ? "purpose" : tab === "breakdown" ? group : null;
  const {
    data: summaryData,
    error: summaryError,
    loading: summaryLoading,
    refresh: refreshSummary
  } = useActivitySummary(requestedGroup, windowDays);
  const [logsRefreshToken, setLogsRefreshToken] = useState(0);

  const setTab = useCallback(
    (next: ActivityTab) => {
      setSearchParams((prev) => withParam(prev, "tab", next === "overview" ? null : next), {
        replace: true
      });
    },
    [setSearchParams]
  );

  const setWindowDays = useCallback(
    (next: number) => {
      setSearchParams(
        (prev) => withParam(
          prev,
          "days",
          next === DEFAULT_ACTIVITY_WINDOW_DAYS ? null : String(next)
        ),
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const setGroup = useCallback(
    (next: ActivityGroupKey) => {
      setSearchParams((prev) => withParam(prev, "group", next === "model" ? null : next), {
        replace: true
      });
    },
    [setSearchParams]
  );

  // The cut the rows on screen were drawn from, which is not always the one the
  // url names: the Overview's table is purposes whatever the reader last chose,
  // and on Breakdown a regrouping still in flight leaves the previous answer
  // showing. A key resolved through any other dimension filters the log by
  // something that row was never about.
  const renderedGroup = summaryData?.group ?? group;

  // A group is a question about a set of calls; the answer is those calls.
  const openGroup = useCallback(
    (key: string) => {
      // Some groups name something the log has no filter for — calls with no
      // purpose at all, say. Jumping to an unfiltered log would answer a
      // question nobody asked, so the row simply does not lead anywhere.
      const filter = logFilterFor(renderedGroup, key);
      if (!filter) return;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("tab", "logs");
          for (const name of GROUP_FILTER_PARAMS) next.delete(name);
          for (const [name, value] of Object.entries(filter)) next.set(name, value);
          return next;
        },
        { replace: false }
      );
    },
    [renderedGroup, setSearchParams]
  );

  const refreshActiveTab = useCallback(() => {
    if (tab === "logs") setLogsRefreshToken((token) => token + 1);
    else void refreshSummary();
  }, [tab, refreshSummary]);

  // Only the summary's work is visible from here. The log reports its own,
  // beside the list it is reloading, because that hook lives in the tab.
  const busy = tab !== "logs" && summaryLoading;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 p-6">
      <PageHeader
        subtitle="Every LLM call Mandate makes — what it cost in time, and what went wrong."
        trailing={
          <div className="flex items-center gap-2">
            {/* The window belongs to the page, not to a tab, so it sits in the
                header beside Refresh rather than inside any one panel — every
                figure below it, on all three tabs, is read over this span. */}
            <div
              role="group"
              aria-label="Window"
              className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
            >
              {ACTIVITY_WINDOW_OPTIONS.map((option) => (
                <button
                  key={option.days}
                  type="button"
                  aria-pressed={option.days === windowDays}
                  aria-label={`Last ${option.label}`}
                  onClick={() => setWindowDays(option.days)}
                  className={cn(
                    "num rounded px-2 py-1 text-2xs transition-colors",
                    option.days === windowDays
                      ? "bg-muted font-semibold text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {option.short}
                </button>
              ))}
            </div>
          <RefreshButton
            refreshing={busy}
            onRefresh={refreshActiveTab}
          />
          </div>
        }
        toolbar={
          <div
            role="tablist"
            aria-label="Activity views"
            className="flex gap-0.5 border-b border-border-soft"
          >
            {ACTIVITY_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`activity-tab-${item.id}`}
                aria-selected={item.id === tab}
                // Only the showing tab names a panel. The others have no panel
                // in the document — that is what stops the log's query running
                // — and an aria-controls pointing at an id that is not there
                // is a dangling reference, not a hint.
                aria-controls={item.id === tab ? `activity-panel-${item.id}` : undefined}
                className={cn(
                  "-mb-px border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground",
                  item.id === tab && "border-primary font-semibold text-foreground"
                )}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
      />

      {tab === "logs" ? (
        <div role="tabpanel" id="activity-panel-logs" aria-labelledby="activity-tab-logs">
          <LogsTab refreshToken={logsRefreshToken} />
        </div>
      ) : (
        // Overview and Breakdown are two readings of the same response, so the
        // one failure it can produce is reported the same way on both.
        <div
          role="tabpanel"
          id={`activity-panel-${tab}`}
          aria-labelledby={`activity-tab-${tab}`}
        >
          {summaryError && (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {summaryError}
            </div>
          )}
          {tab === "overview" ? (
            <OverviewTab data={summaryData} loading={summaryLoading} onSelectPattern={openGroup} />
          ) : (
            <BreakdownTab
              data={summaryData}
              loading={summaryLoading}
              group={group}
              onSelectGroup={setGroup}
              onSelectRow={openGroup}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The window the url asks for, or the default. Only the spans the selector
 *  offers are honoured: the endpoint clamps anything to 1..90, so a hand-typed
 *  `?days=53` would answer a window no control on the page can express or
 *  clear, and the reader would have no way back to a named one. */
function readWindowDays(params: URLSearchParams): number {
  const raw = Number(params.get("days"));
  return ACTIVITY_WINDOW_OPTIONS.some((option) => option.days === raw)
    ? raw
    : DEFAULT_ACTIVITY_WINDOW_DAYS;
}
