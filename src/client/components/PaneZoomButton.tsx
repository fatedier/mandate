import { Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  zoomed: boolean;
  onClick: () => void;
  className?: string;
  /** Which pane it belongs to, for the shell's shortcuts and tests. */
  kind?: string;
}

/** A side pane's whole-row button: the pane takes the row (the chat folds
 *  away) and gives it back. Drawn and named as what it does to the pane;
 *  hiding the pane is the header's toggle. */
export function PaneZoomButton({ zoomed, onClick, className, kind = "worker" }: Props) {
  const label = zoomed ? "Restore panel" : "Maximize panel";
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⇧Enter" : "Ctrl+Shift+Enter";
  const Icon = zoomed ? Minimize2 : Maximize2;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn("text-chrome hover:text-foreground", className)}
      data-pane-zoom={kind}
      aria-label={label}
      aria-pressed={zoomed}
      aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter"
      title={`${label} · ${shortcut}`}
      onClick={onClick}
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </Button>
  );
}
