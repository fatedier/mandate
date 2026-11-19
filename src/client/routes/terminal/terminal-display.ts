import type { TerminalDisplay } from "@/store/ui";

/** Display's choices, in the menu's words. */
export const TERMINAL_DISPLAY_COPY: Record<TerminalDisplay, { name: string; hint: string }> = {
  auto: { name: "Auto", hint: "Follows the screen used last." },
  screen: { name: "This screen", hint: "Always sized to this screen." },
  pane: { name: "Pane's size", hint: "Leaves tmux as it is. Scroll to see it all." },
  small: { name: "Pane's size, smaller", hint: "Leaves tmux as it is. Smaller text shows the whole width." }
};

/** The choices a device has: smaller text is a phone's (a desktop's window
 *  is wide enough). */
export function displayChoices(isMobile: boolean): TerminalDisplay[] {
  return isMobile ? ["auto", "screen", "pane", "small"] : ["auto", "screen", "pane"];
}

/** The Display a terminal uses on this device: a phone's choice of smaller
 *  text is the pane's size on a desktop. */
export function displayHere(display: TerminalDisplay, isMobile: boolean): TerminalDisplay {
  return !isMobile && display === "small" ? "pane" : display;
}
