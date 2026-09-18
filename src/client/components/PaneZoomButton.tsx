import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  pane: "worker" | "chat";
  zoomed: boolean;
  onClick: () => void;
  className?: string;
}

export function PaneZoomButton({ pane, zoomed, onClick, className }: Props) {
  const label = zoomed ? "Restore split view" : `Maximize ${pane}`;
  const shortcut = pane === "worker"
    ? (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⇧Enter" : "Ctrl+Shift+Enter")
    : zoomed ? "Esc" : null;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn("text-chrome hover:text-foreground", className)}
      data-pane-zoom={pane}
      aria-label={label}
      aria-pressed={zoomed}
      aria-keyshortcuts={pane === "worker" ? "Meta+Shift+Enter Control+Shift+Enter" : undefined}
      title={shortcut ? `${label} · ${shortcut}` : label}
      onClick={onClick}
    >
      <svg
        className="size-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={zoomed
          ? "M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5M3 3l5 5m13-5-5 5M3 21l5-5m13 5-5-5"
          : "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"}
        />
      </svg>
    </Button>
  );
}
