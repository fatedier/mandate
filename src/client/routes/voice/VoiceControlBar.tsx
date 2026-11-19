import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ViewState";
import { useVoiceStore } from "@/store/voice";
import { VoiceMicVisualizer } from "@/routes/voice/VoiceMicVisualizer";
import { VOICE_STATE_LABEL } from "./voice-state-label";

/** Voice in the agent's own page, where its composer was. */
export function VoiceControlBar() {
  const stopVoice = useVoiceStore((s) => s.stopVoice);
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
      {connectionState === "error" && (
        <InlineError detail={errorMessage} className="px-1">Voice stopped working.</InlineError>
      )}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <VoiceMicVisualizer />
        </div>
        <Button
          variant="default"
          size="icon"
          onClick={() => stopVoice()}
          aria-label="Stop voice"
          className="h-9 w-9 shrink-0 bg-destructive/80 hover:bg-destructive text-destructive-foreground"
        >
          <Square className="h-4 w-4" fill="currentColor" />
        </Button>
      </div>
      <div className="text-2xs text-muted-foreground text-center">
        {VOICE_STATE_LABEL[connectionState] ?? ""}
      </div>
    </div>
  );
}
