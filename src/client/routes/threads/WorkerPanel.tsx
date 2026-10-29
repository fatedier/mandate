import { useEffect, useState } from "react";
import { LayoutList, PanelRightClose, X } from "lucide-react";
import { API_PATHS } from "@shared/api-contracts";
import type { ThreadWorkerRefDto, ThreadWorkersResponse } from "@shared/api/agents";
import { apiPath } from "@/lib/api-base";
import { cn } from "@/lib/utils";
import { featureHref, threadHref } from "@/lib/feature-href";
import { selectSnapshotWindow } from "@/lib/snapshot-selectors";
import { useSnapshotStore } from "@/store/snapshot";
import { FeatureActionsMenu } from "@/routes/window/FeatureActionsMenu";
import { defaultWorkerTab, type WorkerTab } from "@/lib/worker-groups";
import { useProjectsStore, type Feature, type Project } from "@/store/projects";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { hasWorkItemFor } from "@/store/work-items";
import type { ThreadWorker } from "@/hooks/useThreadWorkers";
import { PanelTabRow, type PanelTabItem } from "@/components/PanelTabRow";
import { useOpenCanvas } from "@/routes/canvas/canvas-opener";
import { usePanelCanvasTabs } from "@/routes/canvas/panel-canvas-tabs";
import { PanelCanvasViews } from "@/routes/canvas/PanelCanvasViews";
import { canvasIdOfTab, canvasTabId } from "@/lib/panel-tabs";
import { PILL_DOT_CLASS, stateTone, type PillTone } from "@/lib/feature-status";
import { PaneZoomButton } from "@/components/PaneZoomButton";
import { BottomSheetClose } from "@/components/ui/bottom-sheet";
import { LoadingLine, StateAction, StateLink, StateMessage } from "@/components/ViewState";
import { errorText } from "@shared/error-text";
import { WorkerView } from "@/routes/window/WorkerView";
import { WorkersOverview } from "./WorkersOverview";
import { ArchivedWorkerView, type ArchivedTab } from "./ArchivedWorkerView";

const ARCHIVED = "archived:";

/** A thread's right side: the Workers overview, then one closable tab per
 *  worker and per canvas the user opened, remembered per thread. On a phone
 *  (the sheet) canvases open full screen instead: its row lists no canvas
 *  tabs. */
export function WorkerPanel({ threadId, workers, variant = "side", onWantFull, archivedWorkers }: {
  threadId: string;
  workers: ThreadWorker[];
  /** An archived thread: how many workers it had, all archived with it. */
  archivedWorkers?: number;
  /** "sheet": the phone's bottom sheet — no maximize, no hide. */
  variant?: "side" | "sheet";
  /** The sheet is asked to go full height: a worker's tab needs the room. */
  onWantFull?: () => void;
}) {
  const state = useWorkerPanelStore((s) => s.get(threadId));
  const maximized = useWorkerPanelStore((s) => s.maximized);
  // A narrow row gives the panel the whole row already: nothing to maximize,
  // and hiding it means going back to the chat.
  const narrow = useWorkerPanelStore((s) => s.narrow);
  const projects = useProjectsStore((s) => s.projects);
  const archivedRefs = state.archived ?? {};
  const store = useWorkerPanelStore.getState;
  const sheet = variant === "sheet";
  const tabIds = sheet ? state.tabs.filter((id) => canvasIdOfTab(id) === null) : state.tabs;
  const active = tabIds.includes(state.active) ? state.active : "workers";
  // Closing the open tab opens its neighbour among the tabs this row shows
  // (the sheet's skips canvas tabs; the side panel's are all of them).
  const closeTab = (id: string) => store().closeTab(threadId, id, sheet ? notCanvas : undefined);
  const canvasTabs = usePanelCanvasTabs(tabIds, active, closeTab);
  const activeCanvas = canvasTabs.activeCanvas;

  const open = (featureId: string) => {
    const worker = workers.find((w) => w.featureId === featureId);
    const remembered = store().get(threadId).workerTab[featureId];
    store().openWorker(threadId, featureId, remembered || !hasWorkItemFor(featureId) ? undefined : defaultWorkerTab(worker ?? { waiting: null }));
    onWantFull?.();
  };
  const openArchived = (ref: ThreadWorkerRefDto) => {
    const id = `${ARCHIVED}${ref.featureId}`;
    store().setArchivedRef(threadId, id, ref);
    store().openWorker(threadId, id);
    onWantFull?.();
  };
  // A canvas in the overview opens as the page opens one: beside the chat
  // on a desktop, full screen on a phone.
  const openCanvas = useOpenCanvas();
  // Open worker in a canvas tab: one of this thread's workers opens here.
  const openWorkerHere = (featureId: string) => {
    if (!workers.some((w) => w.featureId === featureId)) return false;
    open(featureId);
    return true;
  };
  const labelOf = (id: string) => id.startsWith(ARCHIVED)
    ? archivedRefs[id]?.name ?? "Archived"
    : findFeature(projects, id)?.feature.name ?? workers.find((w) => w.featureId === id)?.name ?? "Worker";

  const items: PanelTabItem[] = tabIds.map((id) => {
    const canvasItem = canvasTabs.items.get(id);
    if (canvasItem) return canvasItem;
    const worker = workers.find((w) => w.featureId === id);
    return {
      id,
      label: labelOf(id),
      icon: <TabDot tone={worker ? stateTone(worker.state) : "neutral"} />,
      onClose: () => closeTab(id),
      dataWorkerTab: id
    };
  });

  const tools = sheet ? (
    // The sheet's way out: opened from Home it fills the screen, and the
    // drag handle and an 8px strip were all there was. 44px, as the
    // tool-calls sheet's Close.
    <BottomSheetClose
      aria-label="Close"
      className="flex size-11 shrink-0 items-center justify-center rounded-md text-chrome transition-colors hover:bg-sel hover:text-foreground"
    >
      <X className="size-5" />
    </BottomSheetClose>
  ) : (<>
    {!narrow && (
      <PaneZoomButton
        zoomed={maximized === "panel"}
        onClick={() => store().setMaximized(maximized === "panel" ? null : "panel")}
      />
    )}
    <button
      type="button"
      aria-label="Hide panel"
      title="Hide panel"
      onClick={() => {
        if (narrow) return store().setNarrowView("chat");
        store().setOpen(threadId, false);
        if (maximized === "panel") store().setMaximized(null);
      }}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-chrome hover:bg-sel hover:text-foreground"
    >
      <PanelRightClose className="h-3.5 w-3.5" />
    </button>
  </>);

  return (
    // In a sheet the body scrolls, this header with it: it is pinned there,
    // and a worker's tabs pin under its 44px (--worker-tabs-top). There it
    // holds the sheet's height only around a chat (data-fills-height): any
    // other view grows, or the pinned bars let go after a screen.
    <div data-slot={`worker-panel-${variant}`} className={cn("flex flex-1 flex-col", sheet ? "[--worker-tabs-top:2.75rem] has-[[data-fills-height]]:min-h-0" : "min-h-0")}>
      <PanelTabRow
        first={{ label: "Workers", icon: <LayoutList aria-hidden className="size-3.5 shrink-0" />, count: archivedWorkers ?? workers.length }}
        tabs={items}
        active={active === "workers" ? "first" : active}
        onSelect={(id) => {
          if (id === "first") return store().setActive(threadId, "workers");
          store().setActive(threadId, id);
          onWantFull?.();
        }}
        tools={tools}
        sticky={sheet}
        ariaLabel="Worker tabs"
      />
      {/* The side panel scrolls here. In a phone's sheet the sheet's own body
          scrolls — it holds the scroll until the sheet is pulled to full and
          resets it when the sheet settles at half — so this must not; it
          still passes the sheet's height down, which a worker's chat fills.
          A canvas scrolls inside its own view. */}
      {!activeCanvas && (
        <div className={cn("flex min-h-0 flex-1 flex-col", !sheet && "overflow-y-auto")}>
          {active === "workers" ? (
            <WorkersOverview threadId={threadId} workers={workers} onOpen={open} onOpenArchived={openArchived} onOpenCanvas={openCanvas} threadArchived={archivedWorkers !== undefined} />
          ) : active.startsWith(ARCHIVED) ? (
            archivedRefs[active]
              ? (
                <ArchivedWorkerView
                  key={active}
                  worker={archivedRefs[active]!}
                  tab={archivedTab(state.workerTab[active])}
                  onTabChange={(tab) => store().setWorkerTab(threadId, active, tab)}
                />
              )
              : (
                // Keyed: the tab switched to never shows the previous one's details while its own load.
                <ArchivedSince
                  key={active}
                  threadId={threadId}
                  tabId={active}
                  featureId={active.slice(ARCHIVED.length)}
                  remember
                  onCloseTab={() => closeTab(active)}
                />
              )
          ) : archivedWorkers !== undefined ? (
            // The thread is archived, so its workers are, whatever this page
            // has heard yet: a tab left open from before reads as theirs do.
            <ArchivedSince key={active} threadId={threadId} featureId={active} onCloseTab={() => closeTab(active)} />
          ) : (
            <ActiveWorker threadId={threadId} featureId={active} workers={workers} projects={projects} onCloseTab={() => closeTab(active)} />
          )}
        </div>
      )}
      <PanelCanvasViews
        kept={canvasTabs.kept}
        active={activeCanvas}
        onClose={(canvasId) => closeTab(canvasTabId(canvasId))}
        openWorker={openWorkerHere}
      />
    </div>
  );
}

/** The tabs the phone's sheet shows: every one but a canvas's. */
const notCanvas = (tabId: string) => canvasIdOfTab(tabId) === null;

/** A worker tab's state, in Home's colours, in the 14px an icon takes. */
function TabDot({ tone }: { tone: PillTone }) {
  return (
    <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
      <span data-slot="tab-dot" className={cn("size-2 rounded-full", PILL_DOT_CLASS[tone])} />
    </span>
  );
}

function ActiveWorker({ threadId, featureId, workers, projects, onCloseTab }: {
  threadId: string;
  featureId: string;
  workers: ThreadWorker[];
  projects: Project[];
  /** Closes this worker's tab, as the row's ✕ does. */
  onCloseTab: () => void;
}) {
  const tab = useWorkerPanelStore((s) => s.get(threadId).workerTab[featureId]);
  const found = findFeature(projects, featureId);
  const windowData = useSnapshotStore((s) => (
    found ? selectSnapshotWindow(s.snapshot, found.project.tmuxSessionName, found.feature.tmuxWindowName) : null
  ));
  const worker = workers.find((w) => w.featureId === featureId);
  if (!found) return <ArchivedSince threadId={threadId} featureId={featureId} onCloseTab={onCloseTab} />;
  const owner = found.feature.ownerThreadId;
  if (owner && owner !== threadId) {
    // Moved to another thread (an old report named it): point there rather
    // than direct it from here.
    return (
      <div className="p-4">
        <StateMessage title="Worker moved" action={<StateLink to={`${threadHref(owner)}?worker=${encodeURIComponent(featureId)}`}>Open it in its thread</StateLink>}>
          This worker belongs to another thread now.
        </StateMessage>
      </div>
    );
  }
  return (
    <WorkerView
      key={featureId}
      project={found.project}
      feature={found.feature}
      tab={tab ?? defaultWorkerTab(worker ?? { waiting: null })}
      onTabChange={(next) => useWorkerPanelStore.getState().setWorkerTab(threadId, featureId, next)}
      variant="panel"
      actions={
        // The worker's menu, as on its page; Close and
        // an archive close its tab and stay in the thread.
        <FeatureActionsMenu
          featureId={found.feature.id}
          featureName={found.feature.name}
          featureMode={found.feature.mode}
          branch={found.feature.branch}
          hasWorktree={!!found.feature.worktreePath}
          window={windowData ?? undefined}
          pinned={!!found.feature.pinnedAt}
          onTogglePin={() => void useProjectsStore.getState().togglePin(found.feature.id)}
          onClose={onCloseTab}
          onArchived={onCloseTab}
          pageHref={featureHref(found.project.tmuxSessionName, found.feature.tmuxWindowName)}
        />
      }
    />
  );
}

/** An archived worker has three of the five tabs; the rest show its plan. */
function archivedTab(tab: WorkerTab | undefined): ArchivedTab | undefined {
  return tab === "chat" || tab === "plan" || tab === "reports" ? tab : undefined;
}

/** A worker archived after its tab was opened, or an archived worker's tab
 *  whose details this panel does not hold (it was closed, or the page
 *  reloaded): fetched and shown read-only. `tabId` keys its remembered tab. */
function ArchivedSince({ threadId, featureId, tabId = featureId, remember = false, onCloseTab }: {
  threadId: string;
  featureId: string;
  tabId?: string;
  /** Keep the details found with the tab (an archived tab: its label, a reload). */
  remember?: boolean;
  /** Closes its tab, as the row's ✕ does. */
  onCloseTab?: () => void;
}) {
  const tab = useWorkerPanelStore((s) => s.get(threadId).workerTab[tabId]);
  // undefined: loading; null: not in the thread's archived list; "failed": no answer.
  const [ref, setRef] = useState<ThreadWorkerRefDto | null | "failed" | undefined>(undefined);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    fetch(`${apiPath(API_PATHS.agentManagerThreadWorkers(threadId))}?archived=1`)
      .then(async (r) => {
        const body = await r.json() as ThreadWorkersResponse;
        if (!r.ok || !("workers" in body)) throw new Error("error" in body && body.error ? body.error : `HTTP ${r.status}`);
        return body.workers;
      })
      .then((workers) => {
        if (!live) return;
        const found = workers.find((w) => w.featureId === featureId) ?? null;
        setRef(found);
        if (found && remember) useWorkerPanelStore.getState().setArchivedRef(threadId, tabId, found);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setFailure(errorText(error));
        setRef("failed");
      });
    return () => { live = false; };
  }, [threadId, featureId, tabId, remember, attempt]);
  if (ref === undefined) return <div className="p-4"><LoadingLine /></div>;
  if (ref === "failed") {
    return (
      <div className="p-4">
        <StateMessage
          title="Couldn't load this worker"
          detail={failure}
          action={<StateAction onClick={() => { setRef(undefined); setAttempt((n) => n + 1); }}>Retry</StateAction>}
        />
      </div>
    );
  }
  if (ref === null) {
    return (
      <div className="p-4">
        <StateMessage
          title="Worker not found"
          action={<StateAction onClick={() => (onCloseTab ? onCloseTab() : useWorkerPanelStore.getState().closeTab(threadId, tabId))}>Close tab</StateAction>}
        >
          It's no longer in this thread's archive.
        </StateMessage>
      </div>
    );
  }
  return (
    <ArchivedWorkerView
      key={ref.featureId}
      worker={ref}
      tab={archivedTab(tab)}
      onTabChange={(next) => useWorkerPanelStore.getState().setWorkerTab(threadId, tabId, next)}
    />
  );
}

function findFeature(projects: Project[], featureId: string): { project: Project; feature: Feature } | null {
  for (const project of projects) {
    const feature = project.features.find((f) => f.id === featureId);
    if (feature) return { project, feature };
  }
  return null;
}
