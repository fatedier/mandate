import { Maximize, Minimize } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";

/** The browser's own full screen, as an icon button: "Full screen" / "Exit
 *  full screen", following the real state. One toggle for the phone's drawer
 *  (beside its close) and the desktop layout's sidebar (beside Collapse, and
 *  on the collapsed rail): an icon beside the close, not a row of its own.
 *  Absent where the page may not ask; with `touchOnly`, absent for a
 *  mouse too (the browser and the desktop shell have their own full screen). */
export function FullscreenToggle({ size, touchOnly = false, onToggle, className }: {
  size: "icon-xs" | "icon-sm";
  touchOnly?: boolean;
  /** After the request, e.g. the drawer closing itself. */
  onToggle?: () => void;
  className?: string;
}) {
  const fullscreen = useFullscreen();
  const coarse = useMediaQuery("(pointer: coarse)");
  if (!fullscreen.supported || (touchOnly && !coarse)) return null;
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={fullscreen.active ? "Exit full screen" : "Full screen"}
      onClick={() => { fullscreen.toggle(); onToggle?.(); }}
      className={cn("text-chrome hover:text-foreground", className)}
    >
      {fullscreen.active ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
    </Button>
  );
}
