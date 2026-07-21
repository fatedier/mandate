import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVoiceStore } from "@/store/voice";
import { VoiceMicVisualizer } from "@/routes/voice/VoiceMicVisualizer";

export function VoiceControlBar() {
  const setVoiceMode = useVoiceStore((s) => s.setVoiceMode);
  const connectionState = useVoiceStore((s) => s.connectionState);
  const errorMessage = useVoiceStore((s) => s.errorMessage);

  return (
    <div
      className="flex flex-col gap-1 border-t border-border-soft bg-card pt-2"
      style={{
        paddingLeft: "max(env(safe-area-inset-left), 0.5rem)",
        paddingRight: "max(env(safe-area-inset-right), 0.5rem)",
        paddingBottom: "0.5rem"
      }}
    >
      {errorMessage && (
        <div className="text-2xs text-destructive px-1">{errorMessage}</div>
      )}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <VoiceMicVisualizer />
        </div>
        <Button
          variant="default"
          size="icon"
          onClick={() => setVoiceMode(false)}
          aria-label="Stop voice"
          className="h-9 w-9 shrink-0 bg-destructive/80 hover:bg-destructive text-destructive-foreground"
        >
          <Square className="h-4 w-4" fill="currentColor" />
        </Button>
      </div>
      <div className="text-2xs text-muted-foreground capitalize text-center">
        {connectionState}
      </div>
    </div>
  );
}
