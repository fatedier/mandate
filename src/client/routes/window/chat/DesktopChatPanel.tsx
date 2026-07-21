import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { MessageSquare, Mic } from "lucide-react";
import { useAgentChatStore } from "@/store/agent-chat";
import { useChatTrigger } from "@/hooks/useChatTrigger";
import {
  useUIStore,
  CHAT_PANEL_WIDTH_MIN
} from "@/store/ui";
import { useVoiceStore } from "@/store/voice";
import { AgentChatPanel } from "./AgentChatPanel";
import { cn } from "@/lib/utils";
import { shouldIgnoreGlobalEscape } from "@/lib/keyboard-targets";
import { getChatPanelWidth } from "@/lib/pane-layout";

/** Closing the dock shows its 40px rail. Worker zoom instead keeps the entire
 *  dock mounted at its split width, hidden and inert, so drafts and live
 *  transcripts retain their state and measurements. */
export function DesktopChatPanel({ width, workspaceWidth, workerZoomed }: {
  width: number;
  workspaceWidth: number;
  workerZoomed: boolean;
}) {
  const drawerOpen = useAgentChatStore((s) => s.drawerOpen);
  const drawerScope = useAgentChatStore((s) => s.drawerScope);
  const drawerMode = useAgentChatStore((s) => s.drawerMode);
  const closeDrawer = useAgentChatStore((s) => s.closeDrawer);
  const openDrawer = useAgentChatStore((s) => s.openDrawer);
  // Was the sum of every thread's unread while the click below opens only the
  // current route's scope — so clearing one thread left the badge showing the
  // rest, and reading what you were shown did not make it go away.
  const { targetScope: railTarget, unread: railUnread, label: railLabel } = useChatTrigger();
  const setChatPanelRatio = useUIStore((s) => s.setChatPanelRatio);
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const setVoiceMode = useVoiceStore((s) => s.setVoiceMode);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: width };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Some pointer sources (synthetic test events, certain stylus drivers)
      // reject setPointerCapture; the rest of the drag still works without it.
    }
    // Lock the global cursor while dragging so it stays as col-resize even
    // when the pointer briefly leaves the handle hit-area.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state) return;
    // Panel is anchored to the right edge, so drag-left grows the panel.
    resize(state.startWidth + (state.startX - e.clientX));
  };

  const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Defensive: see onResizeStart.
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const onResizeDoubleClick = () => {
    setChatPanelRatio(0.5);
  };

  const resize = (nextWidth: number) => {
    if (workspaceWidth <= 0) return;
    setChatPanelRatio(getChatPanelWidth(workspaceWidth, nextWidth / workspaceWidth) / workspaceWidth);
  };

  useEffect(() => () => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, [drawerMode, workerZoomed]);

  // Escape-to-close: replaces what Radix Dialog provided in the old Sheet
  // version. Only listen while open to avoid interfering with other modals.
  useEffect(() => {
    if (!drawerOpen || drawerMode !== "side") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't steal Escape from open dialogs/inputs that already handle it.
      if (shouldIgnoreGlobalEscape(e)) return;
      if (voiceMode) setVoiceMode(false);
      closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, drawerMode, voiceMode, setVoiceMode, closeDrawer]);

  if (!drawerOpen || !drawerScope) {
    return (
      <aside
        role="complementary"
        aria-label="Assistant dock"
        inert={workerZoomed}
        aria-hidden={workerZoomed || undefined}
        className={cn(
          "animate-rail-in flex w-10 shrink-0 flex-col items-center gap-2 border-l border-border-soft bg-panel py-3",
          workerZoomed && "absolute inset-y-0 right-0 invisible pointer-events-none"
        )}
      >
        <button
          type="button"
          onClick={() => openDrawer(railTarget)}
          aria-label={railLabel}
          title={railLabel}
          className="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background/40 hover:text-foreground"
        >
          <MessageSquare className="h-4 w-4" />
          {railUnread > 0 && (
            <span className="absolute -top-1 -right-1 inline-flex min-w-[16px] h-4 items-center justify-center rounded-full bg-primary px-1 text-2xs font-semibold num text-primary-foreground">
              {railUnread > 99 ? "99+" : railUnread}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            openDrawer({ type: "manager" });
            setVoiceMode(true);
          }}
          aria-label="Start voice session"
          title="Start voice session"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background/40 hover:text-foreground"
        >
          <Mic className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      role="complementary"
      aria-label="Assistant dock"
      style={drawerMode === "fullscreen" ? undefined : { width }}
      inert={workerZoomed}
      aria-hidden={workerZoomed || undefined}
      className={cn(
        "animate-dock-in relative flex flex-col min-h-0",
        drawerMode === "fullscreen"
          ? "absolute inset-0 z-[45] bg-background"
          : "flex-shrink-0 border-l border-border-soft bg-card",
        workerZoomed && "absolute inset-y-0 right-0 invisible pointer-events-none"
      )}
    >
      {drawerMode === "side" && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          aria-valuemin={Math.round(Math.min(CHAT_PANEL_WIDTH_MIN, workspaceWidth / 2))}
          aria-valuemax={Math.round(workspaceWidth - Math.min(CHAT_PANEL_WIDTH_MIN, workspaceWidth / 2))}
          aria-valuenow={Math.round(width)}
          aria-valuetext={`${Math.round(workspaceWidth > 0 ? width / workspaceWidth * 100 : 50)}% chat`}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onLostPointerCapture={onResizeEnd}
          onDoubleClick={onResizeDoubleClick}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              resize(width + (event.key === "ArrowLeft" ? 20 : -20));
            } else if (event.key === "Enter" || event.key === "Home") {
              event.preventDefault();
              setChatPanelRatio(0.5);
            }
          }}
          title="Drag to resize · double-click for equal split"
          className="group absolute inset-y-0 left-0 z-[1] flex w-2 cursor-col-resize touch-none select-none items-stretch"
        >
          {/* The 8px-wide div is the grab area (transparent). A 1px stripe
              on its left edge gives the actual visual feedback on hover —
              everything stays inside the panel; nothing protrudes into
              the main column. */}
          <div className="w-px bg-transparent transition-colors group-hover:bg-primary/70 group-active:bg-primary" />
        </div>
      )}
      <div
        className={cn(
          "flex min-h-0 flex-col bg-card",
          drawerMode === "fullscreen"
            ? "mx-auto h-full w-full max-w-4xl border-x border-border-soft"
            : "h-full w-full"
        )}
      >
        <AgentChatPanel />
      </div>
    </aside>
  );
}
