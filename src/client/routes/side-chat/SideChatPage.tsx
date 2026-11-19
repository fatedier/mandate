import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { PanelRight, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/PillTabs";
import { SplitRow } from "@/components/SplitRow";
import { confirmAction } from "@/components/confirm-action";
import { ChatPaneHeader, PaneHeaderActions, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { usePaneHeaderHosted } from "@/shell/pane-header-context";
import { PaneZoomButton } from "@/components/PaneZoomButton";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { formatCalendarDate } from "@/lib/format";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useAgentChatStore } from "@/store/agent-chat";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import { useSideChatsStore } from "@/store/side-chats";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { useReadPoint } from "@/routes/window/chat/new-replies";
import { ContextBudgetPill } from "@/routes/window/chat/ContextBudgetPill";
import { CanvasOpenerProvider } from "@/routes/canvas/CanvasOpenerProvider";
import { PanelCanvasViews } from "@/routes/canvas/PanelCanvasViews";
import { useThreadCanvases } from "@/routes/threads/use-thread-canvases";
import { errorText } from "@shared/error-text";
import type { SideChatDto } from "@shared/api/side-chat";
import { SideChatMenu } from "./side-chat-menu";
import { COMMAND_STOPS, SendSideChatDialog } from "./SendSideChatDialog";

/** A side chat's page. One that has ended (sent, discarded, here or
 *  elsewhere) leads back to the agent. */
export function SideChatPage() {
  const { threadId = "" } = useParams<{ threadId: string }>();
  const chat = useSideChatsStore((s) => s.sideChats?.find((c) => c.id === threadId) ?? null);
  const loaded = useSideChatsStore((s) => s.sideChats !== null);
  if (!chat) return loaded ? <Navigate to="/agent" replace /> : null;
  return <SideChatBody key={chat.id} chat={chat} />;
}

/** Its chat, and the canvases it wrote beside it (one at a time in a narrow
 *  row and on a phone: Chat / Canvases). */
function SideChatBody({ chat }: { chat: SideChatDto }) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const name = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const scope = useMemo(() => ({ type: "side_chat" as const, threadId: chat.id }), [chat.id]);
  const key = `side_chat:${chat.id}`;
  const usage = useAgentChatStore((s) => s.threadsByScope.get(key)?.contextUsage ?? null);
  const shown = useAgentChatStore((s) => s.threadsByScope.get(key)?.loaded ?? false);

  // What came after the point read to is marked, taken before it is moved on.
  const readPoint = useReadPoint(chat.id, chat.seenSeq, true);
  // Seen while on screen and visible, as a thread page marks itself: on
  // opening and with each new row. A write the server refused is not asked
  // again until then (markSeen skips what is seen already).
  useEffect(() => {
    if (!shown) return;
    const mark = () => { if (document.visibilityState === "visible") useSideChatsStore.getState().markSeen(chat.id, chat.lastVisibleSeq); };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [chat.id, chat.lastVisibleSeq, shown]);

  // Whether a command of its still runs: an end says it stops.
  useEffect(() => { void useBackgroundTasksStore.getState().load(chat.id); }, [chat.id]);
  const commandRunning = useBackgroundTasksStore((s) => (s.byThread.get(chat.id) ?? [])
    .some((task) => task.kind === "command" && (task.status === "running" || task.status === "queued")));

  const [sending, setSending] = useState(false);
  const leave = useCallback(() => { void navigate("/agent", { replace: true }); }, [navigate]);
  const discard = useCallback(async () => {
    const yes = await confirmAction({
      title: "Discard this side chat?",
      description: `It and what it found are gone, and nothing goes to ${name}. This can't be undone.${commandRunning ? `\n${COMMAND_STOPS}` : ""}`,
      confirmLabel: "Discard"
    });
    if (!yes) return;
    try {
      await useSideChatsStore.getState().discard(chat.id);
      leave();
    } catch (err) {
      toast.error(`Could not discard: ${errorText(err)}`);
    }
  }, [chat.id, commandRunning, leave, name]);

  // In a narrow row and on a phone, one side at a time; a canvas opened from
  // the chat brings in its side.
  const [narrow, setNarrow] = useState(false);
  const [view, setView] = useState<"chat" | "side">("chat");
  const [maximized, setMaximized] = useState(false);
  const [ratio, setRatio] = useState(0.42);
  // Canvases opened from its chat, besides its own; and its own closed here.
  const [opened, setOpened] = useState<string[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // Beside the chat: the canvases panel shut by the header's Canvases.
  const [hidden, setHidden] = useState(false);
  const openCanvas = useCallback((canvasId: string) => {
    setOpened((ids) => (ids.includes(canvasId) ? ids : [...ids, canvasId]));
    setClosed((ids) => ids.filter((id) => id !== canvasId));
    setActive(canvasId);
    setView("side");
    setHidden(false);
  }, []);
  const closeCanvas = useCallback((canvasId: string) => {
    setOpened((ids) => ids.filter((id) => id !== canvasId));
    setClosed((ids) => (ids.includes(canvasId) ? ids : [...ids, canvasId]));
  }, []);
  // The canvases it wrote and those opened from its chat, less those closed
  // here, newest first.
  const { canvases } = useThreadCanvases(chat.id, "");
  const own = useMemo(() => canvases ?? [], [canvases]);
  const ids = useMemo(
    () => [...own.map((c) => c.id), ...opened.filter((id) => !own.some((c) => c.id === id))].filter((id) => !closed.includes(id)),
    [own, opened, closed]
  );
  const titleOf = useCallback((id: string) => own.find((c) => c.id === id)?.title ?? "Canvas", [own]);
  // Beside the chat the panel is shut while there is no canvas to show (an
  // empty half of the window said nothing); the first one opens it, as one
  // opened from the chat does, and Canvases in the header shuts it till it
  // is pressed again or the next one is opened.
  const hasCanvases = ids.length > 0;
  const [had, setHad] = useState(hasCanvases);
  if (had !== hasCanvases) {
    setHad(hasCanvases);
    if (hasCanvases) setHidden(false);
    else setMaximized(false);
  }
  const oneAtATime = isMobile || narrow;

  const empty = (
    <div data-slot="side-chat-empty" className="flex flex-col items-center gap-1.5 px-3 py-10 text-center text-sm text-muted-foreground">
      <p className="text-base font-semibold text-foreground">What do you want to work out?</p>
      <p>This side chat knows {name}'s conversation up to now. Send it to {name} when it is done, or discard it.</p>
    </div>
  );
  const content = (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PaneHeaderTitle>
        <h1 className="flex min-w-0 items-baseline gap-2 text-sm">
          <span data-slot="side-chat-title" className="truncate font-semibold text-foreground">{chat.title}</span>
          {/* A phone's top bar has room for the title only; its first row
              says where it started. */}
          {!isMobile && <span data-slot="side-chat-origin" className="min-w-0 truncate text-xs text-faint">Side chat of {name} · since {formatCalendarDate(chat.createdAt)}</span>}
        </h1>
      </PaneHeaderTitle>
      <PaneHeaderActions>
        <ContextBudgetPill usage={usage} compact={isMobile} />
        {oneAtATime && (
          <PillTabs
            aria-label="View"
            items={[{ id: "chat", label: "Chat" }, { id: "side", label: "Canvases" }]}
            value={view}
            onChange={setView}
          />
        )}
        {/* Discard, an end that cannot be undone, is in the ⋯. */}
        {!isMobile && (
          <Button variant="ghost" size="sm" onClick={() => setSending(true)} className="h-7 gap-1.5 px-2 text-xs text-chrome">
            <Send className="h-3.5 w-3.5" />
            Send to {name}
          </Button>
        )}
        {!oneAtATime && hasCanvases && (
          <Button
            variant="ghost"
            size="sm"
            data-slot="canvases-toggle"
            aria-pressed={!hidden}
            aria-label={hidden ? "Show panel" : "Hide panel"}
            title={hidden ? "Show panel" : "Hide panel"}
            onClick={() => {
              setHidden(!hidden);
              if (!hidden) setMaximized(false);
            }}
            className={cn("h-7 gap-1.5 px-2 text-xs", hidden ? "text-chrome" : "bg-sel text-foreground")}
          >
            <PanelRight className="h-3.5 w-3.5" />
            Canvases
          </Button>
        )}
        <SideChatMenu chat={chat} phone={isMobile} name={name} onSend={() => setSending(true)} onDiscard={() => void discard()} />
      </PaneHeaderActions>
      <SplitRow
        open={oneAtATime || (hasCanvases && !hidden)}
        alwaysNarrow={isMobile}
        maximized={maximized}
        narrowView={view}
        onNarrow={setNarrow}
        onNarrowView={setView}
        onMaximized={setMaximized}
        onOpen={() => setView("side")}
        ratio={ratio}
        onRatio={setRatio}
        slots={{ chat: "side-chat-chat", side: "side-chat-canvases" }}
        labels={{ side: "Canvases", resize: "Resize canvases", valueSuffix: "canvases" }}
        // With both sides in the row the header is the chat's, over its
        // column; the canvases' tabs take the band over the panel. A panel
        // with the row to itself hides the chat: the window's band comes back.
        chat={<div className="flex min-h-0 w-full flex-1 flex-col">{!oneAtATime && !(hasCanvases && !hidden && maximized) && <ChatPaneHeader />}<ChatConversation scope={scope} emptyState={empty} newSince={readPoint} /></div>}
        side={(
          <SideChatCanvases
            ids={ids}
            titleOf={titleOf}
            active={active}
            onActive={setActive}
            onClose={closeCanvas}
            tools={oneAtATime ? null : <PaneZoomButton kind="canvases" zoomed={maximized} onClick={() => setMaximized(!maximized)} />}
          />
        )}
      />
      {sending && (
        <SendSideChatDialog
          chatId={chat.id}
          name={name}
          commandRunning={commandRunning}
          onDone={(sent) => { setSending(false); if (sent) leave(); }}
        />
      )}
    </div>
  );
  // A canvas opened anywhere on the page opens beside the chat; a phone
  // opens it full screen, as it does elsewhere.
  return isMobile ? content : <CanvasOpenerProvider open={openCanvas}>{content}</CanvasOpenerProvider>;
}

/** The canvases the side chat wrote, newest first, and any opened from its
 *  chat, but those closed here: one shown at a time, switched by name, each
 *  kept as it was left once drawn. */
function SideChatCanvases({ ids, titleOf, active, onActive, onClose, tools }: {
  ids: string[];
  titleOf: (canvasId: string) => string;
  active: string | null;
  onActive: (canvasId: string) => void;
  onClose: (canvasId: string) => void;
  /** Beside the chat: its maximize. */
  tools: React.ReactNode;
}) {
  // Beside a chat pane's own header the row is the band over the panel.
  const banded = usePaneHeaderHosted();
  const shown = active && ids.includes(active) ? active : ids[0] ?? null;
  const [drawn, setDrawn] = useState<ReadonlySet<string>>(() => new Set());
  if (shown && !drawn.has(shown)) setDrawn(new Set(drawn).add(shown));
  if (shown === null) {
    return (
      <div data-slot="side-chat-canvases-empty" className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Canvases this side chat writes open here.
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        data-slot="side-chat-canvas-row"
        data-tauri-drag-region={banded || undefined}
        className={cn("flex shrink-0 items-center gap-0.5 px-2", banded ? "h-13" : "h-11")}
      >
        <div className="min-w-0 flex-1">
          <PillTabs aria-label="Canvases" items={ids.map((id) => ({ id, label: titleOf(id) }))} value={shown} onChange={onActive} />
        </div>
        {tools}
      </div>
      <PanelCanvasViews kept={ids.filter((id) => drawn.has(id) || id === shown)} active={shown} onClose={onClose} />
    </div>
  );
}
