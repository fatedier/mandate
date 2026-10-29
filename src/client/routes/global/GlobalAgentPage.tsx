import { useCallback, useEffect, useMemo, useState } from "react";
import { MoreHorizontal, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LoadingLine } from "@/components/ViewState";
import { BackgroundTasksMenuItem, BackgroundTasksPanel } from "@/routes/window/chat/BackgroundTasksList";
import { useHasBackgroundTasks } from "@/routes/window/chat/background-tasks-view";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { ContextBudgetPill } from "@/routes/window/chat/ContextBudgetPill";
import { PaneHeaderActions, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { useAgentChatStore } from "@/store/agent-chat";
import { useGlobalAgentStore } from "@/store/global-agent";
import { displayGlobalAgentName } from "@shared/global-agent-name";
import { GlobalAgentGuide } from "./GlobalAgentGuide";
import { SplitRow } from "@/components/SplitRow";
import { PillTabs } from "@/components/PillTabs";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useSheetBackStep } from "@/routes/threads/sheet-back-step";
import { AgentPagePane } from "./page/AgentPagePane";
import { handoffIdsOf } from "./handoff-tools";
import { CanvasOpenerProvider } from "@/routes/canvas/CanvasOpenerProvider";

/** The global agent's page: the guide until it is
 *  named, then its one conversation. */
export function GlobalAgentPage() {
  const agent = useGlobalAgentStore((s) => s.agent);
  if (!agent) return <div className="mx-auto w-full max-w-[44rem] px-4 pt-6"><LoadingLine /></div>;
  if (!agent.named) return <GlobalAgentGuide voiceConfigured={agent.voiceConfigured} />;
  return (
    <GlobalAgentConversation
      threadId={agent.threadId}
      name={displayGlobalAgentName(agent.name)}
      lastVisibleSeq={agent.lastVisibleSeq}
      unread={agent.unread}
    />
  );
}

function GlobalAgentConversation({ threadId, name, lastVisibleSeq, unread }: {
  threadId: string;
  name: string;
  lastVisibleSeq: number;
  unread: boolean;
}) {
  const scope = useMemo(() => ({ type: "global" as const, threadId }), [threadId]);
  const markSeen = useGlobalAgentStore((s) => s.markSeen);
  const loadHandoffs = useGlobalAgentStore((s) => s.loadHandoffs);
  const shown = useAgentChatStore((s) => s.threadsByScope.get(`global:${threadId}`)?.loaded ?? false);
  const usage = useAgentChatStore((s) => s.threadsByScope.get(`global:${threadId}`)?.contextUsage ?? null);
  const isMobile = useIsMobile();
  // A string, so the selector's answer is stable while the ids are.
  const handoffIds = useAgentChatStore((s) => handoffIdsOf(s.threadsByScope.get(`global:${threadId}`)?.messages ?? []).join(","));
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
  // Seen while on screen and visible, as a thread page marks itself.
  useEffect(() => {
    if (!shown || !unread) return;
    const mark = () => { if (document.visibilityState === "visible") markSeen(lastVisibleSeq); };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [markSeen, lastVisibleSeq, shown, unread]);
  // On a desktop a canvas opened anywhere on the page opens as a tab beside
  // the chat; a phone opens it full screen, as before.
  const openCanvas = useCallback((canvasId: string) => useAgentPageUi.getState().openCanvas(canvasId), []);
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
          <span className="truncate font-semibold text-foreground">{name}</span>
          <span className="truncate text-xs text-faint">Sees every thread and worker</span>
        </h1>
      </PaneHeaderTitle>
      {/* How full its context is, as a thread's header says it; then its
          page's way back in (closed, or a narrow row's other side); then its menu. */}
      <PaneHeaderActions>
        <ContextBudgetPill usage={usage} compact={isMobile} />
        <PageToggle phone={isMobile} />
        <GlobalAgentMenu threadId={threadId} />
      </PaneHeaderActions>
      <PageSplit
        phone={isMobile}
        // The chat spans its pane, so its scrollbar runs at the pane's edge.
        chat={<div className="flex min-h-0 w-full flex-1 flex-col"><ChatConversation scope={scope} emptyState={empty} /></div>}
        page={<AgentPagePane name={name} threadId={threadId} />}
      />
    </div>
  );
  return isMobile ? content : <CanvasOpenerProvider open={openCanvas}>{content}</CanvasOpenerProvider>;
}

/** The chat and Your agent's page side by side (SplitRow); in a narrow row
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
      chat={chat}
      side={page}
    />
  );
}

/** A narrow row: Chat and the side, one at a time (Panel on a desktop, where
 *  the side holds canvas tabs beside the page; Page on a phone, where it is
 *  the page alone). A wide one with the side closed: Panel opens it again. */
function PageToggle({ phone }: { phone: boolean }) {
  const open = useAgentPageUi((s) => s.open);
  const narrow = useAgentPageUi((s) => s.narrow);
  const narrowView = useAgentPageUi((s) => s.narrowView);
  const ui = useAgentPageUi.getState;
  if (narrow) {
    return (
      <PillTabs
        aria-label="View"
        items={[{ id: "chat", label: "Chat" }, { id: "side", label: phone ? "Page" : "Panel" }]}
        value={open && narrowView === "side" ? "side" : "chat"}
        onChange={(view) => {
          if (view === "side") ui().setOpen(true);
          ui().setNarrowView(view);
        }}
      />
    );
  }
  if (open) return null;
  return (
    <Button variant="ghost" size="sm" onClick={() => ui().setOpen(true)} className="h-7 gap-1.5 px-2 text-xs text-chrome">
      <PanelRight className="h-3.5 w-3.5" />
      Panel
    </Button>
  );
}

/** Your agent's ⋯ menu, as a thread's: it holds the agent's background tasks,
 *  its one item, so it shows once the agent has started one. The list's
 *  surface stays mounted to read them. */
function GlobalAgentMenu({ threadId }: { threadId: string }) {
  const hasTasks = useHasBackgroundTasks(threadId);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [menuButton, setMenuButton] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      {hasTasks && (
        // Its menu opening closes the list: one of the two at a time.
        <DropdownMenu onOpenChange={(menuOpen) => { if (menuOpen) setTasksOpen(false); }}>
          <DropdownMenuTrigger asChild>
            <Button ref={setMenuButton} variant="ghost" size="icon-xs" aria-label="Agent actions" className="text-chrome">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <BackgroundTasksMenuItem threadId={threadId} onOpen={() => setTasksOpen(true)} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <BackgroundTasksPanel threadId={threadId} open={tasksOpen} onOpenChange={setTasksOpen} anchor={menuButton} side="bottom" align="end" />
    </>
  );
}
