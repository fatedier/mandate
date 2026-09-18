import { isTauriRuntime } from "@/lib/runtime";
import { cn } from "@/lib/utils";
import { useDesktopFullscreen } from "@/shell/desktop-fullscreen";

/** Height of the desktop shell's title strip, the band the macOS traffic
 *  lights live in: 28px, the height of a standard macOS title bar. */
export const TITLEBAR_STRIP_HEIGHT = 28;

/** Where the lights' centre sits in the strip. Not the strip's centre (14):
 *  the user judged that too close to the top, so the lights sit 2px lower,
 *  leaving 6px under the 12px circles. `traffic_light_position` in
 *  src-tauri/src/lib.rs places them; its inset value is measured, not
 *  derived (see there). */
export const TRAFFIC_LIGHT_CENTRE_Y = 16;

/** The desktop shell's title strip: an empty, draggable band above each
 *  column of the window, where the traffic lights sit. Under it the sidebar
 *  and panes render exactly as in the browser (brand row, headers), so the
 *  lights never compete with the wordmark or the collapse toggle for the
 *  header band — an earlier layout put them in one row and the wordmark
 *  truncated at narrow sidebar widths. One strip per column rather than one
 *  across the window, so each carries its column's background (panel for the
 *  sidebar, page for the workspace). Renders nothing in the browser, and
 *  nothing in macOS fullscreen, where the system hides the lights and the
 *  window then reads exactly as the browser does. */
export function TitlebarStrip({ className }: { className?: string }) {
  const fullscreen = useDesktopFullscreen();
  if (!isTauriRuntime() || fullscreen) return null;
  return (
    <div
      aria-hidden
      data-slot="titlebar-strip"
      data-tauri-drag-region
      className={cn("h-[28px] w-full shrink-0", className)}
    />
  );
}
