import { useEffect, useId, useState } from "react";
import { useWorkItemsStore } from "@/store/work-items";
import { dedupeSummaryAgainstPhaseDetail, summaryMetaText } from "@/lib/work-item-summary";
import { WorkItemDetailBody } from "./chat/work-items/WorkItemDetailBody";
import { useNow } from "@/hooks/useNow";
import type { WorkItemDto } from "@shared/api/work-items";

interface Props {
  featureId: string;
}

export function FeatureWorkItemDashboard({ featureId }: Props) {
  const item = useWorkItemsStore((s) => {
    for (const it of s.items.values()) {
      if (it.featureId === featureId) return it;
    }
    return null;
  });
  const fetchByFeature = useWorkItemsStore((s) => s.fetchByFeature);
  const labelId = useId();

  // The store is populated by a list fetch at startup and by SSE afterwards,
  // and either can leave this pane empty: a feature created after the list was
  // taken, an item past the list's limit, or a created event that fired while
  // this client was disconnected. Ask for this feature's item directly instead
  // of declaring it absent.
  // Which feature the lookup has answered for, rather than a bare pending
  // flag: navigating to another feature then stops matching by construction,
  // so there is no state to reset on the way in.
  const [settledFor, setSettledFor] = useState<string | null>(null);
  useEffect(() => {
    if (item) return;
    let cancelled = false;
    void fetchByFeature(featureId)
      .catch(() => { /* offline or unknown feature — the placeholder is the answer */ })
      .finally(() => { if (!cancelled) setSettledFor(featureId); });
    return () => { cancelled = true; };
  }, [featureId, item, fetchByFeature]);

  if (!item) {
    // Silent until the lookup answers, so a feature that does have an item
    // never flashes "no work item" on the way to showing it.
    if (settledFor !== featureId) return null;
    return (
      <section className="rounded-lg border border-border-soft bg-card p-3 text-sm text-faint">
        no work item for this feature
      </section>
    );
  }

  const isEmpty = item.phase === "design" && !item.summary && !item.phaseDetail;
  if (isEmpty) {
    return (
      <section className="text-sm text-faint">
        still discussing — no progress yet
      </section>
    );
  }

  const summary = dedupeSummaryAgainstPhaseDetail(item.summary, item.phaseDetail);
  // Provenance of the summary text, not of the work item. lastActivityAt is
  // deliberately not a fallback here: every patch to any field refreshes it,
  // so using it made a summary written days ago read as written minutes ago.

  // No card frame. This is the page's own lede, sitting directly under the page
  // header — boxing it made a heavy container for one paragraph and put a second
  // border a few pixels below the header's. A rule and a label carry the same
  // grouping at a fraction of the visual cost.
  return (
    <section aria-labelledby={labelId}>
      <div className="mb-2 flex items-center gap-2.5">
        <span id={labelId} className="label-micro shrink-0 text-chrome">Summary</span>
        <span aria-hidden className="h-px flex-1 bg-border-soft" />
        {/* Omitted entirely when neither the author nor the write time is
            known — an older row, or a summary nobody has written yet. Half a
            fact is shown as half a line, never as "unknown". */}
        {summary && <SummaryMeta item={item} />}
      </div>
      {summary ? (
        <WorkItemDetailBody item={item} hideSummaryHeading collapsible />
      ) : (
        <p className="m-0 text-sm text-faint">no summary yet</p>
      )}
    </section>
  );
}

function SummaryMeta({ item }: { item: WorkItemDto }) {
  const meta = summaryMetaText(item, useNow());
  return meta ? (
    <span className="num min-w-0 shrink truncate font-mono text-2xs text-faint">{meta}</span>
  ) : null;
}
