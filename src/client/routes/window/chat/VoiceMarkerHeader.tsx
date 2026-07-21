import { Mic } from "lucide-react";

interface VoiceMarkerHeaderProps {
  /** When true, append a pulsing dot indicating the message is still streaming. */
  ephemeral?: boolean;
}

/** Small "Voice" header used by user, agent, and ephemeral message
 *  bubbles to mark provenance. Same visual treatment everywhere. */
export function VoiceMarkerHeader({ ephemeral }: VoiceMarkerHeaderProps) {
  return (
    <div className="flex items-center gap-1 text-2xs text-muted-foreground">
      <Mic className="h-3 w-3" />
      <span>Voice</span>
      {ephemeral && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-live animate-pulse" />}
    </div>
  );
}
