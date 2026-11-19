import { useTaskFromAddress } from "@/routes/task-board/task-open";
import { TerminalMenuItems } from "@/routes/terminals/TerminalMenuItems";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, History as HistoryIcon, MessagesSquare, MoreHorizontal, PanelRight, SquareCheckBig, StickyNote } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { useSideChatsStore, sideChatHref } from "@/store/side-chats";
import { errorText } from "@shared/error-text";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { LoadingLine } from "@/components/ViewState";
import { BackgroundTasksMenuItem, BackgroundTasksPanel } from "@/routes/window/chat/BackgroundTasksList";
import { CompactNowItem } from "@/routes/window/chat/CompactNowItem";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { useReadPoint } from "@/routes/window/chat/new-replies";
import { ContextBudgetPill } from "@/routes/window/chat/ContextBudgetPill";
import type { TranscriptPlace } from "@/routes/window/chat/useTranscriptViewport";
import { ChatPaneHeader, PaneHeaderActions, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { useAgentChatStore } from "@/store/agent-chat";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { displayPersonalAgentName } from "@shared/personal-agent-name";
import { PersonalAgentGuide } from "./PersonalAgentGuide";
import { SplitRow } from "@/components/SplitRow";
import { PillTabs } from "@/components/PillTabs";
import { cn } from "@/lib/utils";
import { useAgentPageUi } from "@/store/agent-page-ui";
// History keeps its rows loaded while its tab is open, wherever the user is.
import "@/store/history-hold";
import { useSheetBackStep } from "@/routes/threads/sheet-back-step";
import { ReplyTabTargetContext } from "@/routes/reply-tabs/reply-tab-target";
import { AgentPagePane } from "./page/AgentPagePane";
import { handoffIdsOf } from "./handoff-tools";
import { CanvasOpenerProvider } from "@/routes/canvas/CanvasOpenerProvider";
import { FileOpenerProvider } from "@/routes/files/FileOpenerProvider";
import type { FileTarget } from "@/lib/file-link";

/** The personal agent's page: the guide until it is
 *  named, then its one conversation. */
export function PersonalAgentPage() {
  const agent = usePersonalAgentStore((s) => s.agent);
  // A task named in the address (a notification, a task link) opens in the panel.
  useTaskFromAddress();
  if (!agent) return <div className="mx-auto w-full max-w-[44rem] px-4 pt-6"><LoadingLine /></div>;
  if (!agent.named) return <PersonalAgentGuide voiceConfigured={agent.voiceConfigured} />;
  return (
    <PersonalAgentConversation
      threadId={agent.threadId}
      name={displayPersonalAgentName(agent.name)}
      lastVisibleSeq={agent.lastVisibleSeq}
      seenSeq={agent.seenSeq}
      unread={agent.unread}
    />
  );
}

function PersonalAgentConversation({ threadId, name, lastVisibleSeq, seenSeq, unread }: {
  threadId: string;
  name: string;
  lastVisibleSeq: number;
  seenSeq: number;
  unread: boolean;
}) {
  // Taken as the page comes into sight, before it marks the conversation seen.
  const readPoint = useReadPoint(threadId, seenSeq, true);
  const scope = useMemo(() => ({ type: "personal" as const, threadId }), [threadId]);
  const markSeen = usePersonalAgentStore((s) => s.markSeen);
  const loadHandoffs = usePersonalAgentStore((s) => s.loadHandoffs);
  const shown = useAgentChatStore((s) => s.threadsByScope.get(`personal:${threadId}`)?.loaded ?? false);
  const usage = useAgentChatStore((s) => s.threadsByScope.get(`personal:${threadId}`)?.contextUsage ?? null);
  const isMobile = useIsMobile();
  // A string, so the selector's answer is stable while the ids are.
  const handoffIds = useAgentChatStore((s) => handoffIdsOf(s.threadsByScope.get(`personal:${threadId}`)?.messages ?? []).join(","));
  // The cards the transcript shows, read as they stand now: on open, when a
  // card appears, and whenever the event stream comes back (a change
  // published while it was down is not sent again). Events keep them current
  // in between; a read that failed is tried again on the next of these.
  useEffect(() => {
    const ids = handoffIds ? handoffIds.split(",") : [];
    if (ids.length === 0) return;
    void loadHandoffs(ids);
    const onReconnect = () => { void loadHandoffs(ids); };
    window.addEventListener("mandate:sse-open", onReconnect);
    return () => window.removeEventListener("mandate:sse-open", onReconnect);
  }, [handoffIds, loadHandoffs]);
  // Seen while on screen and visible, as a thread page marks itself: what it
  // said (the dot), and a notice that lit nothing but is read to all the
  // same, so a later reply's New line goes below it.
  useEffect(() => {
    if (!shown || (!unread && lastVisibleSeq <= seenSeq)) return;
    const mark = () => { if (document.visibilityState === "visible") markSeen(lastVisibleSeq); };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [markSeen, lastVisibleSeq, seenSeq, shown, unread]);
  // On a desktop a canvas opened anywhere on the page opens as a tab beside
  // the chat; a phone opens it full screen, as before.
  const openCanvas = useCallback((canvasId: string) => useAgentPageUi.getState().openCanvas(canvasId), []);
  const openFile = useCallback((target: FileTarget) => useAgentPageUi.getState().openFile(target), []);
  // A reply opened from this chat goes to its page's panel: beside the chat,
  // or the panel on a phone (openReply turns a narrow row to its side).
  const replyTarget = useMemo(() => ({ threadId, open: (tabId: string) => useAgentPageUi.getState().openReply(tabId) }), [threadId]);
  // History reads beside: opened while the chat is scrolled up, it opens at
  // the row being read and the chat goes back to its latest; at the chat's
  // end it opens where it was.
  const readBeside = useRef<(() => TranscriptPlace | null) | null>(null);
  const offerReadBeside = useCallback((take: (() => TranscriptPlace | null) | null) => { readBeside.current = take; }, []);
  const openHistory = useCallback(() => {
    const place = readBeside.current?.() ?? null;
    useAgentPageUi.getState().openHistory(place ?? undefined);
  }, []);
  // A side chat forked from this conversation now, on its own page; one at
  // a time (a second click while it opens opens no second one).
  const navigate = useNavigate();
  const opening = useRef(false);
  const openSideChat = useCallback(() => {
    if (opening.current) return;
    opening.current = true;
    void useSideChatsStore.getState().create().then(
      (id) => { void navigate(sideChatHref(id)); },
      (err: unknown) => { toast.error(`Could not open a side chat: ${errorText(err)}`); }
    ).finally(() => { opening.current = false; });
  }, [navigate]);
  const empty = (
    <div className="flex flex-col items-center gap-1.5 px-3 py-16 text-center text-sm text-muted-foreground">
      <p className="text-base font-semibold text-foreground">{name}</p>
      <p>I can see every thread and worker. Ask what's going on, or tell a worker what to do.</p>
    </div>
  );
  const content = (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PaneHeaderTitle>
        <h1 className="flex min-w-0 items-baseline gap-2 text-sm">
          {/* The line after the name gives way first: beside the header's
              buttons a narrow chat column still says whose page this is. */}
          <span className="truncate font-semibold text-foreground">{name}</span>
          <span className="shrink-[999] truncate text-xs text-faint">Sees every thread and worker</span>
        </h1>
      </PaneHeaderTitle>
      {/* How full its context is, as a thread's header says it; then its
          page's way back in (closed, or a narrow row's other side); then its
          menu, which holds History and New side chat at every width. */}
      <PaneHeaderActions>
        <ContextBudgetPill usage={usage} compact={isMobile} />
        <PageToggle phone={isMobile} />
        <PersonalAgentMenu threadId={threadId} phone={isMobile} onHistory={openHistory} onSideChat={openSideChat} />
      </PaneHeaderActions>
      <PageSplit
        phone={isMobile}
        // The chat spans its pane, so its scrollbar runs at the pane's edge.
        chat={(
          <ReplyTabTargetContext.Provider value={replyTarget}>
            <div className="flex min-h-0 w-full flex-1 flex-col">
              <ChatConversation scope={scope} emptyState={empty} offerReadBeside={offerReadBeside} newSince={readPoint} />
            </div>
          </ReplyTabTargetContext.Provider>
        )}
        page={<AgentPagePane name={name} threadId={threadId} />}
      />
    </div>
  );
  return isMobile ? content : <CanvasOpenerProvider open={openCanvas}><FileOpenerProvider open={openFile}>{content}</FileOpenerProvider></CanvasOpenerProvider>;
}

/** The chat and Personal agent's page side by side (SplitRow); in a narrow row
 *  one at a time. On a phone the page is a step in the history, so Back
 *  returns to the chat. */
function PageSplit({ phone, chat, page }: { phone: boolean; chat: React.ReactNode; page: React.ReactNode }) {
  const open = useAgentPageUi((s) => s.open);
  const maximized = useAgentPageUi((s) => s.maximized);
  const ratio = useAgentPageUi((s) => s.ratio);
  const narrow = useAgentPageUi((s) => s.narrow);
  const narrowView = useAgentPageUi((s) => s.narrowView);
  const ui = useAgentPageUi.getState;
  useSheetBackStep({
    mark: "agentPage",
    open: phone && narrow && open && narrowView === "side",
    readOpen: () => { const s = ui(); return s.narrow && s.open && s.narrowView === "side"; },
    phone,
    onBack: () => ui().setNarrowView("chat"),
    onReturn: () => { ui().setOpen(true); ui().setNarrowView("side"); }
  });
  return (
    <SplitRow
      open={open}
      alwaysNarrow={phone}
      maximized={maximized}
      narrowView={narrowView}
      onNarrow={(next) => ui().setNarrow(next)}
      onNarrowView={(view) => ui().setNarrowView(view)}
      onMaximized={(on) => ui().setMaximized(on)}
      onOpen={() => ui().setOpen(true)}
      ratio={ratio}
      onRatio={(next) => ui().setRatio(next)}
      slots={{ chat: "agent-chat", side: "agent-page" }}
      labels={{ side: "Page", resize: "Resize page", valueSuffix: "page" }}
      // With both sides in the row the header is the chat's, over its
      // column; the page's tabs take the band over the page. A page with the
      // row to itself hides the chat: the window's band comes back.
      chat={<>{!phone && !narrow && !(open && maximized) && <ChatPaneHeader />}{chat}</>}
      side={page}
    />
  );
}

/** A narrow row: Chat and the side, one at a time (Panel: the side holds
 *  tabs beside the page, on a phone too). A wide one: Panel hides the side
 *  and opens it again, lit while it is open. */
function PageToggle({ phone }: { phone: boolean }) {
  const open = useAgentPageUi((s) => s.open);
  const narrow = useAgentPageUi((s) => s.narrow);
  const narrowView = useAgentPageUi((s) => s.narrowView);
  const ui = useAgentPageUi.getState;
  if (narrow) {
    return (
      <PillTabs
        aria-label="View"
        items={[{ id: "chat", label: "Chat" }, { id: "side", label: "Panel" }]}
        value={open && narrowView === "side" ? "side" : "chat"}
        onChange={(view) => {
          if (view === "side") ui().setOpen(true);
          ui().setNarrowView(view);
        }}
      />
    );
  }
  // A phone's page is one side at a time: nothing to hide while it is open.
  if (phone && open) return null;
  const label = open ? "Hide panel" : "Show panel";
  return (
    <Button
      variant="ghost"
      size="sm"
      data-slot="panel-toggle"
      aria-pressed={open}
      aria-label={label}
      title={label}
      onClick={() => {
        if (!open) return ui().setOpen(true);
        ui().setOpen(false);
        ui().setMaximized(false);
      }}
      className={cn("h-7 gap-1.5 px-2 text-xs", open ? "bg-sel text-foreground" : "text-chrome")}
    >
      <PanelRight className="h-3.5 w-3.5" />
      Panel
    </Button>
  );
}

/** The personal agent's ⋯ menu: History and New side chat first; then, as a
 *  thread's, its background tasks once it has started one (the list's
 *  surface stays mounted to read them), and Compact now. */
function PersonalAgentMenu({ threadId, phone, onHistory, onSideChat }: { threadId: string; phone: boolean; onHistory: () => void; onSideChat: () => void }) {
  const [tasksOpen, setTasksOpen] = useState(false);
  const [menuButton, setMenuButton] = useState<HTMLButtonElement | null>(null);
  const scope = useMemo(() => ({ type: "personal" as const, threadId }), [threadId]);
  return (
    <>
      {/* Its menu opening closes the list: one of the two at a time. */}
      <DropdownMenu onOpenChange={(menuOpen) => { if (menuOpen) setTasksOpen(false); }}>
        <DropdownMenuTrigger asChild>
          <Button ref={setMenuButton} variant="ghost" size="icon-xs" aria-label="Agent actions" className="text-chrome">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onHistory}>
            <HistoryIcon className="h-4 w-4" />
            History
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onSideChat}>
            <MessagesSquare className="h-4 w-4" />
            New side chat
          </DropdownMenuItem>
          {/* A phone has no panel: the owner's tasks are a page of their own. */}
          {phone && (
            <DropdownMenuItem asChild>
              <Link to="/tasks">
                <SquareCheckBig className="h-4 w-4" />
                Tasks
              </Link>
            </DropdownMenuItem>
          )}
          {phone && (
            <DropdownMenuItem asChild>
              <Link to="/notes">
                <StickyNote className="h-4 w-4" />
                Notes
              </Link>
            </DropdownMenuItem>
          )}
          {phone && (
            <DropdownMenuItem asChild>
              <Link to="/calendar">
                <CalendarDays className="h-4 w-4" />
                Calendar
              </Link>
            </DropdownMenuItem>
          )}
          {phone && <TerminalMenuItems />}
          <BackgroundTasksMenuItem threadId={threadId} onOpen={() => setTasksOpen(true)} />
          <CompactNowItem scope={scope} />
        </DropdownMenuContent>
      </DropdownMenu>
      <BackgroundTasksPanel threadId={threadId} open={tasksOpen} onOpenChange={setTasksOpen} anchor={menuButton} side="bottom" align="end" />
    </>
  );
}
