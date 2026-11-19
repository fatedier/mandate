import { useCallback, useContext, useEffect, useState } from "react";
import { PageShownContext } from "@/lib/page-shown";
import { HistoryTab } from "@/routes/personal/HistoryTab";
import type { PanelTabItem } from "@/components/PanelTabRow";
import { useNavigate } from "react-router";
import { History, Loader2, PanelTop, Quote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PaneZoomButton } from "@/components/PaneZoomButton";
import { LoadingLine } from "@/components/ViewState";
import { formatClockMinutes } from "@/lib/format";
import { scopeKey, useAgentChatStore } from "@/store/agent-chat";
import { usePageQuotes, usePageQuotesOf } from "@/store/page-quotes";
import { PAGE_QUOTES_MAX } from "@shared/page-quotes";
import { useAgentPageStore } from "@/store/agent-page";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { AGENT_PAGE_FIRST, type AgentPageVersionDto } from "@shared/api/agent-page";
import { pageFailureShown } from "@shared/page-run-failure";
import { AgentPageFrame } from "./AgentPageFrame";
import { hasPage } from "./page-place";
import { SourcesMenu } from "./SourcesMenu";
import { UpdatesMenu } from "./UpdatesMenu";
import { PanelTabRow } from "@/components/PanelTabRow";
import { TerminalControlsSlot, TerminalControlsSlotProvider } from "@/routes/terminal/terminal-controls-slot";
import { useIsMobile } from "@/hooks/useIsMobile";
import { CALENDAR_TAB, canvasIdOfTab, canvasTabId, completeOrder, filePathOfTab, movedOrder, NOTES_TAB, orderedIds, orderedTabs, PANEL_TAB_ORDER, reconciledOrder, replyIdOfTab, replyTabId, taskIdOfTab, taskTabId, TASKS_TAB, terminalOfTab, threadIdOfTab, threadTabId, withTabBack } from "@/lib/panel-tabs";
import { useReplyTabs, useReplyTabsStore } from "@/store/reply-tabs";
import { useThreadTabsStore } from "@/store/thread-tabs";
import { usePanelTerminalTabs } from "@/routes/terminals/terminal-panel-tab";
import { keptTerminalLimit, useKeptTerminals } from "@/routes/terminals/kept-terminals";
import { TerminalTab } from "@/routes/terminals/TerminalTab";
import { TasksPanelTab, TaskTabView } from "@/routes/task-board/TasksPanelTab";
import { usePanelTaskTabs, useTasksPanelTab } from "@/routes/task-board/tasks-panel-tab";
import { useNotesPanelTab } from "@/routes/sticky-notes/notes-panel-tab";
import { NotesPanelTab } from "@/routes/sticky-notes/NotesPanelTab";
import { useCalendarPanelTab } from "@/routes/calendar/calendar-panel-tab";
import { CalendarPanelTab } from "@/routes/calendar/CalendarPanelTab";
import { canvasIdOfPath, canvasPathOf } from "@/lib/canvas-link";
import { useOpenCanvas } from "@/routes/canvas/canvas-opener";
import { cn } from "@/lib/utils";
import { usePanelCanvasTabs } from "@/routes/canvas/panel-canvas-tabs";
import { PanelCanvasViews } from "@/routes/canvas/PanelCanvasViews";
import { usePanelFileTabs } from "@/routes/files/panel-file-tabs";
import { PanelFileViews } from "@/routes/files/PanelFileViews";
import { usePanelReplyTabs } from "@/routes/reply-tabs/panel-reply-tabs";
import { ReplyTabView } from "@/routes/reply-tabs/ReplyTabView";
import { usePanelThreadTabs } from "@/routes/thread-tabs/panel-thread-tabs";
import { ThreadTabView } from "@/routes/thread-tabs/ThreadTabView";
import { AddThreadMenu } from "@/routes/thread-tabs/AddThreadMenu";
import { openThreadBeside } from "@/routes/thread-tabs/open-thread-beside";
import { openReplyTab } from "@/routes/reply-tabs/open-reply-tab";
import { usePanelClosedTabs } from "@/routes/closed-tabs/panel-closed-tabs";
import { PERSONAL_PANEL } from "@/store/closed-tabs";

/** How often the usage source is read again while the page is shown. */
export const PAGE_USAGE_REFRESH_MS = 5 * 60_000;

/**
 * Personal agent's page beside its chat: a header that says when it was last
 * published and how its page subagent is doing, its sources, and the page in
 * its frame. A version that lands while the user types in one of its fields
 * waits for them: until they leave the field, or press Reload.
 */
export function AgentPagePane({ name, threadId }: { name: string; threadId: string }) {
  const state = useAgentPageStore((s) => s.state);
  const version = useAgentPageStore((s) => s.version);
  const sources = useAgentPageStore((s) => s.sources);
  const updates = useAgentPageStore((s) => s.updates);
  const data = useAgentPageStore((s) => s.data);
  const followed = useAgentPageStore((s) => s.followed);
  const held = useAgentPageStore((s) => s.held);
  const heldCleared = useAgentPageStore((s) => s.heldCleared);
  const maximized = useAgentPageUi((s) => s.maximized);
  const narrow = useAgentPageUi((s) => s.narrow);
  // The side in sight: what a thread tab shows is then seen.
  const inSight = useAgentPageUi((s) => s.open && (!s.narrow || s.narrowView === "side"));
  const navigate = useNavigate();

  // Read now, and again whenever the event stream comes back (a change
  // published while it was down is not sent again). Usage, now and then.
  useEffect(() => {
    const refresh = () => { void useAgentPageStore.getState().refresh().catch(() => {}); };
    refresh();
    window.addEventListener("mandate:sse-open", refresh);
    const usage = window.setInterval(() => {
      const store = useAgentPageStore.getState();
      if (store.followed.has("usage")) void store.fetchData("usage").catch(() => {});
    }, PAGE_USAGE_REFRESH_MS);
    return () => {
      window.removeEventListener("mandate:sse-open", refresh);
      window.clearInterval(usage);
    };
  }, []);

  // The version kept while a field of it has focus; null: the latest shows.
  const [pinned, setPinned] = useState<AgentPageVersionDto | null>(null);
  const shown = pinned ?? version;
  const newer = pinned !== null && version !== null && version.revision > pinned.revision;
  const onFocus = useCallback((inField: boolean) => {
    // Typing holds the version on screen, from one field to the next;
    // leaving the fields lets the latest in.
    setPinned((current) => (inField ? current ?? useAgentPageStore.getState().version : null));
  }, []);
  // The page of the folder in sight: the one asked for, while the version
  // shown has it.
  const pagePath = useAgentPageUi((s) => s.pagePath);
  const page = shown && hasPage(shown.pages, pagePath) ? pagePath : AGENT_PAGE_FIRST;
  const onGo = useCallback((path: string) => { useAgentPageUi.getState().setPagePath(path); }, []);
  const onFields = useCallback((values: Record<string, string>) => { useAgentPageStore.getState().setHeld(page, values); }, [page]);
  // Only data kept current: a source nobody follows may be old, so a get
  // waits for the read that following it starts.
  const readData = useCallback((source: string) => (followed.has(source) ? data.get(source) ?? null : null), [data, followed]);
  const subscribe = useCallback((source: string) => { useAgentPageStore.getState().follow(source); }, []);
  const unsubscribe = useCallback((source: string) => { useAgentPageStore.getState().unfollow(source); }, []);
  // A kept answer lets go of what was typed on the page it came from, here
  // too: the frame that sent it may be gone by then (the user went to the
  // chat, or to another page).
  const submit = useCallback(async (value: unknown) => {
    const result = await useAgentPageStore.getState().submit(value);
    if (result.ok) useAgentPageStore.getState().clearHeld(page);
    return result;
  }, [page]);
  // A canvas the page links to opens as any canvas does on this page (beside
  // the chat on a desktop); another of Mandate's pages is gone to.
  const openCanvas = useOpenCanvas();
  const open = useCallback((path: string) => {
    const canvas = canvasPathOf(path, window.location.href);
    const canvasId = canvas ? canvasIdOfPath(canvas) : null;
    if (canvas && canvasId) openCanvas(canvasId, canvas);
    else void navigate(path);
  }, [navigate, openCanvas]);

  const write = state?.write ?? null;
  const latest = state?.latest ?? null;
  const updating = write?.status === "running";
  // A failure after the page last changed: the page shown is the last good one.
  const failed = write?.status === "failed" && (!latest || (write.finishedAt ?? "") >= latest.createdAt) ? write : null;
  const failedShown = failed?.error ? pageFailureShown(failed.error, name) : null;
  const ui = useAgentPageUi.getState;
  // Canvases open beside the page as tabs on a desktop; a phone shows the
  // page without them (a canvas opens full screen there).
  const phone = useIsMobile();
  const savedTabs = useAgentPageUi((s) => s.tabs);
  const savedActive = useAgentPageUi((s) => s.active);
  const tabIds = phone ? NO_TABS : savedTabs;
  // What closing a tab may go back to: on a phone, none of the canvas or file tabs it hides.
  const rowShows = phone ? onPhoneRow : undefined;
  // The personal agent's own conversation beside it, when opened: first after Page.
  const history = useAgentPageUi((s) => s.history);
  const historyTab: PanelTabItem[] = history
    ? [{ id: "history", label: "History", icon: <History aria-hidden className="size-3.5 shrink-0" />, onClose: () => ui().closeHistory(rowShows) }]
    : [];
  // The owner's tasks, after History, when opened: on a phone too (a task
  // chosen there opens full screen, so no task has a tab of its own).
  const tasksTab = useTasksPanelTab(savedTabs.includes(TASKS_TAB), rowShows);
  // The agent's sticky notes, after Tasks, when opened: on a phone too.
  const notesTab = useNotesPanelTab(savedTabs.includes(NOTES_TAB), rowShows);
  // The agent's calendar, after Notes, when opened: on a phone too.
  const calendarTab = useCalendarPanelTab(savedTabs.includes(CALENDAR_TAB), rowShows);
  // The row by kind: after History and Tasks, each task opened (in the order
  // opened), then the threads opened beside the agent, then the files and
  // canvases, then the replies opened here; threads and replies on a phone
  // too: they are the server's, the same on every device.
  const taskTabIds = tabIds.filter((id) => taskIdOfTab(id) !== null);
  const lead = [...[...historyTab, ...tasksTab, ...notesTab, ...calendarTab].map((tab) => tab.id), ...taskTabIds];
  const tabGone = useCallback((tabId: string, before: string) => useAgentPageUi.getState().tabGone(tabId, before, rowShows), [rowShows]);
  // The row after Page in the order the person dragged it into (this
  // browser's): any tab among all the others. One opened since comes after.
  const order = useAgentPageUi((s) => s.order);
  const ownAfterThreads = tabIds.filter((id) => id !== TASKS_TAB && id !== NOTES_TAB && id !== CALENDAR_TAB && taskIdOfTab(id) === null);
  const replyList = useReplyTabs(threadId);
  const replyIds = replyList.map((tab) => replyTabId(tab.id));
  const threadList = useThreadTabsStore((s) => s.tabs);
  const threadTabs = usePanelThreadTabs({ active: savedActive, before: lead, after: [...ownAfterThreads, ...replyIds], order, home: "page", gone: tabGone });
  // The panel's own tabs as the row draws them, with what stands before them.
  const ownOrder = [...lead, ...threadTabs.ids, ...ownAfterThreads];
  const replyTabs = usePanelReplyTabs(threadId, { active: savedActive, before: ownOrder, order, home: "page", gone: tabGone });
  const drawnOrder = orderedIds([...ownOrder, ...replyTabs.ids], order);
  const threadsLoaded = useThreadTabsStore((s) => s.tabs !== null);
  const repliesLoaded = useReplyTabsStore((s) => s.byThread.has(threadId));
  // Every tab the panel has, those a phone's row hides too, as the row would
  // draw them all: a drop moves one among these, so the hidden keep their places.
  const ownKind = (id: string) => id === TASKS_TAB || id === NOTES_TAB || id === CALENDAR_TAB;
  const everyTab = [
    ...[...historyTab, ...tasksTab, ...notesTab, ...calendarTab].map((tab) => tab.id), ...savedTabs.filter((id) => taskIdOfTab(id) !== null),
    ...threadTabs.ids, ...savedTabs.filter((id) => !ownKind(id) && taskIdOfTab(id) === null), ...replyTabs.ids
  ];
  // Once the person has given the row an order it lists every tab: one that
  // comes goes last; one goes once it is gone (a thread's or a reply's once
  // the server has let it go; while its list has not come, it keeps its place).
  const everyKey = everyTab.join("\n");
  const orderKey = order?.join("\n");
  // When the server made each of its tabs: several that came while the
  // panel was not drawn go in that order.
  const cameKey = [...(threadList ?? []).map((tab) => `${threadTabId(tab.threadId)}\t${tab.createdAt}`), ...replyList.map((tab) => `${replyTabId(tab.id)}\t${tab.createdAt}`)].join("\n");
  useEffect(() => {
    const saved = useAgentPageUi.getState().order;
    if (!saved) return;
    // The server's tabs wait until both of its lists are in: those that came
    // unseen go in the order the server made them, whichever list answers
    // first. The panel's own tabs join at once.
    const waiting = (id: string) => (!threadsLoaded || !repliesLoaded) && (threadIdOfTab(id) !== null || replyIdOfTab(id) !== null);
    const came = new Map(cameKey ? cameKey.split("\n").map((line) => { const [id, at] = line.split("\t"); return [id!, Date.parse(at!)] as const; }) : []);
    const next = reconciledOrder(saved, everyKey ? everyKey.split("\n") : [], (id) => came.get(id) ?? Infinity, waiting);
    if (next.join("\n") !== saved.join("\n")) useAgentPageUi.getState().keepTabOrder(next);
  }, [everyKey, orderKey, cameKey, threadsLoaded, repliesLoaded]);
  // A drop moves the tab within the panel's whole order: the tabs a phone's
  // row hides, and the server's while their list has not come, keep their places.
  const reorder = (id: string, overId: string) => ui().setTabOrder(movedOrder(completeOrder(order, everyTab), id, overId));
  // A tab opened again from Reopen, in an ordered row: back after the tab
  // that stood before it, in the order as it is then (a thread or a reply
  // comes back from the server a moment later).
  const placeBack = (id: string, after: string | null) => {
    const saved = ui().order;
    if (saved) ui().setTabOrder(withTabBack(saved.filter((x) => x !== id), id, after));
  };
  const active = (history && savedActive === "history") || (tasksTab.length > 0 && savedActive === TASKS_TAB) || (notesTab.length > 0 && savedActive === NOTES_TAB) || (calendarTab.length > 0 && savedActive === CALENDAR_TAB) || tabIds.includes(savedActive) || replyTabs.ids.includes(savedActive) || threadTabs.ids.includes(savedActive) ? savedActive : "page";
  // One of the panel's own tabs closed with nothing shown before it goes to
  // the tab on its left in the row as drawn, Page when it led. The nearest
  // one still kept: several can close in one pass (tasks deleted together),
  // and the row drawn then no longer holds the earlier ones.
  const leftOf = (id: string) => {
    const kept = ui().tabs;
    const gone = (tab: string) => tabIds.includes(tab) && !kept.includes(tab);
    return drawnOrder.slice(0, Math.max(drawnOrder.indexOf(id), 0)).reverse().find((tab) => !gone(tab)) ?? "page";
  };
  const closeOwn = (id: string) => { ui().closeTab(id, leftOf(id), rowShows); };
  // History, Tasks, Notes and Calendar close as the others do: to the tab on
  // their left as drawn.
  const closeBuiltIn = (id: string) => (id === "history" ? ui().closeHistory(rowShows, leftOf(id)) : closeOwn(id));
  const builtIn = (id: string) => id === "history" || id === TASKS_TAB || id === NOTES_TAB || id === CALENDAR_TAB;
  const canvasTabs = usePanelCanvasTabs(tabIds, active, closeOwn);
  const fileTabs = usePanelFileTabs(tabIds, active, closeOwn);
  const taskTabs = usePanelTaskTabs(tabIds, active, closeOwn);
  const terminalTabs = usePanelTerminalTabs(tabIds, active, closeOwn);
  // A phone's panel shows no terminal tabs: it keeps none.
  const keptTerminals = useKeptTerminals("agent-panel", !phone && terminalTabs.activeTerminal ? active : null, keptTerminalLimit(false), phone ? NO_TABS : [...terminalTabs.items.keys()]);
  const fileLines = useAgentPageUi((s) => s.fileLines);
  const rowTabs = orderedTabs([
    ...historyTab, ...tasksTab, ...notesTab, ...calendarTab, ...taskTabIds.flatMap((id) => taskTabs.items.get(id) ?? []),
    ...threadTabs.items, ...tabIds.flatMap((id) => canvasTabs.items.get(id) ?? fileTabs.items.get(id) ?? terminalTabs.items.get(id) ?? []), ...replyTabs.items
  ], order).map((tab) => ({ ...tab, order: PANEL_TAB_ORDER, ...(builtIn(tab.id) ? { onClose: () => closeBuiltIn(tab.id) } : {}) }));
  // Reopen: History and Tasks to their own places, a canvas or file where
  // it stood, a thread or a reply as it was first opened (the server's, on
  // every device). A phone lists only what its row shows.
  const closed = usePanelClosedTabs({
    panel: PERSONAL_PANEL,
    row: rowTabs,
    own: savedTabs,
    shows: rowShows,
    details: (id) => {
      const lines = fileLines[id];
      return lines ? { lines: { line: lines.line, end: lines.end } } : {};
    },
    reopen: (tab) => {
      const thread = threadIdOfTab(tab.id);
      if (thread !== null) {
        return openThreadBeside(thread).then((shown) => {
          if (shown) placeBack(threadTabId(thread), tab.rowAfter ?? null);
          return shown;
        });
      }
      if (tab.reply) {
        return openReplyTab(tab.reply.threadId, tab.reply.messageId, tab.reply.text, (id) => {
          ui().openReply(id);
          placeBack(id, tab.rowAfter ?? null);
        });
      }
      if (tab.id === "history") ui().openHistory();
      else if (tab.id === TASKS_TAB) ui().openTasks();
      else if (tab.id === NOTES_TAB) ui().openNotes();
      else if (tab.id === CALENDAR_TAB) ui().openCalendar();
      else ui().reopenTab(tab.id, tab.after, tab.lines);
      placeBack(tab.id, tab.rowAfter ?? null);
    }
  });
  const closeRemembered = (id: string) => {
    closed.remember(id);
    closeOwn(id);
  };
  // Quoting: the user picks an item the page marks (data-quote), and it goes
  // into the chat's composer. Each frame says whether its page marks one; the
  // mode lasts while that page is in sight, and ends with a pick, Cancel, Esc,
  // another version or page, another tab, the chat brought back, or another
  // of the app's pages shown (this one kept meanwhile, shell/KeptPage).
  const quoteKey = scopeKey({ type: "personal", threadId });
  const quoteFull = usePageQuotesOf(quoteKey).length >= PAGE_QUOTES_MAX;
  const frameKey = shown ? `${shown.revision}\n${page}` : null;
  const [quotable, setQuotable] = useState<{ frame: string | null; any: boolean }>({ frame: null, any: false });
  const canQuote = quotable.any && quotable.frame === frameKey;
  const [quotingAsked, setQuoting] = useState(false);
  const pageShown = useContext(PageShownContext);
  const quoting = quotingAsked && canQuote && !quoteFull && inSight && active === "page" && pageShown;
  if (quotingAsked && !quoting) setQuoting(false);
  // Kept hidden, the pane may not draw again before it shows: its effects
  // end as it hides, and the mode with them.
  useEffect(() => () => setQuoting(false), []);
  const onQuotable = useCallback((any: boolean) => setQuotable({ frame: frameKey, any }), [frameKey]);
  const onQuote = useCallback((text: string) => {
    usePageQuotes.getState().add(quoteKey, { path: page, text });
    setQuoting(false);
    // One side at a time: the composer the quote went to comes back.
    if (useAgentPageUi.getState().narrow) useAgentPageUi.getState().setNarrowView("chat");
  }, [quoteKey, page]);
  const onQuoteEnd = useCallback(() => setQuoting(false), []);
  // Esc in the app ends it too (in the page, the frame says so).
  useEffect(() => {
    if (!quoting) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) setQuoting(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [quoting]);
  const zoom = !narrow && <PaneZoomButton kind="page" zoomed={maximized} onClick={() => ui().setMaximized(!maximized)} />;
  const said = (
    <>
      {latest && <span className="num min-w-0 truncate text-xs text-faint">· updated {formatClockMinutes(latest.createdAt)}</span>}
      {updating && (
        <span data-slot="page-updating" className="flex shrink-0 items-center gap-1 text-xs text-live">
          <Loader2 aria-hidden className="size-3 animate-spin" />
          Updating…
        </span>
      )}
      {!updating && failed && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" data-slot="page-failed" title={failedShown ?? undefined} className="hit relative shrink-0 text-xs text-destructive">
              · Update failed
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(300px,calc(100vw-2rem))] text-xs leading-relaxed">
            {failedShown}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
  // What the user can do from the bar: take the new version, the page's
  // updates and sources. Together they go under the title when the row is
  // too narrow for both (a phone, while a new version waits).
  const actions = (
    <>
      {newer && (
        <Button size="xs" onClick={() => setPinned(null)} className="shrink-0">New version — Reload</Button>
      )}
      {updates.length > 0 && (
        <UpdatesMenu
          updates={updates}
          onPause={(update, paused) => useAgentPageStore.getState().setUpdatePaused(update, paused)}
          onRemove={(update) => useAgentPageStore.getState().removeUpdate(update)}
        />
      )}
      {sources.length > 0 && (
        <SourcesMenu
          sources={sources}
          onPause={(source, paused) => useAgentPageStore.getState().setPaused(source, paused)}
          onRemove={(source) => useAgentPageStore.getState().remove(source)}
        />
      )}
      {canQuote && (
        <button
          type="button"
          data-slot="page-quote"
          aria-pressed={quoting}
          disabled={quoteFull}
          title={quoteFull ? "Up to 3 quotes" : "Quote an item in the chat"}
          onClick={() => setQuoting(!quoting)}
          className={cn(
            "hit relative flex h-7 shrink-0 items-center gap-1.5 rounded-sm border px-2 text-xs transition-colors disabled:opacity-50",
            quoting ? "border-border bg-sel text-foreground" : "border-border-soft text-chrome hover:text-foreground"
          )}
        >
          <Quote aria-hidden className="size-3.5" />
          Quote
        </button>
      )}
    </>
  );
  // A terminal tab draws no header of its own: its controls end the row,
  // before the panel's ⤢.
  return (
    <TerminalControlsSlotProvider>
    <div data-pane-mode="page" className="flex min-h-0 flex-1 flex-col">
      {/* On a phone too: its + opens Tasks or a thread beside the agent from
          the start. A phone's row has no tools: the bar's Chat goes back. */}
      <PanelTabRow
        first={{ label: "Page", icon: <PanelTop aria-hidden className="size-3.5 shrink-0" /> }}
        tabs={rowTabs.map((tab) => ({
          ...tab,
          onClose: () => {
            closed.remember(tab.id);
            tab.onClose?.();
          }
        }))}
        active={active === "page" ? "first" : active}
        onSelect={(id) => ui().setActive(id === "first" ? "page" : id)}
        tools={phone ? null : <><TerminalControlsSlot />{zoom}</>}
        after={<AddThreadMenu name={name} />}
        reopen={closed.menu}
        ariaLabel="Page tabs"
        onReorder={reorder}
        moveMenu
      />
      {/* The panel's body, under its row: the place the terminals kept behind
          the tab shown sit in, at its size. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Kept while a canvas tab shows: its frame and what was typed in it
          stay as they were. */}
      <div data-slot="agent-page-body" className={cn("min-h-0 flex-1 flex-col", active === "page" ? "flex" : "hidden")}>
        {/* Its title, when it was updated and how its writer is doing, its
            sources: under the tab row (as a canvas tab's bar). The row says
            Page already, so the bar comes only with something of its own to
            say. */}
        {(latest || updating || failed || newer || sources.length > 0 || updates.length > 0 || canQuote) && <div data-slot="page-toolbar" className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border-soft py-1.5 pl-3 pr-2 pointer-coarse:gap-x-3">
          <div className="flex flex-1 items-center gap-2 pointer-coarse:gap-3">
            <span className="shrink-0 text-sm font-semibold text-foreground">Page</span>
            {said}
          </div>
          <div data-slot="page-toolbar-actions" className="ml-auto flex flex-wrap items-center justify-end gap-2 pointer-coarse:gap-3">{actions}</div>
        </div>}
        {/* While the user picks an item to quote, the pressed Quote and the
            page's outlined items say so; Quote again, Esc or a pick ends it. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {state === null ? (
            <div className="px-4 pt-6"><LoadingLine /></div>
          ) : !latest ? (
            <PageEmptyState name={name} threadId={threadId} making={updating} />
          ) : !shown ? (
            <div className="px-4 pt-6"><LoadingLine /></div>
          ) : (
            <AgentPageFrame
              version={shown}
              path={page}
              onGo={onGo}
              held={hasPage(held, page) ? held[page]! : NO_FIELDS}
              onFields={onFields}
              onFocus={onFocus}
              data={readData}
              subscribe={subscribe}
              unsubscribe={unsubscribe}
              submit={submit}
              open={open}
              clearCount={hasPage(heldCleared, page) ? heldCleared[page]! : 0}
              quoting={quoting}
              onQuotable={onQuotable}
              onQuote={onQuote}
              onQuoteEnd={onQuoteEnd}
            />
          )}
        </div>
      </div>
      <PanelCanvasViews kept={canvasTabs.kept} active={canvasTabs.activeCanvas} onClose={(canvasId) => closeRemembered(canvasTabId(canvasId))} />
      <PanelFileViews kept={fileTabs.kept} active={fileTabs.activeFile} lines={fileLines} />
      {replyTabs.kept.map((tab) => <ReplyTabView key={tab.id} tab={tab} shown={tab === replyTabs.activeReply} />)}
      {/* Shown when it is the tab in sight; it keeps its place itself. */}
      {history && active === "history" && <HistoryTab threadId={threadId} />}
      {active === TASKS_TAB && <TasksPanelTab />}
      {active === NOTES_TAB && <NotesPanelTab />}
      {active === CALENDAR_TAB && <CalendarPanelTab />}
      {/* The terminals shown last stay connected behind the tab shown,
          hidden by visibility, which keeps their size: at no size, one fitted
          to the browser would shrink its pane. */}
      {keptTerminals.map((key) => {
        const terminal = terminalOfTab(key)!;
        const isShown = key === active;
        return (
          <div key={key} data-kept-terminal={key} inert={!isShown} className={cn("absolute inset-0 flex flex-col", !isShown && "invisible")}>
            <TerminalTab paneId={terminal.paneId} pid={terminal.pid} shown={isShown} />
          </div>
        );
      })}
      {taskTabs.activeTask && <TaskTabView key={taskTabs.activeTask} taskId={taskTabs.activeTask} onClose={() => closeOwn(taskTabId(taskTabs.activeTask!))} />}
      {/* Only the one shown: a conversation drawn is live, and comes back at its latest. */}
      {threadTabs.activeThreadId && <ThreadTabView key={threadTabs.activeThreadId} threadId={threadTabs.activeThreadId} inSight={inSight} />}
      </div>
    </div>
    </TerminalControlsSlotProvider>
  );
}

const NO_TABS: string[] = [];
const NO_FIELDS: Record<string, string> = {};
/** A phone's row: no canvas, file or task tabs (they open full screen there). */
const onPhoneRow = (tabId: string) => canvasIdOfTab(tabId) === null && filePathOfTab(tabId) === null && taskIdOfTab(tabId) === null && terminalOfTab(tabId) === null;

/** Before the first page; `making`: a page subagent is making it, so asking
 *  again would only queue another. */
function PageEmptyState({ name, threadId, making }: { name: string; threadId: string; making: boolean }) {
  const [sending, setSending] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3.5 px-5 text-center">
      <p className="text-sm text-muted-foreground">{name} hasn't made a page yet.</p>
      <Button
        variant="outline"
        disabled={sending || making}
        onClick={() => {
          setSending(true);
          void useAgentChatStore.getState().sendMessage({ type: "personal", threadId }, "Make your page.").finally(() => setSending(false));
        }}
      >
        Ask {name} to make its page
      </Button>
    </div>
  );
}
