import { useRef, useState } from "react";
import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVoiceStore } from "@/store/voice";
import { useAgentChatStore } from "@/store/agent-chat";
import { useUIStore, type PillPosition } from "@/store/ui";
import { VoiceMicVisualizer } from "./VoiceMicVisualizer";
import { computePillSnap } from "@/lib/voice-pill-snap";
import { cn } from "@/lib/utils";

const PILL_WIDTH = 180;
const PILL_HEIGHT = 48;
const EDGE_MARGIN = 16;
const DRAG_THRESHOLD_PX = 5;

interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "width:0",
    "height:0",
    "padding-top:env(safe-area-inset-top)",
    "padding-right:env(safe-area-inset-right)",
    "padding-bottom:env(safe-area-inset-bottom)",
    "padding-left:env(safe-area-inset-left)",
    "pointer-events:none",
    "visibility:hidden",
  ].join(";");
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const insets: SafeAreaInsets = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
  document.body.removeChild(el);
  return insets;
}

function dotColor(state: string): string {
  switch (state) {
    case "ready":
    case "listening":
    case "speaking":
      // speaking keeps green — the mic remains active during model output.
      return "bg-live";
    case "connecting":
    case "requesting-mic":
      return "bg-status-review";
    case "error":
      return "bg-status-input";
    default:
      return "bg-muted-foreground";
  }
}

export function MobileVoicePill() {
  const isMobile = useIsMobile();
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const setVoiceMode = useVoiceStore((s) => s.setVoiceMode);
  const connectionState = useVoiceStore((s) => s.connectionState);
  const drawerOpen = useAgentChatStore((s) => s.drawerOpen);
  const drawerScope = useAgentChatStore((s) => s.drawerScope);
  const openDrawer = useAgentChatStore((s) => s.openDrawer);
  const pillPosition = useUIStore((s) => s.pillPosition);
  const setPillPosition = useUIStore((s) => s.setPillPosition);

  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    isDragging: boolean;
    livePos: PillPosition | null;
    insets: SafeAreaInsets;
  } | null>(null);

  const [liveTopPx, setLiveTopPx] = useState<number | null>(null);
  const [liveSide, setLiveSide] = useState<"left" | "right" | null>(null);

  if (!isMobile || !voiceMode || drawerOpen) return null;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
      livePos: null,
      insets: readSafeAreaInsets(),
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragStateRef.current;
    if (!ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (!ds.isDragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      ds.isDragging = true;
    }
    const snap = computePillSnap({
      pointerX: e.clientX,
      pointerY: e.clientY,
      pillHeight: PILL_HEIGHT,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      safeAreaInsets: ds.insets,
      margin: EDGE_MARGIN,
    });
    ds.livePos = snap;
    setLiveSide(snap.side);
    setLiveTopPx(snap.topPx);
  };

  const handlePointerUp = () => {
    const ds = dragStateRef.current;
    dragStateRef.current = null;
    if (!ds) return;
    if (ds.isDragging && ds.livePos) {
      setPillPosition(ds.livePos);
    } else {
      if (drawerScope) openDrawer(drawerScope);
    }
    setLiveSide(null);
    setLiveTopPx(null);
  };

  const effectiveSide = liveSide ?? pillPosition.side;
  const effectiveTopPx = liveTopPx ?? pillPosition.topPx;
  const useDefault = effectiveTopPx < 0;

  const style: React.CSSProperties = useDefault
    ? {
        bottom: "max(env(safe-area-inset-bottom), 16px)",
        right: "max(env(safe-area-inset-right), 16px)",
      }
    : {
        top: `${effectiveTopPx}px`,
        ...(effectiveSide === "right"
          ? { right: `${EDGE_MARGIN}px` }
          : { left: `${EDGE_MARGIN}px` }),
      };

  return (
    <div
      className={cn(
        "fixed z-40 flex items-center gap-2",
        "bg-card border border-border-soft rounded-full shadow-md",
        "px-3 py-2 select-none cursor-grab",
        "touch-none"
      )}
      style={{ width: PILL_WIDTH, height: PILL_HEIGHT, ...style }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      aria-label="Voice mode active. Tap to expand chat. Drag to reposition."
      role="button"
    >
      <div className="flex-1 min-w-0">
        <VoiceMicVisualizer />
      </div>
      <span
        className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor(connectionState))}
        aria-label={`Connection: ${connectionState}`}
      />
      <Button
        variant="default"
        size="icon"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setVoiceMode(false);
        }}
        aria-label="Stop voice"
        className="h-8 w-8 shrink-0 bg-destructive/80 hover:bg-destructive text-destructive-foreground"
      >
        <Square className="h-4 w-4" fill="currentColor" />
      </Button>
    </div>
  );
}
