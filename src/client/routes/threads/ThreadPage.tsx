import { ThreadTaskTags } from "@/routes/task-board/ThreadTaskTags";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { MoreHorizontal, PanelRight, Tag, Trash2 } from "lucide-react";
import { threadChatInSight, useThreadChatInSight } from "./thread-chat-sight";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ChatPaneHeader, PaneHeaderActions, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { ScheduleChip } from "./ScheduleChip";
import type { DutySummaryDto } from "@shared/api/schedules";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useAgentChatStore, type AgentContextUsage } from "@/store/agent-chat";
import { useThreadWorkers, type ThreadWorker } from "@/hooks/useThreadWorkers";
import { cn } from "@/lib/utils";
import { SplitRow } from "@/components/SplitRow";
import { defaultWorkerTab, workerTabFromParam, type WorkerTab } from "@/lib/worker-groups";
import { useUIStore } from "@/store/ui";
import { useProjectsStore } from "@/store/projects";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { hasWorkItemFor } from "@/store/work-items";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { ContextBudgetPill } from "@/routes/window/chat/ContextBudgetPill";
import { ThreadMenu } from "./ThreadMenu";
import { ThreadLabelChips, ThreadLabels, ThreadLabelsSheet } from "./ThreadLabels";
import { WorkerPanel } from "./WorkerPanel";
import { useSheetBackStep } from "./sheet-back-step";
import { useMarkThreadSeen, useThreadReadPoint } from "./useMarkThreadSeen";
import { archivedReadOnlyNote } from "./archived-note";
import { ReplyTabTargetContext } from "@/routes/reply-tabs/reply-tab-target";
import { BackLink, InlineError, StateMessage } from "@/components/ViewState";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { formatCalendarDate } from "@/lib/format";
import type { ArchivedThreadDto, ThreadLabelDto } from "@shared/api/agents";
import { DeleteThreadDialog } from "./DeleteThreadDialogs";
import { CanvasOpenerProvider } from "@/routes/canvas/CanvasOpenerProvider";
import { FileOpenerProvider } from "@/routes/files/FileOpenerProvider";
import type { FileTarget } from "@/lib/file-link";
import { canvasIdOfTab, filePathOfTab } from "@/lib/panel-tabs";

const NO_LABELS: readonly ThreadLabelDto[] = [];

export function ThreadPage() {
  const { threadId = "" } = useParams<{ threadId: string }>();
  const open = useManagerThreadsStore((s) => s.threads.has(threadId));
  const archived = useManagerThreadsStore((s) => s.archived.find((t) => t.id === threadId) ?? null);
  // Both lists: an archived thread is in the second.
  const loaded = useManagerThreadsStore((s) => s.loaded && s.archivedLoaded);
  // The latest read failed: not there may only mean not read. Said so,
  // with a way to read it again.
  const unread = useManagerThreadsStore((s) => s.loaded && s.archivedReadFailed);
  const loadArchived = useManagerThreadsStore((s) => s.loadArchived);
  if (!open && !archived) {
    if (unread) {
      return (
        <div className="mx-auto w-full max-w-[44rem] px-4 pt-6">
          <InlineError onRetry={() => void loadArchived()}>Couldn't load the thread.</InlineError>
        </div>
      );
    }
    return loaded ? (
      <div className="mx-auto w-full max-w-[44rem] px-4 pt-6">
        <StateMessage title="Thread not found" heading="h1" action={<BackLink to="/home">Back to Home</BackLink>}>
          It was deleted, or the link is wrong.
        </StateMessage>
      </div>
    ) : null;
  }
  return <ThreadBody key={threadId} threadId={threadId} archived={open ? null : archived} />;
}

/** A thread's page. An archived one is read here too, read-only: nothing is
 *  marked seen or sent, and its menu only deletes it. */
function ThreadBody({ threadId, archived }: { threadId: string; archived: ArchivedThreadDto | null }) {
  const isMobile = useIsMobile();
  const thread = useManagerThreadsStore((s) => s.threads.get(threadId) ?? null);
  const workers = useThreadWorkers(threadId);
  const scope = useMemo(() => ({ type: "manager" as const, threadId }), [threadId]);
  const usage = useAgentChatStore((s) => s.threadsByScope.get(`manager:${threadId}`)?.contextUsage ?? null);
  const projects = useMemo(() => [...new Set(workers.map((w) => w.projectName))], [workers]);

  // Seen while it is the page; what came after the point read to is marked.
  const readPoint = useThreadReadPoint(threadId, true);
  useMarkThreadSeen(threadId, true);


  const panelState = useWorkerPanelStore((s) => s.get(threadId));
  // Never touched: open when the thread has workers, without writing that down.
  const panelWritten = useWorkerPanelStore((s) => threadId in s.byThread);
  const panelOpen = panelWritten ? panelState.open : workers.length > 0;
  const maximized = useWorkerPanelStore((s) => s.maximized);
  const narrow = useWorkerPanelStore((s) => s.narrow);
  const narrowView = useWorkerPanelStore((s) => s.narrowView);
  const sheet = useWorkerPanelStore((s) => s.sheet);
  // The window says whose chat it has in sight (NotificationsClient): what
  // the user reads there is not told to the personal agent.
  const chatInSight = threadChatInSight({ phone: isMobile, panelOpen, maximized, narrow, narrowView, sheet });
  useEffect(() => {
    if (!chatInSight) return;
    useThreadChatInSight.setState({ threadId });
    return () => {
      if (useThreadChatInSight.getState().threadId === threadId) useThreadChatInSight.setState({ threadId: null });
    };
  }, [threadId, chatInSight]);

  /** Opens a worker's tab: in the panel, or on a phone in the sheet, pulled
   *  to full height. */
  const openWorker = (workerId: string, tab?: WorkerTab) => {
    // Usually one of this thread's workers; an old report card can name one
    // that moved to another thread or was archived — its tab still opens
    // (read-only, or a note pointing to its thread).
    const w = workers.find((x) => x.workerId === workerId);
    const panel = useWorkerPanelStore.getState();
    // Its status picks the tab it opens on; until that arrives (a cold load),
    // nothing is recorded and the panel follows the status once it does.
    const remembered = panel.get(threadId).workerTab[workerId];
    panel.openWorker(threadId, workerId, tab ?? (remembered || !hasWorkItemFor(workerId) ? undefined : defaultWorkerTab(w ?? { waiting: null })));
    if (isMobile) panel.setSheet("full");
  };

  // On a desktop a canvas opens as a tab in the panel (the page's
  // CanvasOpenerProvider); a phone opens it full screen, as before.
  const openCanvas = useCallback((canvasId: string) => useWorkerPanelStore.getState().openCanvas(threadId, canvasId), [threadId]);
  // A file too.
  const openFile = useCallback((target: FileTarget) => useWorkerPanelStore.getState().openFile(threadId, target), [threadId]);
  // A reply opened from the thread's own chat goes to its panel: beside the
  // chat, or the sheet pulled to full height on a phone. Worker chats in the
  // panel have no target, so their replies get no button.
  const replyTarget = useMemo(() => ({
    threadId,
    open: (tabId: string) => {
      const panel = useWorkerPanelStore.getState();
      panel.openReply(threadId, tabId);
      if (isMobile) panel.setSheet("full");
    }
  }), [threadId, isMobile]);

  // The sheet belongs to the phone layout: a wider window closes it, so it does
  // not come back by itself when the window narrows again.
  useEffect(() => {
    if (!isMobile) useWorkerPanelStore.getState().setSheet("closed");
  }, [isMobile]);

  // On a phone the sheet is a step in the history: Back closes it before it
  // leaves the thread, and a step arrived on (Back from a page the sheet led
  // to, a reload) opens the sheet as it was left, at full height on a worker
  // (a canvas or file tab a wide window left open is not in the sheet: its
  // Workers list).
  const sheetOpen = useWorkerPanelStore((s) => s.sheet !== "closed");
  useSheetBackStep({
    open: sheetOpen,
    readOpen: () => useWorkerPanelStore.getState().sheet !== "closed",
    phone: isMobile,
    onBack: () => useWorkerPanelStore.getState().setSheet("closed"),
    onReturn: () => {
      const panel = useWorkerPanelStore.getState();
      const active = panel.get(threadId).active;
      panel.setSheet(active === "workers" || canvasIdOfTab(active) !== null || filePathOfTab(active) !== null ? "half" : "full");
    }
  });

  // Maximize, the sheet and a narrow row's side belong to the thread on
  // screen: leaving it restores them.
  useEffect(() => () => {
    const panel = useWorkerPanelStore.getState();
    panel.setMaximized(null);
    panel.setSheet("closed");
    panel.setNarrowView("chat");
  }, [threadId]);

  // ?worker=<workerId> opens that worker's tab (a link from Home, a worker
  // opened in a tab beside the personal agent), then leaves the URL. One the thread
  // no longer has opens as an old report card's does (read-only, or a note
  // pointing to its thread). Wait for the projects: the worker list is empty
  // until they arrive.
  const [searchParams, setSearchParams] = useSearchParams();
  const projectsReady = useProjectsStore((s) => s.loaded);
  const workerParam = searchParams.get("worker");
  // ?tab= with ?worker= names the page the worker opens on (Chat, Terminal…).
  const tabParam = workerTabFromParam(searchParams.get("tab"));
  const arrivingTab = useRef<WorkerTab | null>(null);
  // The worker the address asked for, held until the address has let go of
  // it: on a phone opening it adds the sheet's step to the history, and a
  // step added while the address still said ?worker= would keep it, and open
  // the worker again on every return to that entry.
  const arriving = useRef<string | null>(null);
  useEffect(() => {
    if (!workerParam || (!projectsReady && workers.length === 0)) return;
    arriving.current = workerParam;
    arrivingTab.current = tabParam;
    const next = new URLSearchParams(searchParams);
    next.delete("worker");
    next.delete("tab");
    setSearchParams(next, { replace: true });
    // The param is the trigger; the workers are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerParam, projectsReady, workers]);
  useEffect(() => {
    const workerId = arriving.current;
    if (!workerId || workerParam) return;
    arriving.current = null;
    openWorker(workerId, arrivingTab.current ?? undefined);
    arrivingTab.current = null;
    // openWorker reads the current workers; the address letting go is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerParam]);

  const archivedOn = archived ? formatCalendarDate(archived.archivedAt) : null;
  // An archived thread keeps its labels and can still be given them.
  const labels = archived ? archived.labels : thread?.labels ?? NO_LABELS;
  const title = archived
    ? (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span data-slot="archived-title" className="min-w-0 truncate text-sm font-semibold text-foreground">{archived.title}</span>
        <span data-slot="archived-date" className="shrink-0 text-2xs text-faint">Archived {archivedOn}</span>
        <ThreadLabels threadId={threadId} labels={labels} />
      </div>
    )
    : <ThreadTitle threadId={threadId} title={thread?.title ?? ""} projects={projects} duty={thread?.duty ?? null} labels={labels} />;
  const actions = archived ? <ArchivedThreadMenu thread={archived} /> : <ThreadMenu threadId={threadId} />;
  const conversation = (
    <ReplyTabTargetContext.Provider value={replyTarget}>
      <ChatConversation
        scope={scope}
        onOpenWorker={(workerId) => openWorker(workerId)}
        readOnlyNote={archived ? archivedReadOnlyNote(archived.archivedAt) : undefined}
        newSince={readPoint}
      />
    </ReplyTabTargetContext.Provider>
  );
  const shownUsage = archived ? null : usage;
  // An archived thread's workers were archived with it: counted as it had them.
  const workerCount = archived ? archived.workers : workers.length;
  if (isMobile) {
    return (
      <PhoneThread
        threadId={threadId}
        workers={workers}
        workerCount={workerCount}
        archivedWorkers={archived?.workers}
        usage={shownUsage}
        conversation={conversation}
        actions={actions}
        duty={archived ? null : thread?.duty ?? null}
        labels={labels}
      />
    );
  }
  // A narrow row shows the panel only in place of the chat.
  const panelInSight = panelOpen && (!narrow || narrowView === "panel");
  const toggleLabel = panelInSight ? "Hide panel" : "Show panel";
  return (
    // A canvas opened anywhere on the page opens as a tab in the panel.
    <CanvasOpenerProvider open={openCanvas}>
    <FileOpenerProvider open={openFile}>
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PaneHeaderTitle>{title}</PaneHeaderTitle>
      <PaneHeaderActions>
        <ContextBudgetPill usage={shownUsage} />
        {/* The panel's one toggle, there with it open or hidden and lit while
            it is in sight: it hides and shows it, and swaps a narrow row's sides. */}
        <Button
          variant="ghost"
          size="sm"
          data-slot="panel-toggle"
          aria-pressed={panelInSight}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => {
            const panel = useWorkerPanelStore.getState();
            if (narrow) {
              // Swaps the sides; back to the chat leaves the panel open for a wide row.
              if (!panelInSight) panel.setOpen(threadId, true);
              panel.setNarrowView(panelInSight ? "chat" : "panel");
              return;
            }
            panel.setOpen(threadId, !panelOpen);
            if (panelOpen && maximized) panel.setMaximized(null);
          }}
          className={cn("h-7 gap-1.5 px-2 text-xs", panelInSight ? "bg-sel text-foreground" : "text-chrome")}
        >
          <PanelRight className="h-3.5 w-3.5" />
          Panel
        </Button>
        {actions}
      </PaneHeaderActions>
      <ThreadSplitRow
        threadId={threadId}
        panelOpen={panelOpen}
        // The chat spans its pane, so its scrollbar runs at the pane's edge;
        // the transcript and the composer centre their own column. With both
        // sides in the row the header is the chat's, over its column, and
        // the panel's tabs take the band over the panel. A panel with the
        // row to itself hides the chat: the window's band comes back.
        chat={<div className="flex min-h-0 w-full flex-1 flex-col">{!narrow && !(panelOpen && maximized === "panel") && <ChatPaneHeader />}{conversation}</div>}
        panel={<WorkerPanel threadId={threadId} workers={workers} archivedWorkers={archived?.workers} />}
      />
    </div>
    </FileOpenerProvider>
    </CanvasOpenerProvider>
  );
}

/** A phone: the chat full screen, the thread's title
 *  in the top bar, and the worker panel as a sheet — half height, pulled up
 *  to full when a worker opens. */
function PhoneThread({ threadId, workers, workerCount, archivedWorkers, usage, conversation, actions, duty, labels }: {
  threadId: string;
  duty: DutySummaryDto | null;
  labels: readonly ThreadLabelDto[];
  workers: ThreadWorker[];
  workerCount: number;
  archivedWorkers?: number;
  usage: AgentContextUsage | null;
  conversation: React.ReactNode;
  actions: React.ReactNode;
}) {
  const sheet = useWorkerPanelStore((s) => s.sheet);
  const setSheet = useWorkerPanelStore((s) => s.setSheet);
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PaneHeaderActions>
        <ContextBudgetPill usage={usage} compact />
        <Button variant="ghost" size="sm" aria-label="Workers" onClick={() => setSheet("half")} className="h-7 gap-1 px-2 text-xs">
          Workers
          {workerCount > 0 && <span className="num text-2xs text-faint">{workerCount}</span>}
        </Button>
        {actions}
      </PaneHeaderActions>
      {/* Under the title, not beside it: the top bar has room for the title only. */}
      {duty && (
        <div data-slot="phone-duty-row" className="flex shrink-0 border-b border-border-soft px-3 py-1">
          <ScheduleChip duty={duty} />
        </div>
      )}
      {/* Every label, wrapping: the menu's Labels… edits them. */}
      {labels.length > 0 && (
        <div data-slot="phone-labels-row" className="flex shrink-0 flex-wrap gap-1 border-b border-border-soft px-3 py-1">
          <ThreadLabelChips labels={labels} />
        </div>
      )}
      <div className="flex min-h-0 w-full flex-1 flex-col">{conversation}</div>
      <BottomSheet
        open={sheet !== "closed"}
        onOpenChange={(open) => setSheet(open ? "half" : "closed")}
        full={sheet === "full"}
        // vaul resets its snap point as it closes: that must not reopen it.
        onFullChange={(full) => { if (useWorkerPanelStore.getState().sheet !== "closed") setSheet(full ? "full" : "half"); }}
        slot="worker-sheet"
        // A column, so the panel gets the sheet's height: a worker's chat
        // fills it with its composer at the bottom, as it does in the side panel.
        bodyClassName="flex flex-col"
        // Named for a screen reader; on screen the panel's Workers tab says it.
        header={<BottomSheetTitle className="sr-only">Workers</BottomSheetTitle>}
      >
        <WorkerPanel threadId={threadId} workers={workers} archivedWorkers={archivedWorkers} variant="sheet" onWantFull={() => setSheet("full")} />
      </BottomSheet>
    </div>
  );
}

/** The chat and the worker panel side by side (SplitRow), on the worker
 *  panel's store: its open state, maximize, narrow view and share of the row. */
function ThreadSplitRow({ threadId, panelOpen, chat, panel }: {
  threadId: string;
  panelOpen: boolean;
  chat: React.ReactNode;
  panel: React.ReactNode;
}) {
  const maximized = useWorkerPanelStore((s) => s.maximized);
  const narrowView = useWorkerPanelStore((s) => s.narrowView);
  const ratio = useUIStore((s) => s.workerPanelRatio);
  const setRatio = useUIStore((s) => s.setWorkerPanelRatio);
  const store = useWorkerPanelStore.getState;
  return (
    <SplitRow
      open={panelOpen}
      maximized={maximized === "panel"}
      narrowView={narrowView === "panel" ? "side" : "chat"}
      onNarrow={(narrow) => store().setNarrow(narrow)}
      onNarrowView={(view) => store().setNarrowView(view === "side" ? "panel" : "chat")}
      onMaximized={(on) => store().setMaximized(on ? "panel" : null)}
      onOpen={() => store().setOpen(threadId, true)}
      ratio={ratio}
      onRatio={setRatio}
      slots={{ chat: "thread-chat", side: "worker-panel" }}
      labels={{ side: "Worker panel", resize: "Resize worker panel", valueSuffix: "workers" }}
      chat={chat}
      side={panel}
    />
  );
}

function ThreadTitle({ threadId, title, projects, duty, labels }: {
  threadId: string; title: string; projects: string[]; duty: DutySummaryDto | null; labels: readonly ThreadLabelDto[];
}) {
  const rename = useManagerThreadsStore((s) => s.rename);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const commit = async () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) { setDraft(title); return; }
    const r = await rename(threadId, next);
    if ("error" in r) { toast.error(r.error); setDraft(title); }
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {editing ? (
        <input
          aria-label="Thread title"
          autoFocus
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") { setDraft(title); setEditing(false); } }}
          className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-semibold outline-none ring-1 ring-border"
        />
      ) : (
        <button type="button" title="Rename" onClick={() => { setDraft(title); setEditing(true); }} className="min-w-0 truncate text-left text-sm font-semibold text-foreground">
          {title}
        </button>
      )}
      {projects.map((p) => (
        <span key={p} data-slot="thread-project" className="shrink-0 text-2xs text-faint">{p}</span>
      ))}
      {duty && <ScheduleChip duty={duty} />}
      <ThreadTaskTags threadId={threadId} />
      <ThreadLabels threadId={threadId} labels={labels} />
    </div>
  );
}

/** An archived thread's menu: it can only be deleted; on a phone, where the
 *  header has no room for them, its labels are edited from here too. */
function ArchivedThreadMenu({ thread }: { thread: ArchivedThreadDto }) {
  const isMobile = useIsMobile();
  const [deleting, setDeleting] = useState(false);
  const [labelling, setLabelling] = useState(false);
  // The Labels sheet gives focus back to this button when it closes.
  const [menuButton, setMenuButton] = useState<HTMLButtonElement | null>(null);
  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={setMenuButton} variant="ghost" size="icon-xs" aria-label="Thread actions" className="text-chrome">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {isMobile && (
          <DropdownMenuItem onSelect={() => setLabelling(true)}>
            <Tag className="h-4 w-4" />
            Labels…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
          <Trash2 className="h-4 w-4" />
          Delete permanently…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {isMobile && <ThreadLabelsSheet threadId={thread.id} labels={thread.labels} open={labelling} onOpenChange={setLabelling} returnFocus={menuButton} />}
    {deleting && <DeleteThreadDialog thread={thread} onDone={() => setDeleting(false)} />}
    </>
  );
}
