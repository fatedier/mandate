import { cn } from "@/lib/utils";

export type SettingsStatusTone = "ready" | "attention" | "idle";

const TONE: Record<SettingsStatusTone, { dot: string; text: string }> = {
  // Signal grammar: green is live and fine, review-amber wants you, and an
  // unconfigured thing is furniture — it states a fact, it isn't asking.
  ready: { dot: "bg-live", text: "text-muted-foreground" },
  attention: { dot: "bg-status-review", text: "text-status-review" },
  idle: { dot: "bg-faint", text: "text-chrome" }
};

/** The one status readout shared by provider rows and the voice header. */
export function StatusChip({
  tone,
  label,
  className
}: {
  tone: SettingsStatusTone;
  label: string;
  className?: string;
}) {
  const style = TONE[tone];
  return (
    <span className={cn("flex items-center gap-1.5 text-xs", style.text, className)}>
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} />
      {label}
    </span>
  );
}
