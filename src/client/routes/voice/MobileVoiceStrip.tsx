import { Square, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVoiceStore } from "@/store/voice";
import { useGlobalAgentStore } from "@/store/global-agent";
import { displayGlobalAgentName } from "@shared/global-agent-name";
import { VoiceMicVisualizer } from "./VoiceMicVisualizer";
import { VOICE_STATE_LABEL } from "./voice-state-label";
import { cn } from "@/lib/utils";

function dotColor(state: string): string {
  switch (state) {
    case "listening":
    case "speaking":
      // speaking keeps green — the mic remains active during model output.
      return "bg-live";
    case "connecting":
    case "requesting-mic":
    case "reconnecting":
      return "bg-amber";
    case "error":
      return "bg-red";
    default:
      return "bg-muted-foreground";
  }
}

/** Phone only: a band under the top bar on every page but the agent's
 *  (whose bar, where the composer was, is voice's control) while voice is on —
 *  the "return to call" bar of chat apps. It sits at
 *  the top because the bottom belongs to the composer; the floating pill it
 *  replaced covered the send button. Voice is the global agent, so it names
 *  the agent and goes to its page. */
export function MobileVoiceStrip() {
  const isMobile = useIsMobile();
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const stopVoice = useVoiceStore((s) => s.stopVoice);
  const connectionState = useVoiceStore((s) => s.connectionState);
  const agent = useGlobalAgentStore((s) => s.agent);
  const stopNotice = useVoiceStore((s) => s.stopNotice);
  const dismiss = useVoiceStore((s) => s.dismissStopNotice);
  const pathname = useLocation().pathname;
  const navigate = useNavigate();
  // The agent's page has voice's bar where its composer was, and says why
  // voice stopped above it: one control, one notice.
  if (!isMobile || pathname === "/agent") return null;
  if (!voiceMode) {
    // Stopped by itself: why, where it stopped, until read.
    if (!stopNotice) return null;
    return (
      <div data-slot="voice-stopped-notice" role="status" className="flex h-10 shrink-0 items-center gap-2 border-b border-border-soft bg-panel pl-3.5 pr-2 text-xs text-muted-foreground pointer-coarse:h-[45px]">
        <span className="min-w-0 flex-1 truncate">{stopNotice}</span>
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={dismiss} className="shrink-0"><X className="size-3.5" /></Button>
      </div>
    );
  }
  const name = agent?.named ? displayGlobalAgentName(agent.name) : null;

  return (
    <div
      data-slot="voice-strip"
      // 45px on a touch screen (44 inside its border): the back button fills
      // it, and Stop's touch area, reaching 8px past it, stays clear of the
      // top bar above, which takes taps.
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border-soft bg-live/10 pr-2 text-xs pointer-coarse:h-[45px]"
    >
      <button
        type="button"
        data-slot="voice-strip-back"
        onClick={() => navigate("/agent")}
        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dotColor(connectionState))} />
        <span className="shrink-0 font-medium text-foreground">Voice on</span>
        {/* A flex container drops the space from layout; the name keeps it. */}
        {name && <>{" "}<span className="min-w-0 truncate text-muted-foreground">{name}</span></>}
        {/* What the dot's colour says, for a screen reader. */}
        {" "}<span className="sr-only">{VOICE_STATE_LABEL[connectionState] ?? "Voice"}</span>
      </button>
      <VoiceMicVisualizer className="w-24 shrink-0 gap-1.5 py-0" />
      <Button
        variant="default"
        size="icon"
        onClick={() => stopVoice()}
        aria-label="Stop voice"
        className="size-7 shrink-0 bg-destructive/80 hover:bg-destructive text-destructive-foreground"
      >
        <Square className="size-3.5" fill="currentColor" />
      </Button>
    </div>
  );
}
