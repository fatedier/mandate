import { Loader2 } from "lucide-react";

interface WakePhaseIndicatorProps {
  phase: "thinking" | "running-tool" | "idle";
  toolName?: string;
}

export function WakePhaseIndicator({ phase, toolName }: WakePhaseIndicatorProps) {
  if (phase === "idle") return null;
  const text = phase === "thinking"
    ? "Agent is thinking…"
    : `Running ${toolName ?? "tool"}…`;
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-2xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>{text}</span>
    </div>
  );
}
