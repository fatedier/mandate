import { Loader2 } from "lucide-react";

interface CompressionPhaseIndicatorProps {
  active: boolean;
}

export function CompressionPhaseIndicator({ active }: CompressionPhaseIndicatorProps) {
  if (!active) return null;
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-2xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>Summarizing earlier context…</span>
    </div>
  );
}
