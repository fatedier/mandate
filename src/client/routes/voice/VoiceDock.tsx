import { Mic, MicOff, Square, X } from "lucide-react";
import { Link, useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import { useVoiceStore } from "@/store/voice";
import { VoiceMicVisualizer } from "./VoiceMicVisualizer";
import { VOICE_STATE_LABEL } from "./voice-state-label";
import { cn } from "@/lib/utils";

/** Desktop: while voice is on, a dock above Settings on every page but the
 *  agent's, which has voice's bar where its composer was: its state, the mic
 *  level, Mute, Stop; its label opens the agent's page. */
export function VoiceDock({ collapsed }: { collapsed: boolean }) {
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const state = useVoiceStore((s) => s.connectionState);
  const muted = useVoiceStore((s) => s.micMuted);
  const toggleMuted = useVoiceStore((s) => s.toggleMicMuted);
  const stopVoice = useVoiceStore((s) => s.stopVoice);
  const stopNotice = useVoiceStore((s) => s.stopNotice);
  const dismiss = useVoiceStore((s) => s.dismissStopNotice);
  // The agent's page has voice's bar, and says why voice stopped above it.
  if (useLocation().pathname === "/agent") return null;
  if (!voiceMode) {
    // Stopped by itself (a limit, the service gone): why, where it stopped,
    // until read.
    if (!stopNotice) return null;
    return collapsed ? (
      <button type="button" data-slot="voice-stopped-notice" title={stopNotice} aria-label={`${stopNotice} Dismiss`} onClick={dismiss}
        className="mx-auto flex size-9 items-center justify-center rounded-lg border border-border bg-panel text-muted-foreground">
        <MicOff className="size-4" />
      </button>
    ) : (
      <div data-slot="voice-stopped-notice" role="status" className="mx-1 mb-1 flex items-start gap-1.5 rounded-lg border border-border bg-panel px-2.5 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">{stopNotice}</span>
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={dismiss} className="-my-1 shrink-0"><X className="size-3.5" /></Button>
      </div>
    );
  }
  const label = VOICE_STATE_LABEL[state] ?? "Voice";
  const tone = state === "reconnecting"
    ? "border-amber/50 bg-amber/10"
    : state === "moved" ? "border-border bg-panel" : "border-status-review/40 bg-status-review/10";
  if (collapsed) {
    return (
      <Link to="/agent" data-slot="voice-dock" aria-label={`Voice on: ${label}`} className={cn("mx-auto flex size-9 items-center justify-center rounded-lg border", tone)}>
        <Mic className="size-4" />
      </Link>
    );
  }
  return (
    <div data-slot="voice-dock" className={cn("mx-1 mb-1 flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-xs", tone)}>
      <Link to="/agent" className="flex items-center gap-1.5">
        <span className="font-semibold text-foreground">Voice on</span>
        <span className="text-muted-foreground">· {label}</span>
      </Link>
      <div className="flex items-center gap-1.5">
        <VoiceMicVisualizer className="min-w-0 flex-1 py-0" />
        <Button size="xs" variant="outline" onClick={toggleMuted}>{muted ? "Unmute" : "Mute"}</Button>
        <Button size="xs" variant="outline" aria-label="Stop voice" onClick={() => stopVoice()}>
          <Square className="size-3" fill="currentColor" />
        </Button>
      </div>
    </div>
  );
}
