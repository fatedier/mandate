import { Mic, MicOff } from "lucide-react";
import { useVoiceStore } from "@/store/voice";
import { cn } from "@/lib/utils";

export function VoiceMicVisualizer() {
  const micLevel = useVoiceStore((s) => s.micLevel);
  const micMuted = useVoiceStore((s) => s.micMuted);
  const toggleMicMuted = useVoiceStore((s) => s.toggleMicMuted);
  const state = useVoiceStore((s) => s.connectionState);

  const color = micMuted ? "text-status-review"
    : state === "error" ? "text-status-input"
    : state === "ready" || state === "listening" ? "text-live"
    : "text-muted-foreground";

  const bgColor = micMuted ? "bg-status-review"
    : state === "error" ? "bg-status-input"
    : state === "ready" || state === "listening" ? "bg-live"
    : "bg-muted-foreground";

  return (
    <div className="flex items-center gap-3 py-2">
      <button
        type="button"
        className={cn(
          "grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors",
          "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
        aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={micMuted}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          toggleMicMuted();
        }}
      >
        {micMuted ? (
          <MicOff className={cn("h-5 w-5", color)} aria-hidden />
        ) : (
          <Mic className={cn("h-5 w-5", color)} aria-hidden />
        )}
      </button>
      <div className="flex-1 h-2 rounded-full bg-muted/30 overflow-hidden">
        <div
          className={cn("h-full transition-[width] duration-75", bgColor)}
          style={{ width: `${Math.round((micMuted ? 0 : micLevel) * 100)}%` }}
        />
      </div>
    </div>
  );
}
