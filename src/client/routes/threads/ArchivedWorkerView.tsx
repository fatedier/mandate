import { useEffect, useMemo, useRef, useState } from "react";
import type { ThreadWorkerRefDto } from "@shared/api/agents";
import { fetchThreadById } from "@/store/agent-chat-api";
import { mergeMessages, newThreadState } from "@/store/agent-chat-utils";
import { useArchivedThreadsStore } from "@/store/archived-threads";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { cn } from "@/lib/utils";
import { TabMark } from "@/components/TabMark";
import { useTabFade } from "@/hooks/useTabFade";
import { ChatMessageList } from "@/routes/window/chat/ChatMessageList";
import type { ApplyOlder } from "@/routes/window/chat/useTranscriptViewport";
import { FeaturePlanCard } from "@/routes/window/plan/FeaturePlanCard";
import { FeatureCanvasList } from "@/routes/window/FeatureCanvasList";
import { useFeatureCanvases } from "@/routes/window/use-feature-canvases";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { errorText } from "@shared/error-text";

export type ArchivedTab = "chat" | "plan" | "reports";

const TAB_LABELS: Record<ArchivedTab, string> = { chat: "Chat", plan: "Plan", reports: "Canvases" };

/** An archived worker, read-only: what it said, its plan, its reports.
 *  Nothing here can wake it. */
export function ArchivedWorkerView({ worker, tab: shownTab, onTabChange }: {
  worker: ThreadWorkerRefDto;
  /** Controlled by the panel, which remembers it per worker tab. */
  tab?: ArchivedTab;
  onTabChange?: (tab: ArchivedTab) => void;
}) {
  const [ownTab, setOwnTab] = useState<ArchivedTab>("plan");
  const tab = shownTab ?? ownTab;
  // What the tab chosen next shows, under the pinned tabs, fades in.
  const tabsRef = useRef<HTMLDivElement>(null);
  useTabFade(tabsRef, tab);
  const setTab = (next: ArchivedTab) => { setOwnTab(next); onTabChange?.(next); };
  const canvasState = useFeatureCanvases(worker.featureId);
  const canvasTitles = useMemo(
    () => new Map((canvasState.canvases ?? []).map((c) => [c.id, c.title])),
    [canvasState.canvases]
  );
  useEffect(() => {
    void useFeaturePlansStore.getState().fetchOne(worker.featureId).catch(() => {});
  }, [worker.featureId]);

  return (
    // Held to the pane's height only around its chat, as a live worker's
    // view is (WorkerView): elsewhere it grows, so its pinned tabs stay, and
    // what focus scrolls into view lands below them (--worker-pinned: the
    // tabs' 36px, 44px on a touch screen).
    <div
      data-fills-height={tab === "chat" || undefined}
      className={cn(
        "flex w-full flex-col gap-4 px-3 pb-4 [--worker-pinned:calc(var(--worker-tabs-top,0px)+2.25rem)] pointer-coarse:[--worker-pinned:calc(var(--worker-tabs-top,0px)+2.75rem)]",
        tab === "chat" ? "min-h-0" : "scroll-below-pinned"
      )}
    >
      {/* 44px on a touch screen, holding the tabs' touch areas. Pinned as a
          live worker's tabs are (WorkerView). */}
      <div ref={tabsRef} className="sticky top-[var(--worker-tabs-top,0px)] z-10 -mx-3 flex h-9 shrink-0 items-center gap-0.5 bg-background px-3 fade-below pointer-coarse:h-11" role="tablist">
        <TabMark selected={tab} />
        {(["chat", "plan", "reports"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "hit relative h-7 rounded-sm px-2.5 text-xs font-medium transition-colors",
              // The chosen tab's fill is the row's sliding TabMark.
              tab === t ? "text-foreground" : "text-chrome hover:bg-sel hover:text-foreground"
            )}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
        <span className="ml-auto text-2xs text-faint">Archived</span>
      </div>
      {/* Keyed: another worker's chat never shows while this one loads. */}
      {tab === "chat" && <ArchivedChat key={worker.workerThreadId ?? worker.featureId} threadId={worker.workerThreadId} />}
      {tab === "plan" && (
        // An archived worker has no window: its plan's pane links have nowhere to go.
        <FeaturePlanCard featureId={worker.featureId} projectSlug="" featureSlug="" gitRemote={null} canvasTitles={canvasTitles} />
      )}
      {tab === "reports" && (
        <section className="flex flex-col gap-3" aria-label="Canvases">
          <FeatureCanvasList state={canvasState} />
        </section>
      )}
    </div>
  );
}

function ArchivedChat({ threadId }: { threadId: string | null }) {
  // The conversation's, kept across the tab being left (see the store).
  const thread = useArchivedThreadsStore((state) => (threadId ? state.byId.get(threadId) ?? null : null));
  const updateThread = useArchivedThreadsStore((state) => state.update);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loaded = thread !== null;
  useEffect(() => {
    if (!threadId || loaded) return;
    let live = true;
    fetchThreadById(threadId)
      .then((page) => {
        const messages = mergeMessages([], page.messages);
        updateThread(threadId, (current) => current ?? { ...newThreadState(), threadId, messages, oldestSeqLoaded: messages[0]?.seq ?? null, hasMoreOlder: page.hasMore, loaded: true });
      })
      .catch((error: unknown) => { if (live) setFailure(errorText(error)); });
    return () => { live = false; };
  }, [threadId, loaded, attempt, updateThread]);

  // The page's write goes through `apply`, which keeps the reader's place.
  const loadOlder = async (apply: ApplyOlder) => {
    if (!threadId || !thread?.hasMoreOlder || thread.oldestSeqLoaded === null) return;
    const before = thread.oldestSeqLoaded;
    const page = await fetchThreadById(threadId, before);
    const older = page.messages.filter((m) => m.seq < before);
    apply(() => updateThread(threadId, (current) => current && {
      ...current,
      messages: [...older, ...current.messages],
      oldestSeqLoaded: older[0]?.seq ?? current.oldestSeqLoaded,
      hasMoreOlder: page.hasMore && older.length > 0
    }));
  };

  if (!threadId) return <p className="text-sm text-faint">No conversation.</p>;
  // A read that landed after all (an earlier mount's) wins over this one failing.
  if (failure !== null && !thread) {
    return (
      <InlineError detail={failure} onRetry={() => { setFailure(null); setAttempt((n) => n + 1); }}>
        Couldn't load the conversation.
      </InlineError>
    );
  }
  if (!thread) return <LoadingLine />;
  return (
    // The list brings its own gutters (chat-column.ts); this cancels the
    // view's px-3 so they apply once, as in a live worker's chat.
    <div className="-mx-3 flex min-h-[50vh] flex-1 flex-col">
      <ChatMessageList
        thread={thread}
        onLoadOlder={loadOlder}
        onRetryFailed={() => {}}
      />
    </div>
  );
}
