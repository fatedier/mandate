import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocation } from "react-router";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useRouteFeature } from "@/hooks/useRouteFeature";
import { hasOpenKeyboardOverlay, shouldIgnoreGlobalEscape } from "@/lib/keyboard-targets";
import { getChatPanelWidth } from "@/lib/pane-layout";
import { useAgentChatStore } from "@/store/agent-chat";
import { useUIStore } from "@/store/ui";
import { DesktopChatPanel } from "@/routes/window/chat/DesktopChatPanel";

/** The area after the sidebar. Both panes stay mounted while either is zoomed. */
export function Workspace({ children, scrollRef }: {
  children: ReactNode;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const isMobile = useIsMobile();
  const featureId = useRouteFeature()?.id ?? null;
  const previousFeature = useRef(featureId);
  const location = useLocation();
  const drawerMode = useAgentChatStore((s) => s.drawerMode);
  const drawerOpen = useAgentChatStore((s) => s.drawerOpen);
  const drawerScope = useAgentChatStore((s) => s.drawerScope);
  const ratio = useUIStore((s) => s.chatPanelRatio);
  const chatWidth = getChatPanelWidth(width, ratio);
  const workerZoomed = !isMobile && drawerMode === "worker" && featureId !== null;
  const chatZoomed = !isMobile && drawerOpen && drawerScope !== null && drawerMode === "fullscreen";

  useLayoutEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Zoom is temporary and belongs to this Worker. Tab and pane navigation
  // within the same Worker keep it; leaving the Worker or desktop ends it.
  useLayoutEffect(() => {
    const state = useAgentChatStore.getState();
    if (isMobile || (state.drawerMode === "worker" && previousFeature.current !== featureId)) {
      if (state.drawerMode !== "side") state.setDrawerMode("side");
    }
    previousFeature.current = featureId;
  }, [featureId, isMobile]);

  const normalScroll = useRef<{ key: string; top: number } | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const hiddenFocus = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const key = location.pathname + location.search;
    // A store subscription runs before React changes the pane's dimensions.
    // Reading scrollTop in an effect after zoom would already see it clamped
    // to the shorter, wider document and lose the original reading position.
    return useAgentChatStore.subscribe((next, previous) => {
      if (next.drawerMode === previous.drawerMode) return;
      if (next.drawerMode === "worker" && scrollRef.current) {
        normalScroll.current = { key, top: scrollRef.current.scrollTop };
      } else if (previous.drawerMode === "worker" && normalScroll.current?.key === key) {
        pendingScroll.current = normalScroll.current.top;
      }
      const active = document.activeElement;
      if (next.drawerMode !== "side") {
        const hidingActive = next.drawerMode === "worker"
          ? active?.closest('[aria-label="Assistant dock"]')
          : active && contentRef.current?.contains(active);
        hiddenFocus.current = hidingActive && active instanceof HTMLElement ? active : null;
        pendingFocus.current = hiddenFocus.current ? workspaceRef.current?.querySelector<HTMLElement>(
          `[data-pane-zoom="${next.drawerMode === "worker" ? "worker" : "chat"}"]`
        ) ?? null : null;
      } else {
        const zoomButton = workspaceRef.current?.querySelector<HTMLElement>(
          `[data-pane-zoom="${previous.drawerMode === "worker" ? "worker" : "chat"}"]`
        );
        // Only return focus that we moved. If the reader has since focused
        // a visible input (including inside a Canvas iframe), leave it there.
        pendingFocus.current = active === zoomButton ? hiddenFocus.current : null;
        hiddenFocus.current = null;
      }
    });
  }, [location.pathname, location.search, scrollRef]);

  useLayoutEffect(() => {
    let cancelScrollRestore: (() => void) | undefined;
    if (pendingScroll.current !== null && scrollRef.current) {
      cancelScrollRestore = restoreReadingPosition(scrollRef.current, pendingScroll.current);
      pendingScroll.current = null;
    }
    const target = pendingFocus.current;
    if (target?.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true });
    pendingFocus.current = null;
    return cancelScrollRestore;
  }, [drawerMode, scrollRef, location.pathname, location.search]);

  useEffect(() => {
    if (isMobile) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || hasOpenKeyboardOverlay()) return;
      const state = useAgentChatStore.getState();
      if (featureId && event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey) {
        event.preventDefault();
        // xterm handles keydown even when defaultPrevented is set. Keep the
        // consumed shortcut (including repeats) away from terminal input.
        event.stopPropagation();
        if (!event.repeat) state.setDrawerMode(state.drawerMode === "worker" ? "side" : "worker");
      } else if (event.key === "Escape" && state.drawerMode !== "side" && !shouldIgnoreGlobalEscape(event)) {
        // Consume the press before WindowPage's Escape-to-projects listener
        // and the chat dock's Escape-to-close listener can see it.
        event.preventDefault();
        state.setDrawerMode("side");
      }
    };
    // Consume pane shortcuts before page navigation's document bubble listener.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [featureId, isMobile]);

  return (
    <div
      ref={workspaceRef}
      className="group/workspace relative flex flex-1 min-w-0 min-h-0"
      data-pane-mode={workerZoomed ? "worker" : chatZoomed ? "chat" : "split"}
    >
      <div
        ref={contentRef}
        className="flex flex-col flex-1 min-w-0 min-h-0"
        // Preserve the underlying main column's width during Chat zoom too.
        style={chatZoomed ? { flex: "none", width: Math.max(0, width - chatWidth) } : undefined}
        inert={chatZoomed}
        aria-hidden={chatZoomed || undefined}
      >
        {children}
      </div>
      {!isMobile && <DesktopChatPanel width={chatWidth} workspaceWidth={width} workerZoomed={workerZoomed} />}
    </div>
  );
}

function restoreReadingPosition(scroller: HTMLElement, top: number): () => void {
  // Canvas iframes report their new height asynchronously after a width
  // change. Keep the requested position until it fits, or the reader takes
  // control; otherwise the first (clamped) scrollTop loses the position.
  const cancel = () => {
    observer.disconnect();
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      scroller.removeEventListener(event, cancel);
    }
  };
  const restore = () => {
    scroller.scrollTop = top;
    if (Math.abs(scroller.scrollTop - top) < 1) cancel();
  };
  const observer = new ResizeObserver(restore);
  observer.observe(scroller);
  for (const child of scroller.children) observer.observe(child);
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    scroller.addEventListener(event, cancel, { passive: true });
  }
  restore();
  return cancel;
}
