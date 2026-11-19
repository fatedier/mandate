import { useCallback, useEffect, useState } from "react";
import { LayoutList, X } from "lucide-react";
import { API_PATHS } from "@shared/api-contracts";
import type { ThreadWorkerRefDto, ThreadWorkersResponse } from "@shared/api/agents";
import { apiPath } from "@/lib/api-base";
import { cn } from "@/lib/utils";
import { threadHref } from "@/lib/worker-href";
import { selectSnapshotWindow } from "@/lib/snapshot-selectors";
import { useSnapshotStore } from "@/store/snapshot";
import { WorkerActionsMenu } from "@/routes/window/WorkerActionsMenu";
import { defaultWorkerTab, type WorkerTab } from "@/lib/worker-groups";
import { useProjectsStore, type ProjectWorker, type Project } from "@/store/projects";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { hasWorkItemFor } from "@/store/work-items";
import type { ThreadWorker } from "@/hooks/useThreadWorkers";
import { PanelTabRow, type PanelTabItem } from "@/components/PanelTabRow";
import { useOpenCanvas } from "@/routes/canvas/canvas-opener";
import { usePanelCanvasTabs } from "@/routes/canvas/panel-canvas-tabs";
import { usePanelReplyTabs } from "@/routes/reply-tabs/panel-reply-tabs";
import { ReplyTabView } from "@/routes/reply-tabs/ReplyTabView";
import { PanelCanvasViews } from "@/routes/canvas/PanelCanvasViews";
import { canvasIdOfTab, canvasTabId, completeOrder, filePathOfTab, movedOrder, orderedIds, orderedTabs, PANEL_TAB_ORDER, reconciledOrder, replyIdOfTab, replyTabId, withTabBack } from "@/lib/panel-tabs";
import { useReplyTabs, useReplyTabsStore } from "@/store/reply-tabs";
import { usePanelFileTabs } from "@/routes/files/panel-file-tabs";
import { PanelFileViews } from "@/routes/files/PanelFileViews";
import { PILL_DOT_CLASS, stateTone, type PillTone } from "@/lib/worker-status";
import { PaneZoomButton } from "@/components/PaneZoomButton";
import { BottomSheetClose } from "@/components/ui/bottom-sheet";
import { LoadingLine, StateAction, StateLink, StateMessage } from "@/components/ViewState";
import { errorText } from "@shared/error-text";
import { WorkerView } from "@/routes/window/WorkerView";
import { WorkersOverview } from "./WorkersOverview";
import { usePanelClosedTabs } from "@/routes/closed-tabs/panel-closed-tabs";
import { openReplyTab } from "@/routes/reply-tabs/open-reply-tab";
import { threadPanel } from "@/store/closed-tabs";
import { ArchivedWorkerView, type ArchivedTab } from "./ArchivedWorkerView";

const ARCHIVED = "archived:";

/** A thread's right side: the Workers overview, then one closable tab per
 *  worker and per canvas or file the user opened, remembered per thread. On
 *  a phone (the sheet) canvases and files open full screen instead: its row
 *  lists no canvas or file tabs. */
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
  const tabIds = sheet ? state.tabs.filter(inSheet) : state.tabs;
  // The replies opened from the thread's chat follow the other tabs, in the
  // sheet too: they are the server's, the same on every device.
  const replyGone = useCallback(
    (id: string, before: string) => useWorkerPanelStore.getState().tabGone(threadId, id, before, sheet ? inSheet : undefined),
    [threadId, sheet]
  );
  const replyTabs = usePanelReplyTabs(threadId, { active: state.active, before: tabIds, order: state.order, home: "workers", gone: replyGone });
  const repliesLoaded = useReplyTabsStore((s) => s.byThread.has(threadId));
  const active = tabIds.includes(state.active) || replyTabs.ids.includes(state.active) ? state.active : "workers";
  // The row as drawn (the sheet's: what it shows), in the order the person
  // dragged it into; and every tab the panel has, the sheet's hidden ones too.
  const drawnIds = orderedIds([...tabIds, ...replyTabs.ids], state.order);
  const present = [...state.tabs, ...replyTabs.ids];
  // Once the person has given the row an order it lists every tab: one that
  // comes goes last, one goes once it is gone (a reply once the server has
  // let it go; while the replies' list has not come, it keeps its place).
  const presentKey = present.join("\n");
  const orderKey = state.order?.join("\n");
  // When the server made each reply tab: several that came while the panel
  // was not drawn go in that order.
  const replyList = useReplyTabs(threadId);
  const cameKey = replyList.map((tab) => `${replyTabId(tab.id)}\t${tab.createdAt}`).join("\n");
  useEffect(() => {
    const saved = useWorkerPanelStore.getState().get(threadId).order;
    if (!saved) return;
    // The replies wait until their list is in: one that came unseen is placed
    // by when the server made it. The panel's own tabs join at once.
    const waiting = (id: string) => !repliesLoaded && replyIdOfTab(id) !== null;
    const came = new Map(cameKey ? cameKey.split("\n").map((line) => { const [id, at] = line.split("\t"); return [id!, Date.parse(at!)] as const; }) : []);
    const next = reconciledOrder(saved, presentKey ? presentKey.split("\n") : [], (id) => came.get(id) ?? Infinity, waiting);
    if (next.join("\n") !== saved.join("\n")) useWorkerPanelStore.getState().keepTabOrder(threadId, next);
  }, [threadId, presentKey, orderKey, cameKey, repliesLoaded]);
  // Closing the open tab opens its neighbour among the tabs this row shows
  // (the sheet's skips canvas and file tabs; the side panel's are all of them).
  const closeTab = (id: string) => store().closeTab(threadId, id, sheet ? inSheet : undefined, drawnIds);
  const canvasTabs = usePanelCanvasTabs(tabIds, active, closeTab);
  const activeCanvas = canvasTabs.activeCanvas;
  const fileTabs = usePanelFileTabs(tabIds, active, closeTab);

  const open = (workerId: string) => {
    const worker = workers.find((w) => w.workerId === workerId);
    const remembered = store().get(threadId).workerTab[workerId];
    store().openWorker(threadId, workerId, remembered || !hasWorkItemFor(workerId) ? undefined : defaultWorkerTab(worker ?? { waiting: null }));
    onWantFull?.();
  };
  const openArchived = (ref: ThreadWorkerRefDto) => {
    const id = `${ARCHIVED}${ref.workerId}`;
    store().setArchivedRef(threadId, id, ref);
    store().openWorker(threadId, id);
    onWantFull?.();
  };
  // A canvas in the overview opens as the page opens one: beside the chat
  // on a desktop, full screen on a phone.
  const openCanvas = useOpenCanvas();
  // Open worker in a canvas tab: one of this thread's workers opens here.
  const openWorkerHere = (workerId: string) => {
    if (!workers.some((w) => w.workerId === workerId)) return false;
    open(workerId);
    return true;
  };
  const labelOf = (id: string) => id.startsWith(ARCHIVED)
    ? archivedRefs[id]?.name ?? "Archived"
    : findWorker(projects, id)?.worker.name ?? workers.find((w) => w.workerId === id)?.name ?? "Worker";

  const items: PanelTabItem[] = tabIds.map((id) => {
    const canvasItem = canvasTabs.items.get(id) ?? fileTabs.items.get(id);
    if (canvasItem) return canvasItem;
    const worker = workers.find((w) => w.workerId === id);
    return {
      id,
      label: labelOf(id),
      icon: <TabDot tone={worker ? stateTone(worker.state) : "neutral"} />,
      group: "Workers",
      onClose: () => closeTab(id),
      dataWorkerTab: id
    };
  });

  // In the order the person dragged them into (this browser's): every tab
  // after Workers, of any kind, is moved among all the others. One opened
  // since comes after them.
  const rowTabs = orderedTabs([...items, ...replyTabs.items], state.order).map((tab) => ({ ...tab, order: PANEL_TAB_ORDER }));
  // A drop moves the tab within the panel's whole order: the tabs the sheet
  // hides, and the replies while their list has not come, keep their places.
  const reorder = (id: string, overId: string) => {
    store().setTabOrder(threadId, movedOrder(completeOrder(state.order, present), id, overId));
  };
  // A tab opened again from Reopen, in an ordered row: back after the tab
  // that stood before it, in the order as it is then (a reply comes back from
  // the server a moment later).
  const placeBack = (id: string, after: string | null) => {
    const saved = store().get(threadId).order;
    if (saved) store().setTabOrder(threadId, withTabBack(saved.filter((x) => x !== id), id, after));
  };
  // Reopen: a worker's, canvas's or file's tab where it stood, a reply as it
  // was first opened (the server's, on every device). The sheet lists only
  // what its row shows.
  const closed = usePanelClosedTabs({
    panel: threadPanel(threadId),
    row: rowTabs,
    own: state.tabs,
    shows: sheet ? inSheet : undefined,
    details: (id) => {
      const lines = state.fileLines?.[id];
      return lines ? { lines: { line: lines.line, end: lines.end } } : {};
    },
    reopen: (tab) => {
      if (tab.reply) {
        return openReplyTab(tab.reply.threadId, tab.reply.messageId, tab.reply.text, (id) => {
          store().openReply(threadId, id);
          placeBack(id, tab.rowAfter ?? null);
        });
      }
      store().reopenTab(threadId, tab.id, tab.after, tab.lines);
      placeBack(tab.id, tab.rowAfter ?? null);
      onWantFull?.();
    }
  });
  const closeRemembered = (id: string) => {
    closed.remember(id);
    closeTab(id);
  };

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
  ) : !narrow && (
    <PaneZoomButton
      zoomed={maximized === "panel"}
      onClick={() => store().setMaximized(maximized === "panel" ? null : "panel")}
    />
  );

  return (
    // In a sheet the body scrolls, this header with it: it is pinned there,
    // and a worker's tabs pin under its 44px (--worker-tabs-top). There it
    // holds the sheet's height only around a chat (data-fills-height): any
    // other view grows, or the pinned bars let go after a screen.
    <div data-slot={`worker-panel-${variant}`} className={cn("flex flex-1 flex-col", sheet ? "[--worker-tabs-top:2.75rem] has-[[data-fills-height]]:min-h-0" : "min-h-0")}>
      <PanelTabRow
        first={{ label: "Workers", icon: <LayoutList aria-hidden className="size-3.5 shrink-0" />, count: archivedWorkers ?? workers.length }}
        tabs={rowTabs.map((tab) => ({
          ...tab,
          onClose: () => {
            closed.remember(tab.id);
            tab.onClose?.();
          }
        }))}
        active={active === "workers" ? "first" : active}
        onSelect={(id) => {
          if (id === "first") return store().setActive(threadId, "workers");
          store().setActive(threadId, id);
          onWantFull?.();
        }}
        tools={tools}
        reopen={closed.menu}
        sticky={sheet}
        ariaLabel="Worker tabs"
        onReorder={reorder}
        moveMenu
      />
      {/* The side panel scrolls here. In a phone's sheet the sheet's own body
          scrolls — it holds the scroll until the sheet is pulled to full and
          resets it when the sheet settles at half — so this must not; it
          still passes the sheet's height down, which a worker's chat fills.
          A canvas scrolls inside its own view. */}
      {replyTabs.kept.map((tab) => <ReplyTabView key={tab.id} tab={tab} shown={tab === replyTabs.activeReply} />)}
      {!activeCanvas && !fileTabs.activeFile && !replyTabs.activeReply && (
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
                  workerId={active.slice(ARCHIVED.length)}
                  remember
                  onCloseTab={() => closeTab(active)}
                />
              )
          ) : archivedWorkers !== undefined ? (
            // The thread is archived, so its workers are, whatever this page
            // has heard yet: a tab left open from before reads as theirs do.
            <ArchivedSince key={active} threadId={threadId} workerId={active} onCloseTab={() => closeTab(active)} />
          ) : (
            <ActiveWorker threadId={threadId} workerId={active} workers={workers} projects={projects} onCloseTab={() => closeRemembered(active)} />
          )}
        </div>
      )}
      <PanelCanvasViews
        kept={canvasTabs.kept}
        active={activeCanvas}
        onClose={(canvasId) => closeRemembered(canvasTabId(canvasId))}
        openWorker={openWorkerHere}
      />
      <PanelFileViews kept={fileTabs.kept} active={fileTabs.activeFile} lines={state.fileLines ?? {}} />
    </div>
  );
}

/** The tabs the phone's sheet shows: every one but a canvas's or a file's. */
const inSheet = (tabId: string) => canvasIdOfTab(tabId) === null && filePathOfTab(tabId) === null;

/** A worker tab's state, in Home's colours, in the 14px an icon takes. */
function TabDot({ tone }: { tone: PillTone }) {
  return (
    <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
      <span data-slot="tab-dot" className={cn("size-2 rounded-full", PILL_DOT_CLASS[tone])} />
    </span>
  );
}

function ActiveWorker({ threadId, workerId, workers, projects, onCloseTab }: {
  threadId: string;
  workerId: string;
  workers: ThreadWorker[];
  projects: Project[];
  /** Closes this worker's tab, as the row's ✕ does. */
  onCloseTab: () => void;
}) {
  const tab = useWorkerPanelStore((s) => s.get(threadId).workerTab[workerId]);
  const found = findWorker(projects, workerId);
  const windowData = useSnapshotStore((s) => (
    found ? selectSnapshotWindow(s.snapshot, found.project.tmuxSessionName, found.worker.tmuxWindowName) : null
  ));
  const worker = workers.find((w) => w.workerId === workerId);
  if (!found) return <ArchivedSince threadId={threadId} workerId={workerId} onCloseTab={onCloseTab} />;
  const owner = found.worker.ownerThreadId;
  if (owner && owner !== threadId) {
    // Moved to another thread (an old report named it): point there rather
    // than direct it from here.
    return (
      <div className="p-4">
        <StateMessage title="Worker moved" action={<StateLink to={`${threadHref(owner)}?worker=${encodeURIComponent(workerId)}`}>Open it in its thread</StateLink>}>
          This worker belongs to another thread now.
        </StateMessage>
      </div>
    );
  }
  return (
    <WorkerView
      key={workerId}
      project={found.project}
      worker={found.worker}
      tab={tab ?? defaultWorkerTab(worker ?? { waiting: null })}
      onTabChange={(next) => useWorkerPanelStore.getState().setWorkerTab(threadId, workerId, next)}
      actions={
        // The worker's menu: Close and an archive close its tab and stay
        // in the thread.
        <WorkerActionsMenu
          workerId={found.worker.id}
          workerName={found.worker.name}
          workerMode={found.worker.mode}
          branch={found.worker.branch}
          hasWorktree={!!found.worker.worktreePath}
          window={windowData ?? undefined}
          pinned={!!found.worker.pinnedAt}
          onTogglePin={() => void useProjectsStore.getState().togglePin(found.worker.id)}
          onClose={onCloseTab}
          onArchived={onCloseTab}
        />
      }
    />
  );
}

/** An archived worker has three of the five tabs; the rest show its plan. */
function archivedTab(tab: WorkerTab | undefined): ArchivedTab | undefined {
  return tab === "chat" || tab === "plan" || tab === "canvases" ? tab : undefined;
}

/** A worker archived after its tab was opened, or an archived worker's tab
 *  whose details this panel does not hold (it was closed, or the page
 *  reloaded): fetched and shown read-only. `tabId` keys its remembered tab. */
function ArchivedSince({ threadId, workerId, tabId = workerId, remember = false, onCloseTab }: {
  threadId: string;
  workerId: string;
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
        const found = workers.find((w) => w.workerId === workerId) ?? null;
        setRef(found);
        if (found && remember) useWorkerPanelStore.getState().setArchivedRef(threadId, tabId, found);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setFailure(errorText(error));
        setRef("failed");
      });
    return () => { live = false; };
  }, [threadId, workerId, tabId, remember, attempt]);
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
      key={ref.workerId}
      worker={ref}
      tab={archivedTab(tab)}
      onTabChange={(next) => useWorkerPanelStore.getState().setWorkerTab(threadId, tabId, next)}
    />
  );
}

function findWorker(projects: Project[], workerId: string): { project: Project; worker: ProjectWorker } | null {
  for (const project of projects) {
    const worker = project.workers.find((w) => w.id === workerId);
    if (worker) return { project, worker };
  }
  return null;
}
