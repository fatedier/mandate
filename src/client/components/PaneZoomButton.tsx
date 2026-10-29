import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  zoomed: boolean;
  onClick: () => void;
  className?: string;
  /** Which pane it belongs to, for the shell's shortcuts and tests. */
  kind?: string;
}

/** A side pane's whole-row button: it folds the chat away, so the pane takes
 *  the row, and brings it back. It pairs with the pane's Hide panel beside
 *  it: each says which side folds away. */
export function PaneZoomButton({ zoomed, onClick, className, kind = "worker" }: Props) {
  const label = zoomed ? "Show chat" : "Hide chat";
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⇧Enter" : "Ctrl+Shift+Enter";
  const Icon = zoomed ? PanelLeftOpen : PanelLeftClose;
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
